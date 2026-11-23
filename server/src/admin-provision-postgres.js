
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { tx } from './db-postgres.js';

const adminSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().email().max(254),
  password: z.string().min(12).max(100),
});

export async function createAdminAccountPostgres(
  input,
  { source = 'private provisioning command' } = {}
) {
  const { name, email, password } = adminSchema.parse(input);
  const passwordHash = await bcrypt.hash(password, 12);

  return tx(async client => {
    const existing = await client.query(
      'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (existing.rowCount) {
      throw new Error(
        'That email already belongs to an account. No records were changed.'
      );
    }

    const result = await client.query(
      `INSERT INTO users (email, password_hash, role, name)
       VALUES ($1, $2, 'admin', $3)
       RETURNING id`,
      [email, passwordHash, name]
    );

    const id = result.rows[0].id;

    await client.query(
      `INSERT INTO audit_logs (action, entity, entity_id, detail)
       VALUES ($1, $2, $3, $4)`,
      ['admin.provision', 'user', String(id), `Created by ${source}`]
    );

    return id;
  });
}
