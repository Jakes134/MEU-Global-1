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

app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.5' }));

// ─── DATABASE SETUP ───
app.get('/setup-db', async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.secret !== process.env.SETUP_SECRET) return res.status(403).send('Forbidden');
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE NOT NULL, password TEXT NOT NULL, role VARCHAR(20) DEFAULT \'user\', client_id INTEGER, must_change_password BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pool.query('CREATE TABLE IF NOT EXISTS clients (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(100) UNIQUE NOT NULL, status VARCHAR(20) DEFAULT \'Active\', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pool.query('CREATE TABLE IF NOT EXISTS posts (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, title TEXT NOT NULL, caption TEXT, platforms TEXT[], post_date DATE NOT NULL, post_time TIME, status VARCHAR(20) DEFAULT \'draft\', is_approved BOOLEAN DEFAULT FALSE, approval_status VARCHAR(20) DEFAULT \'pending\', created_by INTEGER REFERENCES users(id), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pool.query('CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, assigned_to INTEGER REFERENCES users(id), created_by INTEGER REFERENCES users(id), title TEXT NOT NULL, description TEXT, status VARCHAR(20) DEFAULT \'todo\', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pool.query('CREATE TABLE IF NOT EXISTS task_comments (id SERIAL PRIMARY KEY, task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id), comment TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    
    // Seed Admin
    const count = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(count.rows[0].count) === 0) {
      const hashed = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!', 12);
      await pool.query('INSERT INTO users (name, email, password, role, must_change_password) VALUES ($1, $2, $3, $4, TRUE)', ['System Admin', process.env.SEED_ADMIN_EMAIL || 'admin@meuglobal.com', hashed, 'admin']);
    }
    res.send('OK: database ready');
  } catch (err) { res.status(500).send(err.message); }
});

// ─── AUTH ───
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password.trim(), user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ success: true, userId: user.id, name: user.name, role: user.role, client_id: user.client_id, email: user.email, mustChange: user.must_change_password });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/change-password', async (req, res) => {
  const { userId, newPassword } = req.body;
  try {
    const hashed = await bcrypt.hash(newPassword.trim(), 12);
    await pool.query('UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2', [hashed, userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ADMIN & USERS ───
app.post('/api/admin/add-user', async (req, res) => {
  const { name, email, role, client_id, password } = req.body;
  try {
    const rawPass = password ? password.trim() : 'ChangeMe123!';
    const hashed = await bcrypt.hash(rawPass, 12);
    const result = await pool.query('INSERT INTO users (name, email, password, role, client_id, must_change_password) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, name, email, role', [name.trim(), email.toLowerCase().trim(), hashed, role, client_id || null]);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users', async (req, res) => {
  const r = await pool.query('SELECT u.*, c.name as client_name FROM users u LEFT JOIN clients c ON u.client_id = c.id ORDER BY u.created_at DESC');
  res.json(r.rows);
});

app.delete('/api/admin/users/:id', async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/users/assignable', async (req, res) => {
  const r = await pool.query("SELECT id, name, email, role FROM users ORDER BY name ASC");
  res.json(r.rows);
});

// ─── CLIENTS ───
app.get('/api/clients', async (req, res) => {
  const r = await pool.query('SELECT * FROM clients ORDER BY name ASC');
  res.json(r.rows);
});

app.post('/api/clients', async (req, res) => {
  const r = await pool.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING *', [req.body.name, req.body.email]);
  res.json(r.rows[0]);
});

// ─── POSTS ───
app.get('/api/posts', async (req, res) => {
  const { month, year, client_id } = req.query;
  let q = 'SELECT p.*, c.name as client_name, u.name as creator_name FROM posts p LEFT JOIN clients c ON p.client_id = c.id LEFT JOIN users u ON p.created_by = u.id WHERE 1=1';
  let params = [];
  if (month && year) { params.push(year, month); q += ` AND EXTRACT(YEAR FROM p.post_date) = $1 AND EXTRACT(MONTH FROM p.post_date) = $2`; }
  if (client_id) { params.push(client_id); q += ` AND p.client_id = $${params.length}`; }
  const r = await pool.query(q + ' ORDER BY p.post_date ASC', params);
  res.json(r.rows);
});

app.post('/api/posts', async (req, res) => {
  const b = req.body;
  const r = await pool.query("INSERT INTO posts (client_id, title, caption, platforms, post_date, post_time, status, approval_status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) RETURNING *", [b.client_id || null, b.title, b.caption, b.platforms, b.post_date, b.post_time, b.status, b.created_by]);
  res.json(r.rows[0]);
});

app.put('/api/posts/:id/approve', async (req, res) => {
  const status = req.body.approved ? 'approved' : 'rejected';
  const r = await pool.query('UPDATE posts SET is_approved=$1, approval_status=$2 WHERE id=$3 RETURNING *', [req.body.approved, status, req.params.id]);
  res.json(r.rows[0]);
});

app.get('/api/posts/pending-approval', async (req, res) => {
  const cid = req.query.client_id;
  let q = "SELECT p.*, c.name as client_name FROM posts p JOIN clients c ON p.client_id = c.id WHERE p.approval_status = 'pending'";
  if (cid) { const r = await pool.query(q + " AND p.client_id = $1", [cid]); return res.json(r.rows); }
  const r = await pool.query(q); res.json(r.rows);
});

// ─── TASKS ───
app.get('/api/tasks', async (req, res) => {
  const { role, client_id, user_id } = req.query;
  let q = 'SELECT t.*, u.name as assignee_name, c.name as client_name FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id LEFT JOIN clients c ON t.client_id = c.id WHERE 1=1';
  if (role === 'client_owner') q += ` AND t.client_id = ${client_id}`;
  else if (role === 'user') q += ` AND t.assigned_to = ${user_id}`;
  const r = await pool.query(q + ' ORDER BY t.created_at DESC');
  res.json(r.rows);
});

app.post('/api/tasks', async (req, res) => {
  const b = req.body;
  const r = await pool.query('INSERT INTO tasks (client_id, assigned_to, title, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *', [b.client_id, b.assigned_to, b.title, b.description, b.created_by]);
  res.json(r.rows[0]);
});

app.put('/api/tasks/:id/status', async (req, res) => {
  await pool.query('UPDATE tasks SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
  res.json({ success: true });
});

app.get('/api/tasks/:id/comments', async (req, res) => {
  const r = await pool.query('SELECT tc.*, u.name as author_name, u.role as author_role FROM task_comments tc JOIN users u ON tc.user_id = u.id WHERE tc.task_id = $1 ORDER BY tc.created_at ASC', [req.params.id]);
  res.json(r.rows);
});

app.post('/api/tasks/:id/comments', async (req, res) => {
  const r = await pool.query('INSERT INTO task_comments (task_id, user_id, comment) VALUES ($1, $2, $3) RETURNING *', [req.params.id, req.body.user_id, req.body.comment]);
  res.json(r.rows[0]);
});

// ─── SERVE FRONTEND ───
app.get('*', (req, res) => {
  // Use path.join(__dirname, 'index.html') if the file is NOT in a 'public' folder
  res.sendFile(path.join(__dirname,'index.html'));
});

app.listen(port, () => console.log('CRM active on ' + port));
