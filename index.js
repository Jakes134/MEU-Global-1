require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Optional: for CSS/JS files if separated



// Database Configuration
console.log("DEBUG: DATABASE_URL value starts with:", process.env.DATABASE_URL ? process.env.DATABASE_URL.substring(0, 10) : "Nothing found");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for DigitalOcean Managed Databases
  }
});

/**
 * INITIAL DATABASE SETUP
 * Visit your-url.com/setup-db once after deploying to create the tables.
 */
app.get('/setup-db', async (req, res) => {
  try {
    // Create Users Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(100) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        must_change_password BOOLEAN DEFAULT TRUE
      );
    `);

    // Create Clients Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        status VARCHAR(20) DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    res.send("✅ Database tables initialized successfully.");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Database setup failed: " + err.message);
  }
});

/**
 * AUTHENTICATION ROUTES
 */

// Login Logic
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = userRes.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    res.json({
      success: true,
      mustChange: user.must_change_password,
      userId: user.id
    });
  } catch (err) {
    res.status(500).json({ error: "Server error during login" });
  }
});

// Update Password (Required for first-time sign-in)
app.post('/api/update-password', async (req, res) => {
  const { userId, newPassword } = req.body;
  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await pool.query(
      'UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2',
      [hashedPassword, userId]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update password" });
  }
});

// Add New User (Admin functionality from bottom-left button)
app.post('/api/admin/add-user', async (req, res) => {
  const { email, password } = req.body;
  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await pool.query(
      'INSERT INTO users (email, password, must_change_password) VALUES ($1, $2, TRUE)',
      [email, hashedPassword]
    );

    res.status(201).json({ success: true });
  } catch (err) {
    res.status(400).json({ error: "User already exists or invalid data" });
  }
});

/**
 * CRM CORE ROUTES
 */

// Get Dashboard Stats
app.get('/api/stats', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM clients');
    res.json({ client_count: parseInt(result.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Add a New Client
app.post('/api/clients', async (req, res) => {
  const { name, email } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: "Failed to register client" });
  }
});

/**
 * FRONTEND DELIVERY
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Engine
app.listen(port, () => {
  console.log(`
  🚀 MEU Global CRM Engine Running
  --------------------------------
  Port:    ${port}
  DB:      Connected via PostgreSQL
  Status:  Production Ready
  `);
});
