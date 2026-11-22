import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db-postgres.js';
import { authenticate, requireRole } from '../auth-postgres.js';
import { wrap, bad, notFound, conflict, parseId, audit, notify, pad } from '../util-postgres.js';
import { createPaymentForTimesheet } from '../services-postgres.js';

export const router = Router();
router.use(authenticate);

const BASE = `
  SELECT d.*, u.name AS raised_by_name, u.role AS raised_by_role
  FROM disputes d
  JOIN users u ON u.id = d.raised_by
`;

const shape = d => ({
  ...d,
  code: pad('DSP', d.id),
  timesheet_code: d.timesheet_id ? pad('TS', d.timesheet_id) : null
});

router.get('/', wrap(async (req, res) => {
  const rows = req.user.role === 'admin'
    ? await query(`${BASE} ORDER BY d.id DESC`)
    : await query(`${BASE} WHERE d.raised_by = $1 ORDER BY d.id DESC`, [req.user.id]);

  res.json({ disputes: rows.rows.map(shape) });
}));

router.post('/', requireRole('worker', 'business'), wrap(async (req, res) => {
  const d = z.object({
    subject: z.string().trim().min(3).max(120),
    description: z.string().trim().max(1000).optional()
  }).parse(req.body);

  const result = await query(
    `INSERT INTO disputes (raised_by, subject, description)
     VALUES ($1, $2, $3) RETURNING id`,
    [req.user.id, d.subject, d.description ?? null]
  );

  const id = result.rows[0].id;
  await audit(req, 'dispute.create', 'dispute', id, d.subject);

  res.status(201).json({ ok: true, id });
}));

router.post('/:id/start', requireRole('admin'), wrap(async (req, res) => {
  const id = parseId(req.params.id);

  await tx(async client => {
    const result = await client.query(
      'SELECT * FROM disputes WHERE id = $1 FOR UPDATE',
      [id]
    );

    const d = result.rows[0];
    if (!d) throw notFound('Dispute not found');
    if (d.status !== 'Open') throw conflict('Dispute is already being handled');

    await client.query(
      `UPDATE disputes
       SET status = 'In progress', updated_at = NOW()
       WHERE id = $1`,
      [d.id]
    );
  });

  await audit(req, 'dispute.start', 'dispute', id);
  res.json({ ok: true });
}));

// Outcome: approve_as_is | adjust_hours | close
router.post('/:id/resolve', requireRole('admin'), wrap(async (req, res) => {
  const b = z.object({
    outcome: z.enum(['approve_as_is', 'adjust_hours', 'close']),
    hours: z.coerce.number().min(0).max(24).optional(),
    resolution: z.string().trim().min(3, 'Please add a resolution note').max(500)
  }).parse(req.body);

  const id = parseId(req.params.id);
  let raisedBy;

  await tx(async client => {
    const disputeResult = await client.query(
      'SELECT * FROM disputes WHERE id = $1 FOR UPDATE',
      [id]
    );

    const d = disputeResult.rows[0];
    if (!d) throw notFound('Dispute not found');
    if (d.status === 'Resolved') throw conflict('Dispute is already resolved');

    raisedBy = d.raised_by;

    if (b.outcome !== 'close') {
      if (!d.timesheet_id) {
        throw bad('This dispute is not linked to a timesheet');
      }

      const tsResult = await client.query(
        'SELECT * FROM timesheets WHERE id = $1 FOR UPDATE',
        [d.timesheet_id]
      );

      let ts = tsResult.rows[0];
      if (!ts) throw notFound('Timesheet not found');

      if (b.outcome === 'adjust_hours') {
        if (b.hours == null) {
          throw bad('Hours are required to adjust a timesheet');
        }

        const amount = Math.round(b.hours * Number(ts.rate));

        await client.query(
          'UPDATE timesheets SET hours = $1, amount = $2 WHERE id = $3',
          [b.hours, amount, ts.id]
        );
      }

      await client.query(
        `UPDATE timesheets
         SET status = 'Approved', decided_at = NOW()
         WHERE id = $1`,
        [ts.id]
      );

      const updated = await client.query(
        'SELECT * FROM timesheets WHERE id = $1',
        [ts.id]
      );

      ts = updated.rows[0];
      await createPaymentForTimesheet(ts);
    }

    await client.query(
      `UPDATE disputes
       SET status = 'Resolved',
           resolution = $1,
           resolved_by = $2,
           updated_at = NOW()
       WHERE id = $3`,
      [b.resolution, req.user.id, d.id]
    );
  });

  await notify(
    raisedBy,
    `Your dispute ${pad('DSP', id)} was resolved: ${b.resolution}`
  );

  await audit(req, 'dispute.resolve', 'dispute', id, b.outcome);
  res.json({ ok: true });
}));

