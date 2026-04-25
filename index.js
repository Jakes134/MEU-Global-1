const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function checkDatabase() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('✅ CRM Connection Successful!');
    console.log('Current DB Time:', res.rows[0].now);
  } catch (err) {
    console.error('❌ Database connection error:', err);
  } finally {
    await pool.end();
  }
}

checkDatabase();

