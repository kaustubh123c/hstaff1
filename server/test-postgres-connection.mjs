import pg from 'pg';

process.loadEnvFile(new URL('./.env', import.meta.url));

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing from server/.env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000
});

try {
  const result = await pool.query(
    'SELECT current_database() AS database_name, current_user AS database_user'
  );

  console.log('Supabase PostgreSQL connection successful!');
  console.log('Database:', result.rows[0].database_name);
  console.log('Connected user:', result.rows[0].database_user);
} catch (error) {
  console.error('Connection failed.');
  console.error('Error code:', error.code || 'Unknown');
  console.error('Message:', error.message);
} finally {
  await pool.end();
}
