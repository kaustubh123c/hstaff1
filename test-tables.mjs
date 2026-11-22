import { query, pool } from './server/src/db-postgres.js';

try {
  const result = await query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  console.log('Total tables:', result.rows.length);
  console.table(result.rows);

} catch (error) {
  console.error('Database error:', error.message);
} finally {
  await pool.end();
}