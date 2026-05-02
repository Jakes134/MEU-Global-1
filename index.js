require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { GoogleGenAI } = require('@google/genai');

// ============================================================================
// APP INITIALIZATION & CONFIGURATION
// ============================================================================
const app = express();
const port = process.env.PORT || 8080;

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(__dirname)); // CRITICAL: This allows the frontend to load invoice.jpeg

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

    // 3. Products & Customers
    await pool.query(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, name VARCHAR(100) NOT NULL, price DECIMAL(12,2) NOT NULL, billing_type VARCHAR(20) DEFAULT 'one-off', duration_months INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE IF NOT EXISTS end_customers (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, name VARCHAR(100) NOT NULL, email VARCHAR(100), status VARCHAR(30) DEFAULT 'Contract Review', sign_up_date DATE DEFAULT CURRENT_DATE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    
    // 4. Posts Table
    await pool.query(`CREATE TABLE IF NOT EXISTS posts (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, title TEXT NOT NULL, caption TEXT, platforms TEXT[], post_date DATE NOT NULL, post_time TIME, status VARCHAR(20) DEFAULT 'draft', is_approved BOOLEAN DEFAULT FALSE, approval_status VARCHAR(20) DEFAULT 'pending', rejection_reason TEXT, media_link TEXT, created_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending'`);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS rejection_reason TEXT`);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_link TEXT`);

    // 5. Tasks & Comments
    await pool.query(`CREATE TABLE IF NOT EXISTS tasks (id SERIAL PRIMARY KEY, client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE, assigned_to INTEGER, created_by INTEGER, title TEXT NOT NULL, description TEXT, due_date DATE, status VARCHAR(30) DEFAULT 'todo', subtasks JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by INTEGER`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date DATE`);
    await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS subtasks JSONB DEFAULT '[]'::jsonb`);
    await pool.query(`CREATE TABLE IF NOT EXISTS task_comments (id SERIAL PRIMARY KEY, task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, user_id INTEGER, comment TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);

    // 6. Invoices System
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
    res.send('<pre>Database fully migrated successfully.</pre>');

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

    const ai = new GoogleGenAI({ apiKey: geminiApiKey });

    const response = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.7,
      }
    });

    res.json({ success: true, text: response.text });

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
    const raw = password && password.trim() || 'ChangeMe123!';
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
  
  if (!client_id || !invoice_number) {
    return res.status(400).json({ error: 'Client ID and Invoice Number are required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    let subtotal = 0;
    let totalDeductions = 0;
    
    if (items && Array.isArray(items)) {
      items.forEach(item => subtotal += parseFloat(item.amount || 0));
    }
    if (deductions && Array.isArray(deductions)) {
      deductions.forEach(ded => totalDeductions += parseFloat(ded.amount || 0));
    }
    
    const total = subtotal - totalDeductions;

    const invRes = await client.query(
      `INSERT INTO invoices (client_id, invoice_number, due_days, subtotal, deductions, total, created_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [client_id, invoice_number, due_days || 1, subtotal, totalDeductions, total, created_by || null]
    );
    
    const invoiceId = invRes.rows[0].id;

    if (items && Array.isArray(items)) {
      for (const item of items) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, description, rate, amount, is_deduction) VALUES ($1, $2, $3, $4, FALSE)`,
          [invoiceId, item.description, item.rate, item.amount]
        );
      }
    }

    if (deductions && Array.isArray(deductions)) {
      for (const ded of deductions) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, description, rate, amount, is_deduction) VALUES ($1, $2, $3, $4, TRUE)`,
          [invoiceId, ded.description, ded.rate, ded.amount]
        );
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

app.post('/api/products', async (req, res) => {
  const { client_id, name, price, billing_type, duration_months } = req.body;
  if (!client_id) return res.status(400).json({ error: 'Client required.' });
  try {
    const { rows } = await pool.query('INSERT INTO products (client_id, name, price, billing_type, duration_months) VALUES ($1,$2,$3,$4,$5) RETURNING *', [client_id, name, price, billing_type, duration_months]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/end-customers', async (req, res) => {
  const { client_id } = req.query;
  try {
    let q = `SELECT ec.*, p.name as product_name, p.price as product_price, p.billing_type FROM end_customers ec LEFT JOIN products p ON ec.product_id = p.id WHERE 1=1`;
    const p = [];
    if (client_id && client_id !== 'null') {
      q += ' AND ec.client_id=$1';
      p.push(client_id);
    }
    const { rows } = await pool.query(q + ' ORDER BY ec.sign_up_date DESC', p);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/end-customers', async (req, res) => {
  const { client_id, product_id, name, email, status } = req.body;
  try {
    const { rows } = await pool.query('INSERT INTO end_customers (client_id, product_id, name, email, status) VALUES ($1,$2,$3,$4,$5) RETURNING *', [client_id, product_id, name, email, status]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/end-customers/:id', async (req, res) => {
  const { name, email, status, product_id } = req.body;
  try {
    await pool.query('UPDATE end_customers SET name=$1, email=$2, status=$3, product_id=$4 WHERE id=$5', [name, email, status, product_id, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// STATS API
// ============================================================================
app.get('/api/stats/dashboard', async (req, res) => {
  const { client_id } = req.query;
  try {
    const p = client_id && client_id !== 'null' ? [client_id] : [];
    const f = client_id && client_id !== 'null' ? ' WHERE client_id=$1' : '';
    const stages = await pool.query(`SELECT status, count(*) FROM end_customers${f} GROUP BY status`, p);
    const products = await pool.query(`SELECT p.name, count(ec.id) as count FROM products p JOIN end_customers ec ON ec.product_id=p.id ${client_id && client_id !== 'null' ? ' WHERE p.client_id=$1' : ''} GROUP BY p.name ORDER BY count DESC LIMIT 5`, p);
    res.json({ stages: stages.rows, products: products.rows });
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

app.put('/api/posts/:id', async (req, res) => {
  const { title, caption, media_link, platforms, post_date, post_time, status } = req.body;
  try {
    const { rows } = await pool.query(`UPDATE posts SET title=$1, caption=$2, media_link=$3, platforms=$4, post_date=$5, post_time=$6, status=$7, approval_status='pending', is_approved=FALSE, rejection_reason=NULL WHERE id=$8 RETURNING *`, [title, caption, media_link || null, platforms, post_date, post_time || null, status, req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/posts/:id/date', async (req, res) => {
  const { post_date } = req.body;
  try {
    const { rows } = await pool.query('UPDATE posts SET post_date=$1 WHERE id=$2 RETURNING *', [post_date, req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/posts/:id/approve', async (req, res) => {
  const { approved, rejection_reason } = req.body;
  const approvalStatus = approved ? 'approved' : 'rejected';
  try {
    const { rows } = await pool.query(`UPDATE posts SET is_approved=$1, approval_status=$2, rejection_reason=$3 WHERE id=$4 RETURNING *`, [approved, approvalStatus, approved ? null : (rejection_reason || null), req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/posts/bulk-approve', async (req, res) => {
  const { post_ids } = req.body;
  if (!post_ids || !Array.isArray(post_ids) || post_ids.length === 0) return res.status(400).json({ error: 'post_ids array required' });
  try {
    const placeholders = post_ids.map((_, i) => `$${i + 1}`).join(',');
    await pool.query(`UPDATE posts SET is_approved=TRUE, approval_status='approved', rejection_reason=NULL WHERE id IN (${placeholders})`, post_ids);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts/pending-approval', async (req, res) => {
  const { client_id } = req.query;
  try {
    let query = `SELECT p.*, c.name as client_name, u.name as creator_name FROM posts p LEFT JOIN clients c ON p.client_id=c.id LEFT JOIN users u ON p.created_by=u.id WHERE p.approval_status='pending'`;
    const params = [];
    if (client_id && client_id !== 'null') {
      params.push(client_id);
      query += ` AND p.client_id=$${params.length}`;
    }
    query += ' ORDER BY p.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/posts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM posts WHERE id=$1', [req.params.id]);
    res.json({ success: true });
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
      params.push(due_year, due_month);
      query += ` AND t.due_date IS NOT NULL AND EXTRACT(YEAR FROM t.due_date)=$${params.length - 1} AND EXTRACT(MONTH FROM t.due_date)=$${params.length}`;
    }
    query += ' ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  const { client_id, assigned_to, title, description, due_date, created_by, subtasks } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required.' });
  try {
    const { rows } = await pool.query(`INSERT INTO tasks (client_id, assigned_to, title, description, due_date, created_by, subtasks) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [client_id || null, assigned_to || null, title, description || '', due_date || null, created_by || null, JSON.stringify(subtasks || [])]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id/status', async (req, res) => {
  const { status } = req.body;
  if (status === 'done') return res.status(403).json({ error: 'Tasks must be approved by their creator before they can be marked done.' });
  try {
    await pool.query('UPDATE tasks SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id/approve', async (req, res) => {
  const { approved, feedback, reviewer_id } = req.body;
  const newStatus = approved ? 'done' : 'pending';
  try {
    await pool.query('UPDATE tasks SET status=$1 WHERE id=$2', [newStatus, req.params.id]);
    if (feedback && !approved) {
      await pool.query('INSERT INTO task_comments (task_id, user_id, comment) VALUES ($1,$2,$3)', [req.params.id, reviewer_id || null, 'Sent back: ' + feedback]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id/subtasks', async (req, res) => {
  const { subtasks } = req.body;
  try {
    await pool.query('UPDATE tasks SET subtasks=$1 WHERE id=$2', [JSON.stringify(subtasks), req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id/comments', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT tc.*, u.name as author_name FROM task_comments tc LEFT JOIN users u ON tc.user_id=u.id WHERE tc.task_id=$1 ORDER BY tc.created_at ASC`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/comments', async (req, res) => {
  const { user_id, comment_text } = req.body;
  if (!comment_text) return res.status(400).json({ error: 'Comment required.' });
  try {
    const { rows } = await pool.query('INSERT INTO task_comments (task_id, user_id, comment) VALUES ($1,$2,$3) RETURNING *', [req.params.id, user_id, comment_text]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// SERVE FRONTEND
// ============================================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => console.log('MEU Global CRM running on port ' + port));
