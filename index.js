require(‘dotenv’).config();
const express = require(‘express’);
const path    = require(‘path’);
const { Pool } = require(‘pg’);
const bcrypt  = require(‘bcryptjs’);

const app  = express();
const port = process.env.PORT || 8080;

app.set(‘trust proxy’, 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, ‘public’)));

const dbUrl = process.env.DATABASE_URL
? process.env.DATABASE_URL.replace(/[?&]sslmode=\w+/g, ‘’)
: undefined;

const pool = new Pool({
connectionString: dbUrl,
ssl: { rejectUnauthorized: false }
});

pool.query(‘SELECT NOW()’)
.then(r  => console.log(‘PostgreSQL connected at’, r.rows[0].now))
.catch(e => console.error(‘PostgreSQL connection FAILED:’, e.message));

// QUICK DB PATCH
app.get(’/fix-db’, async (req, res) => {
if (!process.env.SETUP_SECRET || req.query.secret !== process.env.SETUP_SECRET) {
return res.status(403).send(‘Forbidden’);
}
try {
const patches = [
`ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100)`,
`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user'`,
`ALTER TABLE users ADD COLUMN IF NOT EXISTS client_id INTEGER`,
`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT TRUE`,
`ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE`,
`ALTER TABLE posts ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending'`,
`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by INTEGER`,
`CREATE TABLE IF NOT EXISTS task_comments ( id SERIAL PRIMARY KEY, task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id), comment TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP )`,
];
for (const sql of patches) await pool.query(sql);
res.send(’<pre>All columns patched successfully.</pre>’);
} catch (err) {
res.status(500).send(’<pre>Patch failed: ’ + err.message + ‘</pre>’);
}
});

// SETUP DB
app.get(’/setup-db’, async (req, res) => {
if (!process.env.SETUP_SECRET || req.query.secret !== process.env.SETUP_SECRET) {
return res.status(403).send(‘Forbidden’);
}
try {
await pool.query(`CREATE TABLE IF NOT EXISTS users ( id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE NOT NULL, password TEXT NOT NULL, role VARCHAR(20) DEFAULT 'user', client_id INTEGER, must_change_password BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP )`);
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100)`);
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user'`);
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS client_id INTEGER`);
await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT TRUE`);

```
await pool.query(`
  CREATE TABLE IF NOT EXISTS clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'Active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

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
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);
await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE`);
await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'pending'`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS tasks (
    id SERIAL PRIMARY KEY,
    client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
    assigned_to INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT,
    status VARCHAR(20) DEFAULT 'todo',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);
await pool.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by INTEGER`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS task_comments (
    id SERIAL PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    comment TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

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

res.send('<pre>Database synchronized successfully.</pre>');
```

} catch (err) {
res.status(500).send(’<pre>Setup failed: ’ + err.message + ‘</pre>’);
}
});

// AUTH
app.post(’/api/login’, async (req, res) => {
const { email, password } = req.body;
if (!email || !password) return res.status(400).json({ error: ‘Email and password required.’ });
try {
const { rows } = await pool.query(‘SELECT * FROM users WHERE email = $1’, [email.toLowerCase().trim()]);
if (rows.length === 0) return res.status(401).json({ error: ‘Invalid credentials.’ });
const user = rows[0];
const isMatch = await bcrypt.compare(password, user.password);
if (!isMatch) return res.status(401).json({ error: ‘Invalid credentials.’ });
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
console.error(‘Login error:’, err);
res.status(500).json({ error: ‘Server error’ });
}
});

app.post(’/api/change-password’, async (req, res) => {
const { userId, newPassword } = req.body;
if (!userId || !newPassword) return res.status(400).json({ error: ‘Missing fields.’ });
try {
const hashed = await bcrypt.hash(newPassword, 12);
await pool.query(‘UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2’, [hashed, userId]);
res.json({ success: true });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ADMIN USER MANAGEMENT
app.post(’/api/admin/add-user’, async (req, res) => {
const { name, email, role, client_id, password } = req.body;
if (!name || !email) return res.status(400).json({ error: ‘Name and Email are required.’ });
try {
const rawPassword = (password && password.trim()) ? password : ‘ChangeMe123!’;
const hashed = await bcrypt.hash(rawPassword, 12);
const result = await pool.query(
`INSERT INTO users (name, email, password, role, client_id, must_change_password) VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, name, email, role`,
[name.trim(), email.toLowerCase().trim(), hashed, role || ‘user’, client_id || null]
);
res.status(201).json({ success: true, user: result.rows[0] });
} catch (err) {
if (err.code === ‘23505’) return res.status(409).json({ error: ‘A user with this email already exists.’ });
console.error(‘Add user error:’, err);
res.status(500).json({ error: err.message });
}
});

app.get(’/api/admin/users’, async (req, res) => {
try {
const { rows } = await pool.query(
`SELECT u.id, u.name, u.email, u.role, u.client_id, c.name as client_name, u.created_at FROM users u LEFT JOIN clients c ON u.client_id = c.id ORDER BY u.created_at DESC`
);
res.json(rows);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.delete(’/api/admin/users/:id’, async (req, res) => {
try {
await pool.query(‘DELETE FROM users WHERE id = $1’, [req.params.id]);
res.json({ success: true });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/api/users/assignable’, async (req, res) => {
try {
const { rows } = await pool.query(
“SELECT id, name, email, role FROM users WHERE role IN (‘user’, ‘admin’) ORDER BY name ASC”
);
res.json(rows);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// CLIENTS
app.get(’/api/clients’, async (req, res) => {
try {
const { rows } = await pool.query(‘SELECT * FROM clients ORDER BY name ASC’);
res.json(rows);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post(’/api/clients’, async (req, res) => {
const { name, email } = req.body;
try {
const { rows } = await pool.query(
‘INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING *’,
[name, email]
);
res.json(rows[0]);
} catch (err) {
if (err.code === ‘23505’) return res.status(409).json({ error: ‘Client email already exists.’ });
res.status(500).json({ error: err.message });
}
});

// POSTS
app.get(’/api/posts’, async (req, res) => {
const { month, year, client_id } = req.query;
let query = `SELECT p.*, c.name as client_name, u.name as creator_name FROM posts p LEFT JOIN clients c ON p.client_id = c.id LEFT JOIN users u ON p.created_by = u.id WHERE 1=1`;
const params = [];
if (month && year) {
params.push(year, month);
query += ` AND EXTRACT(YEAR FROM p.post_date) = $${params.length - 1} AND EXTRACT(MONTH FROM p.post_date) = $${params.length}`;
}
if (client_id && client_id !== ‘null’) {
params.push(client_id);
query += ` AND p.client_id = $${params.length}`;
}
query += ’ ORDER BY p.post_date ASC, p.post_time ASC’;
try {
const { rows } = await pool.query(query, params);
res.json(rows);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post(’/api/posts’, async (req, res) => {
const { client_id, title, caption, platforms, post_date, post_time, status, created_by } = req.body;
if (!title || !post_date) return res.status(400).json({ error: ‘Title and post date are required.’ });
try {
const { rows } = await pool.query(
`INSERT INTO posts (client_id, title, caption, platforms, post_date, post_time, status, approval_status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) RETURNING *`,
[client_id || null, title, caption, platforms, post_date, post_time || null, status || ‘draft’, created_by]
);
res.json(rows[0]);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.put(’/api/posts/:id/approve’, async (req, res) => {
const { approved } = req.body;
const approvalStatus = approved ? ‘approved’ : ‘rejected’;
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

app.get(’/api/posts/pending-approval’, async (req, res) => {
const { client_id } = req.query;
try {
let query = `SELECT p.*, c.name as client_name, u.name as creator_name FROM posts p LEFT JOIN clients c ON p.client_id = c.id LEFT JOIN users u ON p.created_by = u.id WHERE p.approval_status = 'pending'`;
const params = [];
if (client_id) {
params.push(client_id);
query += ` AND p.client_id = $${params.length}`;
}
query += ’ ORDER BY p.created_at DESC’;
const { rows } = await pool.query(query, params);
res.json(rows);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// TASKS
app.get(’/api/tasks’, async (req, res) => {
const { role, client_id, user_id } = req.query;
let query = `SELECT t.*, u.name as assignee_name, c.name as client_name, cb.name as creator_name FROM tasks t LEFT JOIN users u ON t.assigned_to = u.id LEFT JOIN clients c ON t.client_id = c.id LEFT JOIN users cb ON t.created_by = cb.id WHERE 1=1`;
const params = [];
if (role === ‘client_owner’ && client_id) {
params.push(client_id);
query += ` AND t.client_id = $${params.length}`;
} else if (role === ‘user’ && user_id) {
params.push(user_id);
query += ` AND t.assigned_to = $${params.length}`;
}
query += ’ ORDER BY t.created_at DESC’;
try {
const { rows } = await pool.query(query, params);
res.json(rows);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post(’/api/tasks’, async (req, res) => {
const { client_id, assigned_to, title, description, created_by } = req.body;
if (!title) return res.status(400).json({ error: ‘Title is required.’ });
try {
const { rows } = await pool.query(
`INSERT INTO tasks (client_id, assigned_to, title, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
[client_id || null, assigned_to || null, title, description || ‘’, created_by || null]
);
res.json(rows[0]);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.put(’/api/tasks/:id/status’, async (req, res) => {
const { status } = req.body;
try {
await pool.query(‘UPDATE tasks SET status = $1 WHERE id = $2’, [status, req.params.id]);
res.json({ success: true });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.delete(’/api/tasks/:id’, async (req, res) => {
try {
await pool.query(‘DELETE FROM tasks WHERE id = $1’, [req.params.id]);
res.json({ success: true });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/api/tasks/:id/comments’, async (req, res) => {
try {
const { rows } = await pool.query(
`SELECT tc.*, u.name as author_name, u.role as author_role FROM task_comments tc LEFT JOIN users u ON tc.user_id = u.id WHERE tc.task_id = $1 ORDER BY tc.created_at ASC`,
[req.params.id]
);
res.json(rows);
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.post(’/api/tasks/:id/comments’, async (req, res) => {
const { user_id, comment } = req.body;
if (!comment) return res.status(400).json({ error: ‘Comment is required.’ });
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

// CATCH-ALL
app.get(’*’, (req, res) => {
res.sendFile(path.join(__dirname, ‘index.html’));
});

app.listen(port, () => {
console.log(’MEU Global CRM running on port ’ + port);
});
