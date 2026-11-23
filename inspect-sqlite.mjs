import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(
  'server/data/hstaff-before-supabase-migration.db',
  { readOnly: true }
);

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all();

for (const table of tables) {
  console.log('\nTABLE: ' + table.name);

  const columns = db.prepare(
    `PRAGMA table_info("${table.name}")`
  ).all();

  console.log(columns.map(c => `${c.name} (${c.type})`).join(', '));
}

db.close();
