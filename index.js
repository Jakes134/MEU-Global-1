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
//  DATABASE
// ─────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL environment variable is not set.');
}

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
//  DIAGNOSTICS
// ─────────────────────────────────────────────
app.get('/healthz', async (req, res) => {
  const rawUrl = process.env.DATABASE_URL;
  let dbStatus = 'not connected', dbError = null, userCount = null;
  try {
    await pool.query('SELECT NOW()');
    dbStatus = 'connected';
  } catch (e) { dbError = e.message; }

  if (dbStatus === 'connected') {
    try {
      const r = await pool.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'users') AS exists`);
      if (r.rows[0].exists) {
        const c = await pool.query('SELECT COUNT(*) FROM users');
        userCount = parseInt(c.rows[0].count);
      } else {
        dbError = 'users table does not exist — run /setup-db first';
      }
    } catch (e) { dbError = e.message; }
  }

  res.json({
    status: 'running', timestamp: new Date().toISOString(),
    env: {
      DATABASE_URL:        rawUrl ? 'set ✅ → ' + (rawUrl.split('@')[1] || 'masked') : 'NOT SET ❌',
      SETUP_SECRET:        process.env.SETUP_SECRET        ? 'set ✅' : 'not set',
      SEED_ADMIN_EMAIL:    process.env.SEED_ADMIN_EMAIL    || 'not set',
      SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD ? '*** (set ✅)' : 'not set',
      NODE_ENV:            process.env.NODE_ENV            || 'not set',
      PORT:                process.env.PORT                || '8080 (default)',
    },
    database: { status: dbStatus, error: dbError, userCount }
  });
});


// ─────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────
app.get('/setup-db', async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.secret !== process.env.SETUP_SECRET) {
    return res.status(403).send('Forbidden – provide ?secret=YOUR_SETUP_SECRET');
  }
  try {
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        email      VARCHAR(100) UNIQUE NOT NULL,
        status     VARCHAR(20) DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
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

    const { rows } = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) === 0) {
      const adminEmail    = process.env.SEED_ADMIN_EMAIL    || 'admin@meuglobal.com';
      const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
      const hashed        = await bcrypt.hash(adminPassword, 12);
      await pool.query(
        `INSERT INTO users (email, password, must_change_password, role) VALUES ($1, $2, TRUE, 'admin')`,
        [adminEmail, hashed]
      );
      return res.send(`<pre>✅ Tables created.\n🔑 Admin: ${adminEmail}\n🔒 Pass: ${adminPassword}\n⚠️  Change on first login.</pre>`);
    }
    res.send('<pre>✅ Tables already exist.</pre>');
  } catch (err) {
    console.error('setup-db error:', err);
    res.status(500).send('<pre>❌ Setup failed:\n' + err.message + '</pre>');
  }
});


// ─────────────────────────────────────────────
//  AUTH
// ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  console.log('[login] attempt:', req.body?.email);
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials.' });
    console.log('[login] success:', email);
    res.json({ success: true, mustChange: user.must_change_password, userId: user.id, role: user.role, email: user.email });
  } catch (err) {
    console.error('[login] DB error:', err.message, '\n', err.stack);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

app.post('/api/update-password', async (req, res) => {
  const { userId, newPassword } = req.body;
  if (!userId || !newPassword || newPassword.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE id = $1 AND must_change_password = TRUE', [userId]);
    if (rows.length === 0) return res.status(403).json({ error: 'Password change not permitted.' });
    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2', [hashed, userId]);
    res.json({ success: true });
  } catch (err) {
    console.error('[update-password] error:', err.message);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

app.post('/api/admin/add-user', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6)
    return res.status(400).json({ error: 'Email and password (min 6 chars) required.' });
  try {
    const hashed = await bcrypt.hash(password, 12);
    await pool.query(`INSERT INTO users (email, password, must_change_password) VALUES ($1, $2, TRUE)`, [email.toLowerCase().trim(), hashed]);
    res.status(201).json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'User already exists.' });
    console.error('[add-user] error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});


// ─────────────────────────────────────────────
//  CLIENTS
// ─────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM clients');
    res.json({ client_count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('[stats] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

app.get('/api/clients', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clients ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error('[clients] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch clients.' });
  }
});

app.post('/api/clients', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING *',
      [name, email.toLowerCase().trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Client email already exists.' });
    console.error('[add-client] error:', err.message);
    res.status(400).json({ error: 'Failed to register client.' });
  }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[delete-client] error:', err.message);
    res.status(500).json({ error: 'Failed to delete client.' });
  }
});


// ─────────────────────────────────────────────
//  POSTS / CALENDAR
// ─────────────────────────────────────────────
app.get('/api/posts', async (req, res) => {
  const { client_id, month, year } = req.query;
  try {
    let query = `
      SELECT p.*, c.name as client_name
      FROM posts p
      LEFT JOIN clients c ON p.client_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (client_id) { params.push(client_id); query += ` AND p.client_id = $${params.length}`; }
    if (month && year) {
      params.push(year, month);
      query += ` AND EXTRACT(YEAR FROM p.post_date) = $${params.length - 1} AND EXTRACT(MONTH FROM p.post_date) = $${params.length}`;
    }
    query += ' ORDER BY p.post_date ASC, p.post_time ASC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('[posts] fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch posts.' });
  }
});

app.post('/api/posts', async (req, res) => {
  const { client_id, title, caption, platforms, post_date, post_time, status, created_by } = req.body;
  if (!title || !post_date) return res.status(400).json({ error: 'Title and date are required.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO posts (client_id, title, caption, platforms, post_date, post_time, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [client_id || null, title, caption || '', platforms || [], post_date, post_time || null, status || 'draft', created_by || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[add-post] error:', err.message);
    res.status(500).json({ error: 'Failed to create post.' });
  }
});

app.put('/api/posts/:id', async (req, res) => {
  const { title, caption, platforms, post_date, post_time, status, client_id } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE posts SET title=$1, caption=$2, platforms=$3, post_date=$4, post_time=$5, status=$6, client_id=$7
       WHERE id=$8 RETURNING *`,
      [title, caption, platforms, post_date, post_time || null, status, client_id || null, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[update-post] error:', err.message);
    res.status(500).json({ error: 'Failed to update post.' });
  }
});

app.delete('/api/posts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[delete-post] error:', err.message);
    res.status(500).json({ error: 'Failed to delete post.' });
  }
});


// ─────────────────────────────────────────────
//  FRONTEND
// ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`
  🚀  MEU Global CRM Engine
  ─────────────────────────
  Port:   ${port}
  Env:    ${process.env.NODE_ENV || 'development'}
  DB URL: ${process.env.DATABASE_URL ? 'set ✅' : 'NOT SET ❌'}
  `);
});
