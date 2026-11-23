import { DatabaseSync } from 'node:sqlite';
import { query, pool } from './server/src/db-postgres.js';

const db = new DatabaseSync(
  'server/data/hstaff-before-supabase-migration.db',
  { readOnly: true }
);

try {
  const source = db.prepare(
    'SELECT id, email, role, password_hash FROM users'
  ).all();

  const target = (await query(
    'SELECT id, email, role, password_hash FROM public.users'
  )).rows;

  console.log('===== SAFE ACCOUNT MATCH REPORT =====');

  for (const user of source) {
    const matches = target.filter(
      u => u.email?.toLowerCase() === user.email?.toLowerCase()
    );

    console.log({
      sqlite_id: user.id,
      sqlite_role: user.role,
      matching_supabase_accounts: matches.map(u => ({
        supabase_id: u.id,
        supabase_role: u.role,
        same_password_hash: u.password_hash === user.password_hash
      }))
    });
  }

  console.log('\nNo passwords or email addresses were displayed.');
} finally {
  db.close();
  await pool.end();
}
