import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db-postgres.js';
import { authenticate, requireRole } from '../auth-postgres.js';
import { wrap, bad, notFound, parseId, audit } from '../util-postgres.js';

export const router = Router();
router.use(authenticate, requireRole('admin'));

router.post('/users/:id/status', wrap(async (req, res) => {
  const { status } = z.object({
    status: z.enum(['Active', 'Suspended'])
  }).parse(req.body);

  const id = parseId(req.params.id);
  if (id === req.user.id) throw bad('You cannot change your own account status');

  const result = await query(
    'SELECT id, role FROM users WHERE id = $1',
    [id]
  );

  const u = result.rows[0];
  if (!u) throw notFound('User not found');
  if (u.role === 'admin') throw bad('Admin accounts cannot be suspended here');

  await query('UPDATE users SET status = $1 WHERE id = $2', [status, id]);
  await audit(req, `user.${status.toLowerCase()}`, 'user', id);

  res.json({ ok: true });
}));

router.get('/audit-logs', wrap(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const q = (req.query.q || '').toString();

  const result = await query(
    `SELECT l.id, l.action, l.entity, l.entity_id, l.detail, l.ip,
            l.created_at, u.name AS user_name, u.role AS user_role
     FROM audit_logs l
     LEFT JOIN users u ON u.id = l.user_id
     WHERE ($1 = '' OR l.action ILIKE $2 OR l.detail ILIKE $2 OR u.name ILIKE $2)
     ORDER BY l.id DESC
     LIMIT $3`,
    [q, `%${q}%`, limit]
  );

  res.json({ logs: result.rows });
}));

router.get('/reports', wrap(async (_req, res) => {
  const [
    shifts,
    payments,
    businesses,
    workers,
    totals
  ] = await Promise.all([
    query('SELECT status, COUNT(*)::int AS count FROM shifts GROUP BY status'),
    query(`
      SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
             COUNT(*)::int AS count,
             COALESCE(SUM(amount), 0) AS total,
             COALESCE(SUM(fee), 0) AS fees
      FROM payments
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) DESC
      LIMIT 6
    `),
    query(`
      SELECT b.company, COUNT(s.id)::int AS shifts,
             COALESCE(SUM(s.workers_needed), 0) AS positions
      FROM businesses b
      LEFT JOIN shifts s ON s.business_id = b.user_id
      GROUP BY b.user_id, b.company
      ORDER BY COUNT(s.id) DESC
      LIMIT 5
    `),
    query(`
      SELECT u.name, COUNT(t.id)::int AS shifts,
             COALESCE(SUM(t.hours), 0) AS hours,
             COALESCE(SUM(t.amount), 0) AS earned
      FROM users u
      JOIN timesheets t ON t.worker_id = u.id
      GROUP BY u.id, u.name
      ORDER BY COALESCE(SUM(t.amount), 0) DESC
      LIMIT 5
    `),
    query(`
      SELECT COALESCE(SUM(hours), 0) AS hours,
             COALESCE(SUM(amount), 0) AS amount
      FROM timesheets
      WHERE status IN ('Approved', 'Paid')
    `)
  ]);

  res.json({
    shifts_by_status: shifts.rows,
    payments_by_month: payments.rows,
    top_businesses: businesses.rows,
    top_workers: workers.rows,
    totals: totals.rows[0]
  });
}));

const SETTINGS = {
  support_email: 'support@hstaff.example',
  auto_approve_hours: '24'
};

export async function getSettings() {
  const result = await query('SELECT key, value FROM settings');
  return {
    ...SETTINGS,
    ...Object.fromEntries(result.rows.map(r => [r.key, r.value]))
  };
}

router.get('/settings', wrap(async (_req, res) => {
  res.json({ settings: await getSettings() });
}));

router.put('/settings', wrap(async (req, res) => {
  const d = z.object({
    support_email: z.string().trim().email().optional(),
    auto_approve_hours: z.coerce.number().int().min(0).max(168).optional()
  }).parse(req.body);

  await tx(async client => {
    for (const [k, v] of Object.entries(d)) {
      if (v !== undefined) {
        await client.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [k, String(v)]
        );
      }
    }
  });

  await audit(req, 'settings.update', 'settings', null, JSON.stringify(d));
  res.json({ settings: await getSettings() });
}));
