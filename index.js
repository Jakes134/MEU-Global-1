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
//  DIAGNOSTICS / HEALTH
// ─────────────────────────────────────────────
app.get('/healthz', async (req, res) => {
  let dbStatus = 'not connected', dbError = null, userCount = null, postTableExists = false;
  try {
    const r = await pool.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'posts') AS exists`);
    postTableExists = r.rows[0].exists;
    const c = await pool.query('SELECT COUNT(*) FROM users');
    userCount = parseInt(c.rows[0].count);
    dbStatus = 'connected';
  } catch (e) { dbError = e.message; }

  res.json({
    status: 'running',
    database: { status: dbStatus, error: dbError, userCount, postTableExists }
  });
});

// ─────────────────────────────────────────────
//  FORCE SETUP ROUTE
// ─────────────────────────────────────────────
app.get('/setup-db', async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.secret !== process.env.SETUP_SECRET) {
    return res.status(403).send('Forbidden – provide ?secret=YOUR_SETUP_SECRET');
  }
  
  try {
    // 1. Users Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                   SERIAL PRIMARY KEY,
        email                VARCHAR(100) UNIQUE NOT NULL,
        password             TEXT NOT NULL,
        must_change_password BOOLEAN DEFAULT TRUE,
        role                 VARCHAR(20) DEFAULT 'member',
        created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Clients Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        email      VARCHAR(100) UNIQUE NOT NULL,
        status     VARCHAR(20) DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Posts Table (The critical one failing)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS posts (
        id          SERIAL PRIMARY KEY,
        client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        caption     TEXT,
        platforms   TEXT[],
        post_date   DATE NOT NULL,
        post_time   TIME,
        status      VARCHAR(20) DEFAULT 'draft',
        created_by  INTEGER REFERENCES users(id),
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed Admin if Users is empty
    const { rows } = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) === 0) {
      const adminEmail    = process.env.SEED_ADMIN_EMAIL    || 'admin@meuglobal.com';
      const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
      const hashed        = await bcrypt.hash(adminPassword, 12);
      await pool.query(
        `INSERT INTO users (email, password, must_change_password, role) VALUES ($1, $2, TRUE, 'admin')`,
        [adminEmail, hashed]
      );
    }

    res.send('<pre>✅ FORCE SETUP COMPLETE. All tables (Users, Clients, Posts) are now ready.</pre>');
  } catch (err) {
    console.error('Setup error:', err);
    res.status(500).send('<pre>❌ Setup failed:\n' + err.message + '</pre>');
  }
});

// ─────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email/Pass required' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
    const isMatch = await bcrypt.compare(password, rows[0].password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials.' });
    res.json({ success: true, userId: rows[0].id, role: rows[0].role });
  } catch (err) { res.status(500).json({ error: 'Login error' }); }
});

// ─────────────────────────────────────────────
//  CLIENT ROUTES
// ─────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clients ORDER BY name ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Client fetch failed' }); }
});

app.post('/api/clients', async (req, res) => {
  const { name, email } = req.body;
  try {
    const { rows } = await pool.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING *', [name, email]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Client add failed' }); }
});

// ─────────────────────────────────────────────
//  POSTS ROUTES (Enhanced Error Handling)
// ─────────────────────────────────────────────
app.get('/api/posts', async (req, res) => {
  const { month, year } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM posts WHERE EXTRACT(MONTH FROM post_date) = $1 AND EXTRACT(YEAR FROM post_date) = $2 ORDER BY post_date ASC`,
      [month, year]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Post fetch failed: ' + err.message }); }
});

app.post('/api/posts', async (req, res) => {
  const { client_id, title, caption, platforms, post_date, post_time, status, created_by } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO posts (client_id, title, caption, platforms, post_date, post_time, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [client_id, title, caption, platforms, post_date, post_time, status, created_by]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[DB POST ERROR]:', err);
    res.status(500).json({ error: 'Database Error: ' + err.message, detail: err.detail });
  }
});

app.delete('/api/posts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => console.log(`🚀 MEU Global Backend Live on ${port}`));
