// MEU Global CRM — Express + PostgreSQL backend
// Fixes applied:
//   H1: /api/tasks now respects the client_id query param (was previously ignored)
//   H1: /api/posts/:id/approve verifies the reviewer is admin or client_owner
//   H3: Gemini caption generator uses gemini-1.5-flash (gemini-pro is deprecated)

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

// Optional Google Generative AI loader — won't crash if package not installed yet
let GoogleGenerativeAI = null;
try {
  ({ GoogleGenerativeAI } = require('@google/generative-ai'));
} catch (e) {
  console.warn('[warn] @google/generative-ai not installed — /api/chat will return an error until you `npm i @google/generative-ai`');
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const PORT = process.env.PORT || 8080;
const DEFAULT_PASSWORD = 'ChangeMe123!';

// ────────────────────────────────────────────────────────────────
// DB SETUP / MIGRATION
// ────────────────────────────────────────────────────────────────
async function setupDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    client_id INTEGER,
    must_change_password BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    address TEXT,
    description TEXT,
    status TEXT DEFAULT 'Active',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    company TEXT,
    job_title TEXT,
    annual_revenue NUMERIC,
    status TEXT DEFAULT 'Contacted',
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS lead_activity (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price NUMERIC NOT NULL,
    billing_type TEXT DEFAULT 'one-off',
    duration_months INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS end_customers (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT,
    status TEXT DEFAULT 'Contract Review',
    sign_up_date TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    caption TEXT,
    media_link TEXT,
    platforms TEXT[],
    post_date DATE,
    post_time TIME,
    status TEXT DEFAULT 'draft',
    approval_status TEXT DEFAULT 'pending',
    rejection_reason TEXT,
    created_by INTEGER REFERENCES users(id),
    approved_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    assigned_to INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    due_date DATE,
    status TEXT DEFAULT 'todo',
    subtasks JSONB DEFAULT '[]'::jsonb,
    feedback TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS pages (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    headline TEXT,
    subheadline TEXT,
    cta_text TEXT,
    is_published BOOLEAN DEFAULT false,
    views INTEGER DEFAULT 0,
    submissions INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT,
    scheduled_date TIMESTAMPTZ,
    status TEXT DEFAULT 'draft',
    recipients_count INTEGER DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    invoice_number TEXT UNIQUE NOT NULL,
    items JSONB DEFAULT '[]'::jsonb,
    deductions JSONB DEFAULT '[]'::jsonb,
    due_days INTEGER DEFAULT 1,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Seed default admin if no users exist
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c === 0) {
    const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    await pool.query(
      `INSERT INTO users (name,email,password_hash,role,must_change_password) VALUES ($1,$2,$3,'admin',true)`,
      ['Admin', 'admin@meuglobal.com', hash]
    );
    console.log('[seed] Default admin: admin@meuglobal.com / ChangeMe123!');
  }
}

setupDb().catch(err => console.error('[setupDb]', err));

// ────────────────────────────────────────────────────────────────
// AUTH
// ────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (rows.length === 0) return res.json({ success: false, error: 'Invalid credentials' });
    const u = rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.json({ success: false, error: 'Invalid credentials' });
    res.json({
      success: true,
      userId: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      client_id: u.client_id,
      mustChange: u.must_change_password
    });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/api/change-password', async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Invalid input' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash=$1, must_change_password=false WHERE id=$2',
      [hash, userId]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[change-password]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────
// AI CAPTION  —  H3 FIX: gemini-pro is deprecated, use gemini-1.5-flash
// ────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt, post_title } = req.body || {};
    const finalPrompt = prompt || (post_title ? `Write an engaging social media caption for a post titled "${post_title}".` : '');
    if (!finalPrompt) return res.status(400).json({ success: false, error: 'No prompt provided' });

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(500).json({ success: false, error: 'GEMINI_API_KEY not configured on server' });
    if (!GoogleGenerativeAI) return res.status(500).json({ success: false, error: '@google/generative-ai not installed on server' });

    const genAI = new GoogleGenerativeAI(apiKey);
    // ── H3 FIX ──────────────────────────────────────────────
    // Was: getGenerativeModel({ model: "gemini-pro" })  ← DEPRECATED
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    // ────────────────────────────────────────────────────────

    const result = await model.generateContent(finalPrompt);
    const text = result.response.text();
    res.json({ success: true, text });
  } catch (e) {
    console.error('[chat] AI error:', e);
    res.status(500).json({ success: false, error: e.message || 'AI generation failed' });
  }
});

// ────────────────────────────────────────────────────────────────
// USERS
// ────────────────────────────────────────────────────────────────
app.get('/api/admin/users', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.name, u.email, u.role, u.client_id, c.name AS client_name
      FROM users u LEFT JOIN clients c ON u.client_id=c.id
      ORDER BY u.created_at DESC`);
    res.json(rows);
  } catch (e) { console.error('[users]', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/add-user', async (req, res) => {
  try {
    const { name, email, password, role, client_id } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
    const exists = await pool.query('SELECT 1 FROM users WHERE email=$1', [email]);
    if (exists.rows.length) return res.status(400).json({ error: 'Email already in use' });
    const pw = password || DEFAULT_PASSWORD;
    const hash = await bcrypt.hash(pw, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name,email,password_hash,role,client_id,must_change_password)
       VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
      [name, email, hash, role || 'user', client_id || null]
    );
    res.json({ id: rows[0].id });
  } catch (e) { console.error('[add-user]', e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/users/assignable', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id,name,email FROM users ORDER BY name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ────────────────────────────────────────────────────────────────
// CLIENTS
// ────────────────────────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  try {
    const { role, client_id } = req.query;
    let query = `SELECT * FROM clients`;
    const params = [];
    if (role !== 'admin' && client_id) {
      params.push(client_id);
      query += ` WHERE id=$${params.length}`;
    }
    query += ' ORDER BY name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error('[clients]', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/clients', async (req, res) => {
  try {
    const { name, email, address, description } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
    const { rows } = await pool.query(
      `INSERT INTO clients (name,email,address,description) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, email, address || '', description || '']
    );
    res.json({ id: rows[0].id });
  } catch (e) { console.error('[create client]', e); res.status(500).json({ error: 'Server error' }); }
});

// ────────────────────────────────────────────────────────────────
// LEADS  (admin-only — frontend gates this)
// ────────────────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  try {
    const { client_id } = req.query;
    let query = `
      SELECT l.*, c.name AS client_name, u.name AS owner_name
      FROM leads l
      LEFT JOIN clients c ON l.client_id=c.id
      LEFT JOIN users u ON l.created_by=u.id`;
    const params = [];
    if (client_id) { params.push(client_id); query += ` WHERE l.client_id=$${params.length}`; }
    query += ' ORDER BY l.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error('[leads]', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/leads', async (req, res) => {
  try {
    const { client_id, name, email, company, job_title, annual_revenue, status, created_by } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO leads (client_id,name,email,company,job_title,annual_revenue,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [client_id, name, email || '', company || '', job_title || '', annual_revenue, status || 'Contacted', created_by]
    );
    await pool.query(
      `INSERT INTO lead_activity (lead_id,user_id,description) VALUES ($1,$2,$3)`,
      [rows[0].id, created_by, `Lead created with status: ${status || 'Contacted'}`]
    );
    res.json({ id: rows[0].id });
  } catch (e) { console.error('[create lead]', e); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/leads/:id/status', async (req, res) => {
  try {
    const { status, user_id } = req.body;
    await pool.query('UPDATE leads SET status=$1, updated_at=NOW() WHERE id=$2', [status, req.params.id]);
    await pool.query(
      `INSERT INTO lead_activity (lead_id,user_id,description) VALUES ($1,$2,$3)`,
      [req.params.id, user_id, `Status changed to: ${status}`]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/leads/:id/activity', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, u.name AS user_name FROM lead_activity a
       LEFT JOIN users u ON a.user_id=u.id
       WHERE a.lead_id=$1 ORDER BY a.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ────────────────────────────────────────────────────────────────
// PRODUCTS
// ────────────────────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const { client_id } = req.query;
    let query = `SELECT p.*, c.name AS client_name FROM products p LEFT JOIN clients c ON p.client_id=c.id`;
    const params = [];
    if (client_id) { params.push(client_id); query += ` WHERE p.client_id=$${params.length}`; }
    query += ' ORDER BY p.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error('[products]', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/products', async (req, res) => {
  try {
    const { client_id, name, price, billing_type, duration_months } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO products (client_id,name,price,billing_type,duration_months) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [client_id, name, price, billing_type || 'one-off', duration_months || 0]
    );
    res.json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ────────────────────────────────────────────────────────────────
// END CUSTOMERS
// ────────────────────────────────────────────────────────────────
app.get('/api/end-customers', async (req, res) => {
  try {
    const { client_id } = req.query;
    let query = `
      SELECT ec.*, p.name AS product_name, p.price AS product_price, c.name AS client_name
      FROM end_customers ec
      LEFT JOIN products p ON ec.product_id=p.id
      LEFT JOIN clients c ON ec.client_id=c.id`;
    const params = [];
    if (client_id) { params.push(client_id); query += ` WHERE ec.client_id=$${params.length}`; }
    query += ' ORDER BY ec.sign_up_date DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error('[end-customers]', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/end-customers', async (req, res) => {
  try {
    const { client_id, product_id, name, email, status } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO end_customers (client_id,product_id,name,email,status) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [client_id, product_id || null, name, email || '', status || 'Contract Review']
    );
    res.json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ────────────────────────────────────────────────────────────────
// POSTS
// ────────────────────────────────────────────────────────────────
app.get('/api/posts', async (req, res) => {
  try {
    const { month, year, client_id } = req.query;
    let query = `
      SELECT p.*, c.name AS client_name, u.name AS creator_name
      FROM posts p
      LEFT JOIN clients c ON p.client_id=c.id
      LEFT JOIN users u ON p.created_by=u.id
      WHERE 1=1`;
    const params = [];
    if (month && year) {
      params.push(month, year);
      query += ` AND EXTRACT(MONTH FROM p.post_date)=$${params.length-1} AND EXTRACT(YEAR FROM p.post_date)=$${params.length}`;
    }
    if (client_id) { params.push(client_id); query += ` AND p.client_id=$${params.length}`; }
    query += ' ORDER BY p.post_date, p.post_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error('[posts]', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/posts', async (req, res) => {
  try {
    const { client_id, title, caption, media_link, platforms, post_date, post_time, status, created_by } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO posts (client_id,title,caption,media_link,platforms,post_date,post_time,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [client_id, title, caption || '', media_link || '', platforms || [], post_date, post_time, status || 'draft', created_by]
    );
    res.json({ id: rows[0].id });
  } catch (e) { console.error('[create post]', e); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/posts/:id', async (req, res) => {
  try {
    const { client_id, title, caption, media_link, platforms, post_date, post_time, status } = req.body;
    await pool.query(
      `UPDATE posts SET client_id=$1, title=$2, caption=$3, media_link=$4, platforms=$5, post_date=$6, post_time=$7, status=$8 WHERE id=$9`,
      [client_id, title, caption || '', media_link || '', platforms || [], post_date, post_time, status, req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/posts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM posts WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// H1 FIX: only admin or client_owner may approve a post
app.put('/api/posts/:id/approve', async (req, res) => {
  try {
    const { approved, rejection_reason, reviewer_id } = req.body;
    if (!reviewer_id) return res.status(400).json({ error: 'reviewer_id required' });

    const { rows: reviewerRows } = await pool.query('SELECT role FROM users WHERE id=$1', [reviewer_id]);
    if (!reviewerRows.length) return res.status(403).json({ error: 'Reviewer not found' });
    const reviewerRole = reviewerRows[0].role;
    if (reviewerRole !== 'admin' && reviewerRole !== 'client_owner') {
      return res.status(403).json({ error: 'Only the Client Owner can approve posts' });
    }

    if (approved) {
      await pool.query(
        `UPDATE posts SET approval_status='approved', approved_by=$1, rejection_reason=NULL WHERE id=$2`,
        [reviewer_id, req.params.id]
      );
    } else {
      await pool.query(
        `UPDATE posts SET approval_status='rejected', approved_by=$1, rejection_reason=$2 WHERE id=$3`,
        [reviewer_id, rejection_reason || 'Rejected', req.params.id]
      );
    }
    res.json({ success: true });
  } catch (e) { console.error('[approve post]', e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/posts/pending-approval', async (req, res) => {
  try {
    const { client_id } = req.query;
    let query = `
      SELECT p.*, c.name AS client_name, u.name AS creator_name
      FROM posts p
      LEFT JOIN clients c ON p.client_id=c.id
      LEFT JOIN users u ON p.created_by=u.id
      WHERE p.approval_status='pending'`;
    const params = [];
    if (client_id) { params.push(client_id); query += ` AND p.client_id=$${params.length}`; }
    query += ' ORDER BY p.post_date';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ────────────────────────────────────────────────────────────────
// TASKS  — H1 FIX: client_id query param now actually filters the SQL
// ────────────────────────────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
  try {
    const { role, client_id, user_id } = req.query;
    let query = `
      SELECT t.*,
             c.name AS client_name,
             a.name AS assignee_name,
             cr.name AS creator_name
      FROM tasks t
      LEFT JOIN clients c ON t.client_id=c.id
      LEFT JOIN users a ON t.assigned_to=a.id
      LEFT JOIN users cr ON t.created_by=cr.id
      WHERE 1=1`;
    const params = [];

    // ── H1 FIX ──────────────────────────────────────────────
    // Was: client_id was accepted but never appended to the query.
    // Now: filter by client_id when one is supplied.
    if (client_id && client_id !== 'null' && client_id !== '') {
      params.push(client_id);
      query += ` AND t.client_id=$${params.length}`;
    }
    // ────────────────────────────────────────────────────────

    if (role === 'user' && user_id) {
      // Regular users see only tasks assigned to them or that they created
      params.push(user_id, user_id);
      query += ` AND (t.assigned_to=$${params.length-1} OR t.created_by=$${params.length})`;
    } else if (role === 'client_owner' && user_id) {
      // Client owners see all their client's tasks (already filtered if client_id supplied)
      // No extra filter needed beyond client_id
    }
    // admins see everything (subject to client_id filter)

    query += ' ORDER BY t.due_date NULLS LAST, t.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { console.error('[tasks]', e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const { client_id, title, description, assigned_to, due_date, created_by, subtasks } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO tasks (client_id,title,description,assigned_to,due_date,created_by,subtasks)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [client_id, title, description || '', assigned_to || null, due_date, created_by, JSON.stringify(subtasks || [])]
    );
    res.json({ id: rows[0].id });
  } catch (e) { console.error('[create task]', e); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/tasks/:id/status', async (req, res) => {
  try {
    const { status, user_id } = req.body;

    // H1 FIX: only the creator (or admin) may move a task to "done" — assignees go to "review" first
    if (status === 'done' && user_id) {
      const { rows } = await pool.query('SELECT created_by FROM tasks WHERE id=$1', [req.params.id]);
      if (rows.length) {
        const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id=$1', [user_id]);
        const userRole = userRows[0]?.role;
        if (rows[0].created_by !== parseInt(user_id) && userRole !== 'admin') {
          return res.status(403).json({ error: 'Only the task creator can mark it Done.' });
        }
      }
    }

    await pool.query('UPDATE tasks SET status=$1, updated_at=NOW() WHERE id=$2', [status, req.params.id]);
    res.json({ success: true });
  } catch (e) { console.error('[task status]', e); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/tasks/:id/subtasks', async (req, res) => {
  try {
    const { subtasks } = req.body;
    await pool.query('UPDATE tasks SET subtasks=$1, updated_at=NOW() WHERE id=$2',
      [JSON.stringify(subtasks || []), req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/tasks/:id/approve', async (req, res) => {
  try {
    const { approved, feedback, reviewer_id } = req.body;
    // Verify reviewer is the creator or an admin
    const { rows } = await pool.query('SELECT created_by FROM tasks WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Task not found' });
    if (reviewer_id) {
      const { rows: userRows } = await pool.query('SELECT role FROM users WHERE id=$1', [reviewer_id]);
      const userRole = userRows[0]?.role;
      if (rows[0].created_by !== parseInt(reviewer_id) && userRole !== 'admin') {
        return res.status(403).json({ error: 'Only the task creator can approve.' });
      }
    }
    if (approved) {
      await pool.query('UPDATE tasks SET status=$1, feedback=NULL, updated_at=NOW() WHERE id=$2', ['done', req.params.id]);
    } else {
      await pool.query('UPDATE tasks SET status=$1, feedback=$2, updated_at=NOW() WHERE id=$3', ['in-progress', feedback || '', req.params.id]);
    }
    res.json({ success: true });
  } catch (e) { console.error('[task approve]', e); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ────────────────────────────────────────────────────────────────
// PAGES (Landing Pages)
// ────────────────────────────────────────────────────────────────
app.get('/api/pages', async (req, res) => {
  try {
    const { client_id } = req.query;
    let query = `SELECT p.*, c.name AS client_name FROM pages p LEFT JOIN clients c ON p.client_id=c.id`;
    const params = [];
    if (client_id) { params.push(client_id); query += ` WHERE p.client_id=$${params.length}`; }
    query += ' ORDER BY p.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/pages', async (req, res) => {
  try {
    const { client_id, name, slug, headline, subheadline, cta_text, created_by } = req.body;
    const exists = await pool.query('SELECT 1 FROM pages WHERE slug=$1', [slug]);
    if (exists.rows.length) return res.status(400).json({ error: 'Slug already in use' });
    const { rows } = await pool.query(
      `INSERT INTO pages (client_id,name,slug,headline,subheadline,cta_text,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [client_id, name, slug, headline || '', subheadline || '', cta_text || '', created_by]
    );
    res.json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/pages/:id/publish', async (req, res) => {
  try {
    await pool.query('UPDATE pages SET is_published=$1 WHERE id=$2', [req.body.is_published, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/pages/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM pages WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Public preview
app.get('/api/pages/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pages WHERE slug=$1 AND is_published=true', [req.params.slug]);
    if (!rows.length) return res.status(404).send('Page not found');
    const p = rows[0];
    await pool.query('UPDATE pages SET views=views+1 WHERE id=$1', [p.id]);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${p.name}</title>
      <style>body{font-family:sans-serif;padding:60px 20px;text-align:center;background:#faf9f7}h1{font-size:48px;margin-bottom:16px}p{font-size:20px;color:#555;margin-bottom:32px}button{padding:14px 32px;background:#d97706;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer}</style>
      </head><body><h1>${p.headline || p.name}</h1><p>${p.subheadline || ''}</p><button>${p.cta_text || 'Get Started'}</button></body></html>`);
  } catch (e) { res.status(500).send('Server error'); }
});

// ────────────────────────────────────────────────────────────────
// CAMPAIGNS
// ────────────────────────────────────────────────────────────────
app.get('/api/campaigns', async (req, res) => {
  try {
    const { client_id } = req.query;
    let query = `SELECT cm.*, c.name AS client_name FROM campaigns cm LEFT JOIN clients c ON cm.client_id=c.id`;
    const params = [];
    if (client_id) { params.push(client_id); query += ` WHERE cm.client_id=$${params.length}`; }
    query += ' ORDER BY cm.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/campaigns', async (req, res) => {
  try {
    const { client_id, name, subject, body, scheduled_date, created_by } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO campaigns (client_id,name,subject,body,scheduled_date,created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [client_id, name, subject, body || '', scheduled_date, created_by]
    );
    res.json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/campaigns/:id/send', async (req, res) => {
  try {
    await pool.query(`UPDATE campaigns SET status='sent', scheduled_date=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Campaign marked as sent' });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/campaigns/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM campaigns WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ────────────────────────────────────────────────────────────────
// INVOICES
// ────────────────────────────────────────────────────────────────
app.get('/api/invoices/next-number', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM invoices`);
    const next = String(rows[0].c + 1).padStart(4, '0');
    res.json({ next_invoice_number: `INV-${next}` });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/invoices', async (req, res) => {
  try {
    const { client_id, invoice_number, items, deductions, due_days, created_by } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO invoices (client_id,invoice_number,items,deductions,due_days,created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [client_id, invoice_number, JSON.stringify(items || []), JSON.stringify(deductions || []), due_days || 1, created_by]
    );
    res.json({ id: rows[0].id });
  } catch (e) { console.error('[invoice]', e); res.status(500).json({ error: 'Server error' }); }
});

// ────────────────────────────────────────────────────────────────
// DASHBOARD STATS
// ────────────────────────────────────────────────────────────────
app.get('/api/stats/dashboard', async (req, res) => {
  try {
    const { client_id } = req.query;
    const stagesParams = [], productsParams = [];
    let stagesQuery = `SELECT status, COUNT(*)::int AS count FROM end_customers`;
    let productsQuery = `SELECT p.name, COUNT(ec.id)::int AS count FROM products p LEFT JOIN end_customers ec ON ec.product_id=p.id`;

    if (client_id) {
      stagesParams.push(client_id);
      stagesQuery += ` WHERE client_id=$${stagesParams.length}`;
      productsParams.push(client_id);
      productsQuery += ` WHERE p.client_id=$${productsParams.length}`;
    }
    stagesQuery += ` GROUP BY status`;
    productsQuery += ` GROUP BY p.id, p.name ORDER BY count DESC LIMIT 5`;

    const [stagesRes, productsRes] = await Promise.all([
      pool.query(stagesQuery, stagesParams),
      pool.query(productsQuery, productsParams)
    ]);

    res.json({ stages: stagesRes.rows, products: productsRes.rows });
  } catch (e) { console.error('[stats]', e); res.status(500).json({ error: 'Server error' }); }
});

// ────────────────────────────────────────────────────────────────
// CATCH-ALL — must be the LAST route registered
// ────────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`MEU Global CRM listening on port ${PORT}`);
});
