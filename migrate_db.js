require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('Renaming columns in Supabase database...');
  try {
    await pool.query(`ALTER TABLE se_catalog.draping_models RENAME COLUMN left_base_url TO sitting_base_url`);
    await pool.query(`ALTER TABLE se_catalog.draping_models RENAME COLUMN right_base_url TO side_base_url`);
    console.log('✅ Columns renamed successfully!');
  } catch (err) {
    console.error('❌ Error renaming columns:', err.message);
  } finally {
    await pool.end();
  }
}

main();
