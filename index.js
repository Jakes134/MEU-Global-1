require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.PORT || 8080;

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbUrl = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.replace(/[?&]sslmode=\w+/g, '')
  : undefined;

const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

pool.query('SELECT NOW()')
  .then(function(r) { console.log('DB connected:', r.rows[0].now); })
  .catch(function(e) { console.error('DB failed:', e.message); });

// ─── HEALTH CHECK ────────────────────────────
app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '2.1' });
});

// ─── DATABASE MIGRATIONS ──────────────────────
app.get('/fix-db', async function(req, res) {
  if (!process.env.SETUP_SECRET || req.query.secret !== process.env.SETUP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100)');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT \'user\'');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS client_id INTEGER');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT TRUE');
    await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE');
    await pool.query('ALTER TABLE posts ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT \'pending\'');
    await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by INTEGER');
    await pool.query('CREATE TABLE IF NOT EXISTS task_comments (id SERIAL PRIMARY KEY, task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id), comment TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    res.send('OK: all columns patched');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.get('/setup-db', async function(req, res) {
  if (!process.env.SETUP_SECRET || req.query.secret !== process.env.SETUP_SECRET) {
    return res.status(403).send('Forbidden');
  }
  try {
    // 1. Create Core Tables
    await pool.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE NOT NULL, password TEXT NOT NULL, role VARCHAR(20) DEFAULT \'user\', client_id INTEGER, must_change_password BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pool.query('CREATE TABLE IF NOT EXISTS clients (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(100) UNIQUE NOT NULL, status VARCHAR(20) DEFAULT \'Active\', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pool.query('CREATE TABLE IF NOT EXISTS posts (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, title TEXT NOT NULL, caption TEXT, platforms TEXT[], post_date DATE NOT NULL, post_time TIME, status VARCHAR(20) DEFAULT \'draft\', is_approved BOOLEAN DEFAULT FALSE, approval_status VARCHAR(20) DEFAULT \'pending\', created_by INTEGER REFERENCES users(id), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pool.query('CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, assigned_to INTEGER REFERENCES users(id), created_by INTEGER REFERENCES users(id), title TEXT NOT NULL, description TEXT, status VARCHAR(20) DEFAULT \'todo\', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pool.query('CREATE TABLE IF NOT EXISTS task_comments (id SERIAL PRIMARY KEY, task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id), comment TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');

    // 2. Seed Admin User
    var count = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(count.rows[0].count) === 0) {
      var adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@meuglobal.com';
      var adminPass = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
      var hashed = await bcrypt.hash(adminPass, 12);
      await pool.query('INSERT INTO users (name, email, password, role, must_change_password) VALUES ($1, $2, $3, $4, TRUE)', ['System Admin', adminEmail, hashed, 'admin']);
    }
    res.send('OK: database ready');
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ─── AUTHENTICATION ──────────────────────────
app.post('/api/login', async function(req, res) {
  var email = req.body.email;
  var password = req.body.password; // Trimming happens here and on frontend
  
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  
  try {
    var cleanEmail = email.toLowerCase().trim();
    var cleanPass = password.trim();

    var result = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
    
    var user = result.rows[0];
    var isMatch = await bcrypt.compare(cleanPass, user.password);
    
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials.' });
    
    res.json({ success: true, userId: user.id, name: user.name, role: user.role, client_id: user.client_id, email: user.email, mustChange: user.must_change_password });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/change-password', async function(req, res) {
  var userId = req.body.userId;
  var newPassword = req.body.newPassword;
  if (!userId || !newPassword) return res.status(400).json({ error: 'Missing fields.' });
  try {
    var hashed = await bcrypt.hash(newPassword.trim(), 12);
    await pool.query('UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2', [hashed, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── USER ADMIN ──────────────────────────────
app.post('/api/admin/add-user', async function(req, res) {
  var name = req.body.name;
  var email = req.body.email;
  var role = req.body.role;
  var client_id = req.body.client_id;
  var password = req.body.password;

  if (!name || !email) return res.status(400).json({ error: 'Name and Email are required.' });

  try {
    // Ensure the password is trimmed before hashing to prevent login mismatches
    var rawPassword = (password && password.trim()) ? password.trim() : 'ChangeMe123!';
    var hashed = await bcrypt.hash(rawPassword, 12);
    
    var result = await pool.query(
      'INSERT INTO users (name, email, password, role, client_id, must_change_password) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, name, email, role', 
      [name.trim(), email.toLowerCase().trim(), hashed, role || 'user', client_id || null]
    );
    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with this email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', async function(req, res) {
  try {
    var result = await pool.query('SELECT u.id, u.name, u.email, u.role, u.client_id, c.name as client_name, u.created_at FROM users u LEFT JOIN clients c ON u.client_id = c.id ORDER BY u.created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', async function(req, res) {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CLIENTS ─────────────────────────────────
app.get('/api/clients', async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM clients ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients', async function(req, res) {
  try {
    var result = await pool.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING *', [req.body.name, req.body.email]);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Client email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

// ─── POSTS ───────────────────────────────────
app.get('/api/posts', async function(req, res) {
  var month = req.query.month;
  var year = req.query.year;
  var client_id = req.query.client_id;
  var query = 'SELECT p.*, c.name as client_name, u.name as creator_name FROM posts p LEFT JOIN clients c ON p.client_id = c.id LEFT JOIN users u ON p.created_by = u.id WHERE 1=1';
  var params = [];
  if (month && year) {
    params.push(year, month);
    query += ' AND EXTRACT(YEAR FROM p.post_date) = $' + (params.length - 1) + ' AND EXTRACT(MONTH FROM p.post_date) = $' + params.length;
  }
  if (client_id && client_id !== 'null' && client_id !== '') {
    params.push(client_id);
    query += ' AND p.client_id = $' + params.length;
  }
  query += ' ORDER BY p.post_date ASC, p.post_time ASC';
  try {
    var result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts', async function(req, res) {
  var b = req.body;
  if (!b.title || !b.post_date) return res.status(400).json({ error: 'Title and post date are required.' });
  try {
    var result = await pool.query("INSERT INTO posts (client_id, title, caption, platforms, post_date, post_time, status, approval_status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) RETURNING *", [b.client_id || null, b.title, b.caption, b.platforms, b.post_date, b.post_time || null, b.status || 'draft', b.created_by]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/posts/:id/approve', async function(req, res) {
  var approved = req.body.approved;
  var approvalStatus = approved ? 'approved' : 'rejected';
  try {
    var result = await pool.query('UPDATE posts SET is_approved=$1, approval_status=$2 WHERE id=$3 RETURNING *', [approved, approvalStatus, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts/pending-approval', async function(req, res) {
  var client_id = req.query.client_id;
  try {
    var query = "SELECT p.*, c.name as client_name, u.name as creator_name FROM posts p LEFT JOIN clients c ON p.client_id = c.id LEFT JOIN users u ON p.created_by = u.id WHERE p.approval_status = 'pending'";
    var params = [];
    if (client_id) { params.push(client_id); query += ' AND p.client_id = $1'; }
    query += ' ORDER BY p.created_at DESC';
    var result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── TASKS ───────────────────────────────────
app.get('/api/tasks', async function(req, res) {
  var role = req.query.role;
  var client_id = req.query.client_id;
  var user_id = req.query.user_id;
  var query = 'SELECT t.*, u.name as assignee_name, c.name as client_name, cb.name as creator_name FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id LEFT JOIN clients c ON t.client_id = c.id LEFT JOIN users cb ON t.created_by = cb.id WHERE 1=1';
  var params = [];
  if (role === 'client_owner' && client_id) {
    params.push(client_id);
    query += ' AND t.client_id = $' + params.length;
  } else if (role === 'user' && user_id) {
    params.push(user_id);
    query += ' AND t.assigned_to = $' + params.length;
  }
  query += ' ORDER BY t.created_at DESC';
  try {
    var result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async function(req, res) {
  var b = req.body;
  try {
    var result = await pool.query('INSERT INTO tasks (client_id, assigned_to, title, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [b.client_id || null, b.assigned_to || null, b.title, b.description || '', b.created_by || null]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id/status', async function(req, res) {
  try {
    await pool.query('UPDATE tasks SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id/comments', async function(req, res) {
  try {
    var result = await pool.query('SELECT tc.*, u.name as author_name, u.role as author_role FROM task_comments tc LEFT JOIN users u ON tc.user_id = u.id WHERE tc.task_id = $1 ORDER BY tc.created_at ASC', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/comments', async function(req, res) {
  try {
    var result = await pool.query('INSERT INTO task_comments (task_id, user_id, comment) VALUES ($1, $2, $3) RETURNING *', [req.params.id, req.body.user_id, req.body.comment]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/assignable', async function(req, res) {
  try {
    var result = await pool.query("SELECT id, name, email, role FROM users ORDER BY name ASC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SPA ROUTING ─────────────────────────────
app.get('*', function(req, res) {
  // If your index.html is inside public, use this:
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, function() {
  console.log('MEU Global CRM running on port ' + port);
});
