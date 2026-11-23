
import { DatabaseSync } from 'node:sqlite';
import { pool } from './server/src/db-postgres.js';

const db = new DatabaseSync(
  'server/data/hstaff-before-supabase-migration.db',
  { readOnly: true }
);

const client = await pool.connect();

async function insertRow(table, columns, values) {
  const names = columns.join(', ');
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

  return client.query(
    `INSERT INTO public.${table} (${names}) VALUES (${placeholders})`,
    values
  );
}

try {
  const users = db.prepare('SELECT * FROM users').all();
  const businesses = db.prepare('SELECT * FROM businesses').all();
  const shifts = db.prepare('SELECT * FROM shifts').all();
  const auditLogs = db.prepare('SELECT * FROM audit_logs').all();

  if (users.length !== 1 || users[0].role !== 'business') {
    throw new Error('Unexpected SQLite user data. Migration stopped.');
  }

  if (businesses.length !== 1 || shifts.length !== 1) {
    throw new Error('Unexpected business or shift data. Migration stopped.');
  }

  await client.query('BEGIN');

  const existing = await client.query(
    'SELECT id FROM public.users WHERE LOWER(email) = LOWER($1)',
    [users[0].email]
  );

  if (existing.rows.length > 0) {
    throw new Error('This email already exists in Supabase. Migration stopped.');
  }

  const targetCounts = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM public.shifts) AS shifts,
      (SELECT COUNT(*) FROM public.audit_logs) AS audit_logs
  `);

  if (
    Number(targetCounts.rows[0].shifts) !== 0 ||
    Number(targetCounts.rows[0].audit_logs) !== 0
  ) {
    throw new Error('Target shifts or audit logs are not empty. Migration stopped.');
  }

  // Create a new Supabase user ID.
  const u = users[0];

  const newUser = await client.query(
    `INSERT INTO public.users
      (email, password_hash, role, name, phone, status, created_at, google_sub)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      u.email, u.password_hash, u.role, u.name,
      u.phone, u.status, u.created_at, u.google_sub
    ]
  );

  const newUserId = newUser.rows[0].id;

  // Copy business profile using the new user ID.
  const b = businesses[0];

  await insertRow(
    'businesses',
    ['user_id', 'company', 'address'],
    [newUserId, b.company, b.address]
  );

  // Copy shift and link it to the new business user.
  const s = shifts[0];

  const shiftColumns = [
    'id', 'business_id', 'title', 'description', 'skills',
    'location', 'lat', 'lng', 'radius_m', 'date',
    'start_time', 'end_time', 'workers_needed', 'rate',
    'status', 'created_at', 'job_type', 'start_otp_hash',
    'finish_otp_hash', 'otp_verified_at', 'worker_lat',
    'worker_lng', 'completion_requested_at'
  ];

  await insertRow(
    'shifts',
    shiftColumns,
    shiftColumns.map(column =>
      column === 'business_id' ? newUserId : s[column]
    )
  );

  // Copy audit logs and replace the old user reference.
  const auditColumns = [
    'id', 'user_id', 'action', 'entity',
    'entity_id', 'detail', 'ip', 'created_at'
  ];

  for (const log of auditLogs) {
    await insertRow(
      'audit_logs',
      auditColumns,
      auditColumns.map(column =>
        column === 'user_id' ? newUserId : log[column]
      )
    );
  }

  // Update sequences after preserving the original shift/log IDs.
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('public.shifts', 'id'),
      (SELECT MAX(id) FROM public.shifts),
      true
    )
  `);

  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('public.audit_logs', 'id'),
      (SELECT MAX(id) FROM public.audit_logs),
      true
    )
  `);

  await client.query('COMMIT');

  console.log('Migration completed successfully.');
  console.log({
    migratedUsers: 1,
    migratedBusinesses: 1,
    migratedShifts: 1,
    migratedAuditLogs: auditLogs.length,
    newSupabaseUserId: newUserId
  });

} catch (error) {
  await client.query('ROLLBACK');
  console.error('Migration stopped. Changes rolled back.');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
  client.release();
  await pool.end();
}
