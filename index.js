require('dotenv').config();
const express = require('express');
const path    = require('path');
const { Pool } = require('pg');
const bcrypt  = require('bcryptjs');

const app  = express();
const port = process.env.PORT || 8080;

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
//  DATABASE CONNECTION
// ─────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.replace(/[?&]sslmode=\w+/g, '')
  : undefined;

const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

pool.query('SELECT NOW()')
  .then(r  => console.log('✅ PostgreSQL connected at', r.rows[0].now))
  .catch(e => console.error('❌ PostgreSQL connection FAILED:', e.message));

// ─────────────────────────────────────────────
//  SYSTEM SETUP & MIGRATIONS (Auto-updates Schema)
// ─────────────────────────────────────────────
app.get('/setup-db', async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.secret !== process.env.SETUP_SECRET) {
    return res.status(403).send('Forbidden – provide ?secret=YOUR_SETUP_SECRET');
  }
  try {
    // 1. Users Table (Updated with Name column)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        email VARCHAR(100) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role VARCHAR(20) DEFAULT 'user', 
        client_id INTEGER,
        must_change_password BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Run Migrations (Adds columns if they were missing from earlier versions)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user'`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS client_id INTEGER`);

    // 2. Clients Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Posts Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        caption TEXT,
        platforms TEXT[],
        post_date DATE NOT NULL,
        post_time TIME,
        status VARCHAR(20) DEFAULT 'draft',
        is_approved BOOLEAN DEFAULT FALSE,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE`);

    // 4. Tasks Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        assigned_to INTEGER REFERENCES users(id),
        title TEXT NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'todo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed Admin if needed
    const { rows } = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) === 0) {
      const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@meuglobal.com';
      const adminPass  = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
      const hashed     = await bcrypt.hash(adminPass, 12);
      await pool.query(
        `INSERT INTO users (name, email, password, role, must_change_password) VALUES ('System Admin', $1, $2, 'admin', TRUE)`,
        [adminEmail, hashed]
      );
    }

    res.send('<pre>✅ Database is synchronized. Users now have "Name" characteristic.</pre>');
  } catch (err) {
    console.error('Setup error:', err);
    res.status(500).send('<pre>❌ Setup failed:\n' + err.message + '</pre>');
  }
});

// ─────────────────────────────────────────────
//  AUTH API
// ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
    
    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials.' });

    res.json({ 
        success: true, 
        userId: user.id, 
        name: user.name,
        role: user.role, 
        client_id: user.client_id, 
        email: user.email,
        mustChange: user.must_change_password 
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new user (Used by Admins)
app.post('/api/admin/add-user', async (req, res) => {
    const { name, email, password, role, client_id } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, Email, and Password are required.' });
    
    try {
        const hashed = await bcrypt.hash(password, 12);
        await pool.query(
            `INSERT INTO users (name, email, password, role, client_id, must_change_password) VALUES ($1, $2, $3, $4, $5, TRUE)`,
            [name, email.toLowerCase().trim(), hashed, role, client_id || null]
        );
        res.status(201).json({ success: true });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'User email already exists.' });
        res.status(500).json({ error: err.message });
    }
});

// Get assignable users (Admins and Creators) for Tasks
app.get('/api/users/assignable', async (req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT id, name, email, role FROM users WHERE role IN ('user', 'admin') ORDER BY name ASC"
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
//  CLIENTS API
// ─────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM clients ORDER BY name ASC');
    res.json(rows);
});

app.post('/api/clients', async (req, res) => {
    const { name, email } = req.body;
    const { rows } = await pool.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING *', [name, email]);
    res.json(rows[0]);
});

// ─────────────────────────────────────────────
//  POSTS API
// ─────────────────────────────────────────────
app.get('/api/posts', async (req, res) => {
    const { month, year, client_id, role } = req.query;
    let query = `SELECT p.*, c.name as client_name FROM posts p LEFT JOIN clients c ON p.client_id = c.id WHERE 1=1`;
    const params = [];

    if (month && year) {
        params.push(year, month);
        query += ` AND EXTRACT(YEAR FROM p.post_date) = $${params.length - 1} AND EXTRACT(MONTH FROM p.post_date) = $${params.length}`;
    }

    if (client_id && client_id !== 'null') {
        params.push(client_id);
        query += ` AND p.client_id = $${params.length}`;
    }

    query += ' ORDER BY p.post_date ASC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
});

app.post('/api/posts', async (req, res) => {
    const { client_id, title, caption, platforms, post_date, post_time, status, created_by } = req.body;
    const { rows } = await pool.query(
        `INSERT INTO posts (client_id, title, caption, platforms, post_date, post_time, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [client_id || null, title, caption, platforms, post_date, post_time || null, status, created_by]
    );
    res.json(rows[0]);
});

// ─────────────────────────────────────────────
//  TASKS API
// ─────────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
    const { role, client_id, user_id } = req.query;
    let query = `SELECT t.*, u.name as assignee_name, c.name as client_name 
                 FROM tasks t 
                 LEFT JOIN users u ON t.assigned_to = u.id 
                 LEFT JOIN clients c ON t.client_id = c.id
                 WHERE 1=1`;
    const params = [];

    if (role === 'client_owner' && client_id) {
        params.push(client_id);
        query += ` AND t.client_id = $${params.length}`;
    } else if (role === 'user') {
        params.push(user_id);
        query += ` AND t.assigned_to = $${params.length}`;
    }

    const { rows } = await pool.query(query, params);
    res.json(rows);
});

app.post('/api/tasks', async (req, res) => {
    const { client_id, assigned_to, title, description } = req.body;
    const { rows } = await pool.query(
        `INSERT INTO tasks (client_id, assigned_to, title, description) VALUES ($1, $2, $3, $4) RETURNING *`,
        [client_id, assigned_to, title, description]
    );
    res.json(rows[0]);
});

app.put('/api/tasks/:id/status', async (req, res) => {
    const { status } = req.body;
    await pool.query('UPDATE tasks SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ success: true });
});

// ─────────────────────────────────────────────
//  FRONTEND & SERVER
// ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`🚀 MEU Global CRM Engine running on port ${port}`);
});
