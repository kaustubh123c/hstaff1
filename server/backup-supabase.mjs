import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

process.loadEnvFile('.env');

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

try {
  const result = await pool.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  const backup = {
    createdAt: new Date().toISOString(),
    database: 'Supabase PostgreSQL',
    tables: {}
  };

  for (const { tablename } of result.rows) {
    const safeName = tablename.replace(/"/g, '""');
    const rows = await pool.query(`SELECT * FROM public."${safeName}"`);
    backup.tables[tablename] = rows.rows;
    console.log(`${tablename}: ${rows.rowCount} rows backed up`);
  }

  const folder = path.join(process.cwd(), 'data');
  fs.mkdirSync(folder, { recursive: true });

  const filename = `supabase-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filepath = path.join(folder, filename);

  fs.writeFileSync(filepath, JSON.stringify(backup, null, 2), 'utf8');

  console.log('\nBACKUP CREATED SUCCESSFULLY');
  console.log(filepath);
  console.log(`Tables backed up: ${result.rowCount}`);
} catch (error) {
  console.error('BACKUP FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
