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
//  SYSTEM SETUP & MIGRATIONS
// ─────────────────────────────────────────────
app.get('/setup-db', async (req, res) => {
  if (!process.env.SETUP_SECRET || req.query.secret !== process.env.SETUP_SECRET) {
    return res.status(403).send('Forbidden – provide ?secret=YOUR_SETUP_SECRET');
  }
  try {
    // 1. Users Table
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

    // 2. Clients Table (Main Clients)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Products Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        price DECIMAL(12,2) NOT NULL,
        billing_type VARCHAR(20) DEFAULT 'one-off',
        duration_months INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. End Customers Table (Clients of Clients)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS end_customers (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100),
        status VARCHAR(30) DEFAULT 'Contract Review',
        sign_up_date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 5. Posts Table
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
        approval_status VARCHAR(20) DEFAULT 'pending',
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 6. Tasks Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'todo',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 7. Task Comments Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_comments (
        id SERIAL PRIMARY KEY,
        task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        comment TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ─────────────────────────────────────────────────────────────────
    //  CONSTRAINT MIGRATION (Ensures existing tables allow user deletion)
    // ─────────────────────────────────────────────────────────────────
    // Posts
    await pool.query(`ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_created_by_fkey;`);
    await pool.query(`ALTER TABLE posts ADD CONSTRAINT posts_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;`);
    
    // Tasks
    await pool.query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_assigned_to_fkey;`);
    await pool.query(`ALTER TABLE tasks ADD CONSTRAINT tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL;`);
    await pool.query(`ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_created_by_fkey;`);
    await pool.query(`ALTER TABLE tasks ADD CONSTRAINT tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;`);

    // Task Comments
    await pool.query(`ALTER TABLE task_comments DROP CONSTRAINT IF EXISTS task_comments_user_id_fkey;`);
    await pool.query(`ALTER TABLE task_comments ADD CONSTRAINT task_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;`);

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

    res.send('<pre>✅ Database is synchronized. Constraint migration complete: you can now delete users without restriction.</pre>');
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
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
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
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/change-password', async (req, res) => {
  const { userId, newPassword } = req.body;
  if (!userId || !newPassword) return res.status(400).json({ error: 'Missing fields.' });
  try {
    const hashed = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2', [hashed, userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  ADMIN USER MANAGEMENT
// ─────────────────────────────────────────────
app.post('/api/admin/add-user', async (req, res) => {
  const { name, email, role, client_id, password } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and Email are required.' });

  try {
    const rawPassword = password && password.trim() ? password : 'ChangeMe123!';
    const hashed = await bcrypt.hash(rawPassword, 12);
    const result = await pool.query(
      `INSERT INTO users (name, email, password, role, client_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, name, email, role`,
      [name.trim(), email.toLowerCase().trim(), hashed, role || 'user', client_id || null]
    );
    res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with this email already exists.' });
    console.error('Add user error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.client_id, c.name as client_name, u.created_at
       FROM users u LEFT JOIN clients c ON u.client_id = c.id
       ORDER BY u.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: err.message });
  }
});

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
  try {
    const { rows } = await pool.query('SELECT * FROM clients ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients', async (req, res) => {
  const { name, email } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Client email already exists.' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/clients/:id', async (req, res) => {
  const { name, email, status } = req.body;
  try {
    await pool.query(
      'UPDATE clients SET name=$1, email=$2, status=$3 WHERE id=$4',
      [name, email, status, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  PRODUCTS API
// ─────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  const { client_id } = req.query;
  try {
    let q = 'SELECT * FROM products';
    const p = [];
    if (client_id) { q += ' WHERE client_id = $1'; p.push(client_id); }
    const { rows } = await pool.query(q + ' ORDER BY name ASC', p);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', async (req, res) => {
  const { client_id, name, price, billing_type, duration_months } = req.body;
  if (!client_id) return res.status(400).json({ error: 'Client selection is required.' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO products (client_id, name, price, billing_type, duration_months) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [client_id, name, price, billing_type, duration_months]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Product save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  END CUSTOMERS API
// ─────────────────────────────────────────────
app.get('/api/end-customers', async (req, res) => {
  const { client_id } = req.query;
  try {
    let q = `SELECT ec.*, p.name as product_name, p.price as product_price, p.billing_type 
             FROM end_customers ec 
             LEFT JOIN products p ON ec.product_id = p.id 
             WHERE 1=1`;
    const p = [];
    if (client_id) { q += ' AND ec.client_id = $1'; p.push(client_id); }
    const { rows } = await pool.query(q + ' ORDER BY ec.sign_up_date DESC', p);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/end-customers', async (req, res) => {
  const { client_id, product_id, name, email, status } = req.body;
  try {
    const { rows } = await pool.query(
      'INSERT INTO end_customers (client_id, product_id, name, email, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [client_id, product_id, name, email, status]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/end-customers/:id', async (req, res) => {
  const { name, email, status, product_id } = req.body;
  try {
    await pool.query(
      'UPDATE end_customers SET name=$1, email=$2, status=$3, product_id=$4 WHERE id=$5',
      [name, email, status, product_id, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  DASHBOARD STATS
// ─────────────────────────────────────────────
app.get('/api/stats/dashboard', async (req, res) => {
  const { client_id } = req.query;
  try {
    const p = client_id ? [client_id] : [];
    const filter = client_id ? ' WHERE client_id = $1' : '';

    const stages = await pool.query(`SELECT status, count(*) FROM end_customers ${filter} GROUP BY status`, p);
    const products = await pool.query(`
      SELECT p.name, count(ec.id) as count 
      FROM products p 
      JOIN end_customers ec ON ec.product_id = p.id 
      ${client_id ? ' WHERE p.client_id = $1' : ''}
      GROUP BY p.name ORDER BY count DESC LIMIT 5`, p);

    res.json({ stages: stages.rows, products: products.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  POSTS API
// ─────────────────────────────────────────────
app.get('/api/posts', async (req, res) => {
  const { month, year, client_id } = req.query;
  try {
    let query = `SELECT p.*, c.name as client_name, u.name as creator_name
                 FROM posts p
                 LEFT JOIN clients c ON p.client_id = c.id
                 LEFT JOIN users u ON p.created_by = u.id
                 WHERE 1=1`;
    const params = [];

    if (month && year) {
      params.push(year, month);
      query += ` AND EXTRACT(YEAR FROM p.post_date) = $${params.length - 1} AND EXTRACT(MONTH FROM p.post_date) = $${params.length}`;
    }

    if (client_id && client_id !== 'null') {
      params.push(client_id);
      query += ` AND p.client_id = $${params.length}`;
    }

    query += ' ORDER BY p.post_date ASC, p.post_time ASC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts', async (req, res) => {
  const { client_id, title, caption, platforms, post_date, post_time, status, created_by } = req.body;
  if (!title || !post_date) return res.status(400).json({ error: 'Title and post date are required.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO posts (client_id, title, caption, platforms, post_date, post_time, status, approval_status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) RETURNING *`,
      [client_id || null, title, caption, platforms, post_date, post_time || null, status || 'draft', created_by]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/posts/:id', async (req, res) => {
  const { title, caption, platforms, post_date, post_time, status } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE posts SET title=$1, caption=$2, platforms=$3, post_date=$4, post_time=$5, status=$6
       WHERE id=$7 RETURNING *`,
      [title, caption, platforms, post_date, post_time || null, status, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/posts/:id/approve', async (req, res) => {
  const { approved } = req.body;
  const approvalStatus = approved ? 'approved' : 'rejected';
  try {
    const { rows } = await pool.query(
      `UPDATE posts SET is_approved=$1, approval_status=$2 WHERE id=$3 RETURNING *`,
      [approved, approvalStatus, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts/pending-approval', async (req, res) => {
  const { client_id } = req.query;
  try {
    let query = `SELECT p.*, c.name as client_name, u.name as creator_name
                 FROM posts p
                 LEFT JOIN clients c ON p.client_id = c.id
                 LEFT JOIN users u ON p.created_by = u.id
                 WHERE p.approval_status = 'pending'`;
    const params = [];
    if (client_id) {
      params.push(client_id);
      query += ` AND p.client_id = $${params.length}`;
    }
    query += ' ORDER BY p.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  TASKS API
// ─────────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
  const { role, client_id, user_id } = req.query;
  try {
    let query = `SELECT t.*, 
                 u.name as assignee_name, 
                 c.name as client_name,
                 cb.name as creator_name
                 FROM tasks t
                 LEFT JOIN users u ON t.assigned_to = u.id
                 LEFT JOIN clients c ON t.client_id = c.id
                 LEFT JOIN users cb ON t.created_by = cb.id
                 WHERE 1=1`;
    const params = [];

    if (role === 'client_owner' && client_id) {
      params.push(client_id);
      query += ` AND t.client_id = $${params.length}`;
    } else if (role === 'user' && user_id) {
      params.push(user_id);
      query += ` AND t.assigned_to = $${params.length}`;
    }

    query += ' ORDER BY t.created_at DESC';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks', async (req, res) => {
  const { client_id, assigned_to, title, description, created_by } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO tasks (client_id, assigned_to, title, description, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [client_id || null, assigned_to || null, title, description || '', created_by || null]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id/status', async (req, res) => {
  const { status } = req.body;
  try {
    await pool.query('UPDATE tasks SET status = $1 WHERE id = $2', [status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id/comments', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tc.*, u.name as author_name, u.role as author_role
       FROM task_comments tc
       LEFT JOIN users u ON tc.user_id = u.id
       WHERE tc.task_id = $1
       ORDER BY tc.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/comments', async (req, res) => {
  const { user_id, comment } = req.body;
  if (!comment) return res.status(400).json({ error: 'Comment is required.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO task_comments (task_id, user_id, comment) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, user_id, comment]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
//  FRONTEND & SERVER
// ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`🚀 MEU Global CRM Engine running on port ${port}`);
});
