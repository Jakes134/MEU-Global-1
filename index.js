require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Google Generative AI
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ============================================================================
// APP INITIALIZATION & CONFIGURATION
// ============================================================================
const app = express();
const port = process.env.PORT || 8080;

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));

// Database connection setup
const dbUrl = process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/[?&]sslmode=\w+/g, '') : undefined;
const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

pool.query('SELECT NOW()')
  .then(r => console.log('Database connected at', r.rows[0].now))
  .catch(e => console.error('Database connection FAILED:', e.message));

// ============================================================================
// DATABASE SETUP & MIGRATIONS
// ============================================================================
app.get('/setup-db', async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.secret !== process.env.SETUP_SECRET) return res.status(403).send('Forbidden');
  try {
    // 1. Users Table
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE NOT NULL, password TEXT NOT NULL, role VARCHAR(20) DEFAULT 'user', client_id INTEGER, must_change_password BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user'`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS client_id INTEGER`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT TRUE`);

    // 2. Clients Table
    await pool.query(`CREATE TABLE IF NOT EXISTS clients (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(100) UNIQUE NOT NULL, address TEXT, description TEXT, status VARCHAR(20) DEFAULT 'Active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS address TEXT`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS description TEXT`);

    // 3. Team Members
    await pool.query(`CREATE TABLE IF NOT EXISTS client_team_members (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(50) DEFAULT 'member',
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(client_id, user_id)
    );`);

    // 4. Leads Table
    await pool.query(`CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100),
      company VARCHAR(100),
      job_title VARCHAR(100),
      phone VARCHAR(50),
      annual_revenue DECIMAL(12,2),
      status VARCHAR(50) DEFAULT 'Contacted',
      lead_owner INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);

    // 5. Lead Activity
    await pool.query(`CREATE TABLE IF NOT EXISTS lead_activity (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      activity_type VARCHAR(50),
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);

    // 6. Landing Pages
    await pool.query(`CREATE TABLE IF NOT EXISTS landing_pages (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL,
      slug VARCHAR(200) UNIQUE NOT NULL,
      headline TEXT,
      subheadline TEXT,
      cta_text VARCHAR(100),
      html_content TEXT,
      is_published BOOLEAN DEFAULT FALSE,
      views INTEGER DEFAULT 0,
      submissions INTEGER DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approval_status VARCHAR(20) DEFAULT 'pending',
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMP,
      rejection_reason TEXT
    );`);

    await pool.query(`ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending'`);
    await pool.query(`ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`);
    await pool.query(`ALTER TABLE landing_pages ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);

    // 7. Page Submissions
    await pool.query(`CREATE TABLE IF NOT EXISTS page_submissions (
      id SERIAL PRIMARY KEY,
      page_id INTEGER REFERENCES landing_pages(id) ON DELETE CASCADE,
      email VARCHAR(100),
      name VARCHAR(100),
      phone VARCHAR(50),
      data JSONB,
      submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);

    // 8. Email Campaigns
    await pool.query(`CREATE TABLE IF NOT EXISTS email_campaigns (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL,
      subject VARCHAR(300),
      body TEXT,
      status VARCHAR(50) DEFAULT 'draft',
      scheduled_date TIMESTAMP,
      sent_date TIMESTAMP,
      recipients_count INTEGER DEFAULT 0,
      opened_count INTEGER DEFAULT 0,
      clicked_count INTEGER DEFAULT 0,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approval_status VARCHAR(20) DEFAULT 'pending',
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMP,
      rejection_reason TEXT
    );`);

    await pool.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending'`);
    await pool.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP`);
    await pool.query(`ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);

    // 9. Email Campaign Recipients
    await pool.query(`CREATE TABLE IF NOT EXISTS campaign_recipients (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER REFERENCES email_campaigns(id) ON DELETE CASCADE,
      email VARCHAR(100) NOT NULL,
      name VARCHAR(100),
      status VARCHAR(50) DEFAULT 'pending',
      opened_at TIMESTAMP,
      clicked_at TIMESTAMP
    );`);

    // 10. Products & Customers
    await pool.query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, name VARCHAR(100) NOT NULL, price DECIMAL(12,2) NOT NULL, billing_type VARCHAR(20) DEFAULT 'one-off', duration_months INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS end_customers (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, name VARCHAR(100) NOT NULL, email VARCHAR(100), status VARCHAR(30) DEFAULT 'Contract Review', sign_up_date DATE DEFAULT CURRENT_DATE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);

    // 11. Posts Table
    await pool.query(`CREATE TABLE IF NOT EXISTS posts (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, title TEXT NOT NULL, caption TEXT, platforms TEXT[], post_date DATE NOT NULL, post_time TIME, status VARCHAR(20) DEFAULT 'draft', is_approved BOOLEAN DEFAULT FALSE, approval_status VARCHAR(20) DEFAULT 'pending', rejection_reason TEXT, media_link TEXT, created_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending'`);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_link TEXT`);

    // 12. Tasks & Comments
    await pool.query(`CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, assigned_to INTEGER, created_by INTEGER, title TEXT NOT NULL, description TEXT, due_date DATE, status VARCHAR(30) DEFAULT 'todo', subtasks JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by INTEGER`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date DATE`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS subtasks JSONB DEFAULT '[]'::jsonb`);
    await pool.query(`CREATE TABLE IF NOT EXISTS task_comments (id SERIAL PRIMARY KEY, task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, user_id INTEGER, comment TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);

    // 13. Invoices System
    await pool.query(`CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY, 
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, 
      invoice_number VARCHAR(50) UNIQUE NOT NULL, 
      due_days INTEGER DEFAULT 1, 
      subtotal DECIMAL(12,2) DEFAULT 0, 
      deductions DECIMAL(12,2) DEFAULT 0, 
      total DECIMAL(12,2) DEFAULT 0, 
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);

    await pool.query(`CREATE TABLE IF NOT EXISTS invoice_items (
      id SERIAL PRIMARY KEY, 
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE, 
      description TEXT NOT NULL, 
      rate DECIMAL(12,2) NOT NULL, 
      amount DECIMAL(12,2) NOT NULL, 
      is_deduction BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);

    // Add Foreign Key Constraints
    await pool.query(`ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_created_by_fkey`);
    await pool.query(`ALTER TABLE posts ADD CONSTRAINT posts_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_assigned_to_fkey`);
    await pool.query(`ALTER TABLE tasks ADD CONSTRAINT tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_created_by_fkey`);
    await pool.query(`ALTER TABLE tasks ADD CONSTRAINT tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE task_comments DROP CONSTRAINT IF EXISTS task_comments_user_id_fkey`);
    await pool.query(`ALTER TABLE task_comments ADD CONSTRAINT task_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL`);

    // Seed Admin User
    const { rows } = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(rows[0].count) === 0) {
      const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@meuglobal.com';
      const adminPass = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
      const hashed = await bcrypt.hash(adminPass, 12);
      await pool.query(`INSERT INTO users (name, email, password, role, must_change_password) VALUES ('System Admin', $1, $2, 'admin', TRUE)`, [adminEmail, hashed]);
    }
    res.send('<pre>Database fully migrated successfully with all new features!</pre>');

  } catch (err) {
    console.error('Setup error:', err);
    res.status(500).send('<pre>' + err.message + '</pre>');
  }
});

// ============================================================================
// AUTHENTICATION API
// ============================================================================
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials.' });
    const user = rows[0];
    if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Invalid credentials.' });
    res.json({ success: true, userId: user.id, name: user.name, role: user.role, client_id: user.client_id, email: user.email, mustChange: user.must_change_password });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/change-password', async (req, res) => {
  const { userId, newPassword } = req.body;
  if (!userId || !newPassword) return res.status(400).json({ error: 'Missing fields.' });
  try {
    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password=$1, must_change_password=FALSE WHERE id=$2', [hashed, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// GEMINI API INTEGRATION
// ============================================================================
app.post('/api/chat', async (req, res) => {
  const { client_id, prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

  try {
    let systemInstruction = "You are an expert social media manager and content creator.";

    if (client_id) {
      const clientRes = await pool.query('SELECT name, description FROM clients WHERE id = $1', [client_id]);
      if (clientRes.rows.length > 0) {
        const client = clientRes.rows[0];
        systemInstruction = `You are the dedicated expert social media manager for the brand/client named "${client.name}". 
        Here is their brand description, content style, and guidelines: 
        ${client.description || 'Create engaging, professional content suitable for their industry.'}
        
        Always adapt your tone, vocabulary, and style to perfectly match these guidelines.`;
      }
    }

    const geminiApiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!geminiApiKey) {
      return res.status(500).json({ error: 'Google Gemini API key not configured on the server.' });
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-pro",
      systemInstruction: systemInstruction
    });

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    res.json({ success: true, text: text });

  } catch (err) {
    console.error('Gemini SDK Error:', err);
    res.status(500).json({ error: `AI Error: ${err.message}` });
  }
});

// ============================================================================
// USER MANAGEMENT API
// ============================================================================
app.post('/api/admin/add-user', async (req, res) => {
  const { name, email, role, client_id, password } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required.' });
  try {
    const raw = (password && password.trim()) || 'ChangeMe123!';
    const hashed = await bcrypt.hash(raw, 12);
    const result = await pool.query(`INSERT INTO users (name, email, password, role, client_id, must_change_password) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, name, email, role`, [name.trim(), email.toLowerCase().trim(), hashed, role || 'user', client_id || null]);
    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT u.id, u.name, u.email, u.role, u.client_id, c.name as client_name, u.created_at FROM users u LEFT JOIN clients c ON u.client_id = c.id ORDER BY u.created_at DESC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/assignable', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, email, role FROM users WHERE role IN ('user','admin') ORDER BY name ASC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// CLIENT MANAGEMENT API
// ============================================================================
app.get('/api/clients', async (req, res) => {
  const { role, client_id } = req.query;
  try {
    let q = 'SELECT * FROM clients';
    let p = [];
    if (role !== 'admin' && client_id && client_id !== 'null') {
      q += ' WHERE id = $1';
      p.push(client_id);
    }
    q += ' ORDER BY name ASC';
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients', async (req, res) => {
  const { name, email, address, description } = req.body;
  try {
    const { rows } = await pool.query('INSERT INTO clients (name, email, address, description) VALUES ($1, $2, $3, $4) RETURNING *', [name, email, address || null, description || null]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Client email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/clients/:id', async (req, res) => {
  const { name, email, status, address, description } = req.body;
  try {
    await pool.query('UPDATE clients SET name=$1, email=$2, status=$3, address=$4, description=$5 WHERE id=$6', [name, email, status, address || null, description || null, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// TEAM MEMBERS API
// ============================================================================
app.get('/api/clients/:id/team', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ctm.*, u.name, u.email FROM client_team_members ctm JOIN users u ON ctm.user_id = u.id WHERE ctm.client_id = $1 ORDER BY ctm.added_at DESC`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients/:id/team', async (req, res) => {
  const { user_id, role } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO client_team_members (client_id, user_id, role) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, user_id, role || 'member']
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'User already on team' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clients/:clientId/team/:userId', async (req, res) => {
  try {
    await pool.query('DELETE FROM client_team_members WHERE client_id=$1 AND user_id=$2', [req.params.clientId, req.params.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// LEADS API
// ============================================================================
app.get('/api/leads', async (req, res) => {
  const { client_id, status } = req.query;
  try {
    let q = `SELECT l.*, c.name as client_name, u.name as owner_name, cr.name as creator_name FROM leads l LEFT JOIN clients c ON l.client_id = c.id LEFT JOIN users u ON l.lead_owner = u.id LEFT JOIN users cr ON l.created_by = cr.id WHERE 1=1`;
    const p = [];

    if (client_id && client_id !== 'null') {
      p.push(client_id);
      q += ` AND l.client_id = $${p.length}`;
    }

    if (status) {
      p.push(status);
      q += ` AND l.status = $${p.length}`;
    }

    q += ' ORDER BY l.updated_at DESC';
    const { rows } = await pool.query(q, p);

    for (let lead of rows) {
      if (lead.client_id) {
        const teamRes = await pool.query(`
          SELECT u.id, u.name, u.email 
          FROM client_team_members ctm 
          JOIN users u ON ctm.user_id = u.id 
          WHERE ctm.client_id = $1 
          LIMIT 3
        `, [lead.client_id]);
        lead.team_members = teamRes.rows;
      }
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads', async (req, res) => {
  const { client_id, name, email, company, job_title, phone, annual_revenue, status, created_by } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const { rows } = await pool.query(`INSERT INTO leads (client_id, name, email, company, job_title, phone, annual_revenue, status, created_by, lead_owner) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING *`, [client_id, name, email, company, job_title, phone, annual_revenue, status || 'Contacted', created_by]);

    await pool.query(`INSERT INTO lead_activity (lead_id, user_id, activity_type, description) VALUES ($1, $2, 'created', 'Lead created')`, [rows[0].id, created_by]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/leads/:id', async (req, res) => {
  const { name, email, company, job_title, phone, annual_revenue, status, lead_owner } = req.body;
  try {
    const oldLead = await pool.query('SELECT status FROM leads WHERE id = $1', [req.params.id]);
    const { rows } = await pool.query(`UPDATE leads SET name=$1, email=$2, company=$3, job_title=$4, phone=$5, annual_revenue=$6, status=$7, lead_owner=$8, updated_at=CURRENT_TIMESTAMP WHERE id=$9 RETURNING *`, [name, email, company, job_title, phone, annual_revenue, status, lead_owner, req.params.id]);

    if (oldLead.rows[0] && oldLead.rows[0].status !== status) {
      await pool.query(`INSERT INTO lead_activity (lead_id, activity_type, description) VALUES ($1, 'status_changed', $2)`, [req.params.id, `Status changed from ${oldLead.rows[0].status} to ${status}`]);
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// LANDING PAGES API
// ============================================================================
app.get('/api/pages', async (req, res) => {
  const { client_id } = req.query;
  try {
    let q = `SELECT lp.*, c.name as client_name, u.name as creator_name FROM landing_pages lp LEFT JOIN clients c ON lp.client_id = c.id LEFT JOIN users u ON lp.created_by = u.id WHERE 1=1`;
    const p = [];
    if (client_id && client_id !== 'null') {
      p.push(client_id);
      q += ` AND lp.client_id = $${p.length}`;
    }
    q += ' ORDER BY lp.created_at DESC';
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pages', async (req, res) => {
  const { client_id, name, slug, headline, subheadline, cta_text, created_by } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'Name and slug required' });

  const html_content = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${name}</title></head><body><h1>${headline}</h1></body></html>`; // Minimal template
  try {
    const { rows } = await pool.query(`INSERT INTO landing_pages (client_id, name, slug, headline, subheadline, cta_text, html_content, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`, [client_id, name, slug, headline, subheadline, cta_text, html_content, created_by]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Slug already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// EMAIL CAMPAIGNS API
// ============================================================================
app.get('/api/campaigns', async (req, res) => {
  const { client_id } = req.query;
  try {
    let q = `SELECT ec.*, c.name as client_name, u.name as creator_name FROM email_campaigns ec LEFT JOIN clients c ON ec.client_id = c.id LEFT JOIN users u ON ec.created_by = u.id WHERE 1=1`;
    const p = [];
    if (client_id && client_id !== 'null') {
      p.push(client_id);
      q += ` AND ec.client_id = $${p.length}`;
    }
    q += ' ORDER BY ec.created_at DESC';
    const { rows } = await pool.query(q, p);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// INVOICE API
// ============================================================================
app.get('/api/invoices/next-number', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT invoice_number FROM invoices ORDER BY id DESC LIMIT 1');
    let nextNum = 'INV-0001';
    if (rows.length > 0) {
      const lastNumStr = rows[0].invoice_number;
      const match = lastNumStr.match(/INV-(\d+)/);
      if (match) {
        const num = parseInt(match[1], 10) + 1;
        nextNum = `INV-${num.toString().padStart(4, '0')}`;
      }
    }
    res.json({ next_invoice_number: nextNum });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/invoices', async (req, res) => {
  const { client_id, invoice_number, due_days, items, deductions, created_by } = req.body;
  if (!client_id || !invoice_number) return res.status(400).json({ error: 'Client ID and Invoice Number are required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let subtotal = 0, totalDeductions = 0;
    if (items) items.forEach(item => subtotal += parseFloat(item.amount || 0));
    if (deductions) deductions.forEach(ded => totalDeductions += parseFloat(ded.amount || 0));
    const total = subtotal - totalDeductions;

    const invRes = await client.query(`INSERT INTO invoices (client_id, invoice_number, due_days, subtotal, deductions, total, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`, [client_id, invoice_number, due_days || 1, subtotal, totalDeductions, total, created_by]);
    const invoiceId = invRes.rows[0].id;

    if (items) {
      for (const item of items) {
        await client.query(`INSERT INTO invoice_items (invoice_id, description, rate, amount, is_deduction) VALUES ($1, $2, $3, $4, FALSE)`, [invoiceId, item.description, item.rate, item.amount]);
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, invoice_id: invoiceId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================================
// PRODUCT & CUSTOMER API
// ============================================================================
app.get('/api/products', async (req, res) => {
  const { client_id } = req.query;
  try {
    let q = 'SELECT * FROM products', p = [];
    if (client_id && client_id !== 'null') {
      q += ' WHERE client_id=$1';
      p.push(client_id);
    }
    const { rows } = await pool.query(q + ' ORDER BY name ASC', p);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// POSTS API
// ============================================================================
app.get('/api/posts', async (req, res) => {
  const { month, year, client_id } = req.query;
  try {
    let query = `SELECT p.*, c.name as client_name, u.name as creator_name FROM posts p LEFT JOIN clients c ON p.client_id=c.id LEFT JOIN users u ON p.created_by=u.id WHERE 1=1`;
    const params = [];
    if (month && year) {
      params.push(year, month);
      query += ` AND EXTRACT(YEAR FROM p.post_date)=$${params.length - 1} AND EXTRACT(MONTH FROM p.post_date)=$${params.length}`;
    }
    if (client_id && client_id !== 'null') {
      params.push(client_id);
      query += ` AND p.client_id=$${params.length}`;
    }
    query += ' ORDER BY p.post_date ASC, p.post_time ASC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts', async (req, res) => {
  const { client_id, title, caption, media_link, platforms, post_date, post_time, status, created_by } = req.body;
  if (!title || !post_date) return res.status(400).json({ error: 'Title and date required.' });
  try {
    const { rows } = await pool.query(`INSERT INTO posts (client_id, title, caption, media_link, platforms, post_date, post_time, status, approval_status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING *`, [client_id || null, title, caption, media_link || null, platforms, post_date, post_time || null, status || 'draft', created_by]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// TASKS API
// ============================================================================
app.get('/api/tasks', async (req, res) => {
  const { role, client_id, user_id, due_month, due_year } = req.query;
  try {
    let query = `SELECT t.*, u.name as assignee_name, c.name as client_name, cb.name as creator_name FROM tasks t LEFT JOIN users u ON t.assigned_to=u.id LEFT JOIN clients c ON t.client_id=c.id LEFT JOIN users cb ON t.created_by=cb.id WHERE 1=1`;
    const params = [];
    if (role === 'client_owner' && user_id) {
      params.push(user_id);
      query += ` AND t.created_by=$${params.length}`;
    } else if (role === 'user' && user_id) {
      params.push(user_id);
      query += ` AND t.assigned_to=$${params.length}`;
    }
    if (due_month && due_year) {
      params.push(due_year, month);
      query += ` AND t.due_date IS NOT NULL AND EXTRACT(YEAR FROM t.due_date)=$${params.length - 1} AND EXTRACT(MONTH FROM t.due_date)=$${params.length}`;
    }
    query += ' ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// SERVE FRONTEND (This must be LAST)
// ============================================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => console.log('MEU Global CRM running on port ' + port));
