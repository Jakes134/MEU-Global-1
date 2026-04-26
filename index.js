require('dotenv').config();
const express = require('express');
const path    = require('path');
const { Pool } = require('pg');
const bcrypt  = require('bcryptjs');

const app  = express();
const port = process.env.PORT || 8080;

// ── Trust DigitalOcean's proxy so express sees the real client IP ──
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// ─────────────────────────────────────────────
//  DATABASE – DigitalOcean managed PostgreSQL
//  Set DATABASE_URL in your DO App env vars.
//  The connection string from DO already contains
//  ?sslmode=require so we just honour it.
// ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }   // DO uses self-signed certs on private network
    : false
});

// Quick connectivity check on startup
pool.query('SELECT NOW()')
  .then(() => console.log('✅  PostgreSQL connected'))
  .catch(err => console.error('❌  PostgreSQL connection failed:', err.message));


// ─────────────────────────────────────────────
//  /setup-db  – run ONCE after first deploy
//  Creates tables + a seed admin if no users exist
// ─────────────────────────────────────────────
app.get('/setup-db', async (req, res) => {
  // Protect with a setup secret so random visitors can't call this
  const secret = req.query.secret;
  if (secret !== process.env.SETUP_SECRET) {
    return res.status(403).send('Forbidden – provide ?secret=YOUR_SETUP_SECRET');
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id                  SERIAL PRIMARY KEY,
        email               VARCHAR(100) UNIQUE NOT NULL,
        password            TEXT NOT NULL,
        must_change_password BOOLEAN DEFAULT TRUE,
        role                VARCHAR(20) DEFAULT 'member',
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

    // Seed a first admin only if no users exist yet
    const { rows } = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) === 0) {
      const adminEmail    = process.env.SEED_ADMIN_EMAIL    || 'admin@meuglobal.com';
      const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
      const hashed        = await bcrypt.hash(adminPassword, 12);

      await pool.query(
        `INSERT INTO users (email, password, must_change_password, role)
         VALUES ($1, $2, TRUE, 'admin')`,
        [adminEmail, hashed]
      );
      return res.send(`
        ✅ Tables created.<br>
        🔑 Seed admin created: <strong>${adminEmail}</strong> / <strong>${adminPassword}</strong><br>
        ⚠️  Log in and change this password immediately.
      `);
    }

    res.send('✅ Tables already exist. No seed user created (users table not empty).');
  } catch (err) {
    console.error('setup-db error:', err);
    res.status(500).send('❌ Setup failed: ' + err.message);
  }
});


// ─────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const user    = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    res.json({
      success:    true,
      mustChange: user.must_change_password,
      userId:     user.id,
      role:       user.role
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login.' });
  }
});


// POST /api/update-password
// Guards: userId must be supplied AND the matching temp-password flow must
// still be active (must_change_password = true), so a random user ID won't work.
app.post('/api/update-password', async (req, res) => {
  const { userId, newPassword } = req.body;

  if (!userId || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  try {
    // Only allow the update if the account is still in "must change" state
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND must_change_password = TRUE', [userId]
    );
    if (rows.length === 0) {
      return res.status(403).json({ error: 'Password change not permitted for this account.' });
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.query(
      'UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2',
      [hashed, userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Update password error:', err);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});


// POST /api/admin/add-user
// In production you'd gate this with a session/JWT; for now it trusts
// that only logged-in admins can reach the button that calls it.
app.post('/api/admin/add-user', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: 'Email and a password (min 6 chars) are required.' });
  }

  try {
    const hashed = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO users (email, password, must_change_password)
       VALUES ($1, $2, TRUE)`,
      [email.toLowerCase().trim(), hashed]
    );
    res.status(201).json({ success: true });
  } catch (err) {
    // Unique-constraint violation = email already exists
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with that email already exists.' });
    }
    console.error('Add user error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
});


// ─────────────────────────────────────────────
//  CRM ROUTES
// ─────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM clients');
    res.json({ client_count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

app.get('/api/clients', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM clients ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('Clients fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch clients.' });
  }
});

app.post('/api/clients', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  try {
    const { rows } = await pool.query(
      'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING *',
      [name, email.toLowerCase().trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A client with that email already exists.' });
    }
    console.error('Add client error:', err);
    res.status(400).json({ error: 'Failed to register client.' });
  }
});


// ─────────────────────────────────────────────
//  CATCH-ALL – serve the SPA
// ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


// ─────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────
app.listen(port, () => {
  console.log(`
  🚀  MEU Global CRM Engine
  ─────────────────────────
  Port:   ${port}
  Env:    ${process.env.NODE_ENV || 'development'}
  `);
});
