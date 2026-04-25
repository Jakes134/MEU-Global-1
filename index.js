const { Pool } = require('pg');

// We use the variable you just set in DigitalOcean for security and scaling[span_3](end_span)[span_4](end_span)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for many managed cloud databases
  }
});

async function checkDatabase() {
  try {
    const res = await pool.query('SELECT NOW()');
    console.log('✅ CRM Connection Successful! Current DB Time:', res.rows[0].now);
  } catch (err) {
    console.error('❌ Database connection error:', err);
  } finally {
    await pool.end();
  }
}

checkDatabase();
