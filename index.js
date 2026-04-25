const express = require('express');
const path = require('path'); // Tool to handle file paths
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 8080;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// This line tells Express to serve your index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// We keep this endpoint so the dashboard can check the database later
app.get('/db-check', async (req, res) => {
  try {
    const dbRes = await pool.query('SELECT NOW()');
    res.json({ status: 'success', time: dbRes.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 CRM Engine running on port ${port}`);
});
