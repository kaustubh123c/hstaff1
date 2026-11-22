import { DatabaseSync } from 'node:sqlite';
import { query, pool } from './server/src/db-postgres.js';

const sqlite = new DatabaseSync(
  'server/data/hstaff-before-supabase-migration.db',
  { readOnly: true }
);

try {
  const sourceTables = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();

  const targetResult = await query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);

  const target = new Map();

  for (const row of targetResult.rows) {
    if (!target.has(row.table_name)) target.set(row.table_name, []);
    target.get(row.table_name).push(row.column_name);
  }

  console.log('\n===== SQLITE TO SUPABASE COMPARISON =====');

  for (const table of sourceTables) {
    const name = table.name;
    const sourceColumns = sqlite.prepare(
      `PRAGMA table_info("${name}")`
    ).all().map(c => c.name);

    const targetColumns = target.get(name);

    const sourceCount = sqlite.prepare(
      `SELECT COUNT(*) AS total FROM "${name}"`
    ).get().total;

    if (!targetColumns) {
      console.log(`\n${name}: MISSING IN SUPABASE | SQLite records: ${sourceCount}`);
      continue;
    }

    const missing = sourceColumns.filter(c => !targetColumns.includes(c));
    const extra = targetColumns.filter(c => !sourceColumns.includes(c));

    const targetCountResult = await query(
      `SELECT COUNT(*)::int AS total FROM public."${name}"`
    );

    console.log(`\nTABLE: ${name}`);
    console.log(`SQLite records: ${sourceCount}`);
    console.log(`Supabase records: ${targetCountResult.rows[0].total}`);
    console.log(`SQLite columns missing in Supabase: ${missing.join(', ') || 'None'}`);
    console.log(`Supabase-only columns: ${extra.join(', ') || 'None'}`);
  }

  console.log('\n===== COMPARISON COMPLETE =====');
} finally {
  sqlite.close();
  await pool.end();
}
