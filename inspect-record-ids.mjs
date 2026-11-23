import { DatabaseSync } from 'node:sqlite';
import { query, pool } from './server/src/db-postgres.js';

const db = new DatabaseSync(
  'server/data/hstaff-before-supabase-migration.db',
  { readOnly: true }
);

try {
  console.log('\n===== SQLITE SOURCE =====');

  for (const table of ['users', 'businesses', 'workers', 'shifts', 'audit_logs']) {
    console.log('\n' + table);
    console.log(db.prepare(`SELECT * FROM "${table}"`).all().map(row => {
      if (table === 'users') return { id: row.id, role: row.role, status: row.status };
      if (table === 'audit_logs') return { id: row.id, user_id: row.user_id, action: row.action };
      return row;
    }));
  }

  console.log('\n===== EXISTING SUPABASE RECORDS =====');

  for (const table of ['users', 'businesses', 'workers', 'shifts', 'audit_logs']) {
    const result = await query(`SELECT * FROM public."${table}"`);

    console.log('\n' + table);
    console.log(result.rows.map(row => {
      if (table === 'users') return { id: row.id, role: row.role, status: row.status };
      if (table === 'audit_logs') return { id: row.id, user_id: row.user_id, action: row.action };
      return row;
    }));
  }

  console.log('\nID inspection completed.');
} finally {
  db.close();
  await pool.end();
}
