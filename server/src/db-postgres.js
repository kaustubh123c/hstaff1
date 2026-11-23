
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is missing from server/.env');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Vercel functions scale horizontally; keep each warm instance pool small.
  max: Number(process.env.PG_POOL_MAX || 3),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error.message);
});

// PostgreSQL query helper
export const query = (text, params = []) =>
  pool.query(text, params);

// Transaction helper
export async function tx(callback) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Check the database connection
export async function testPostgresConnection() {
  const result = await query('SELECT current_database() AS database_name');
  return result.rows[0];
}
