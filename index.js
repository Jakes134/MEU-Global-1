const express = require('express');
const { Pool } = require('pg');
const app = express();
const port = process.env.PORT || 8080;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.get('/', async (req, res) => {
  try {
    const dbRes = await pool.query('SELECT NOW()');
    res.send(`✅ MEU Global CRM is LIVE. DB Time: ${dbRes.rows[0].now}`);
  } catch (err) {
    res.status(500).send(`❌ Connection Error: ${err.message}`);
  }
});

app.listen(port, () => {
  console.log(`🚀 CRM Engine running on port ${port}`);
});
