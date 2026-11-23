import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db-postgres.js';
import { authenticate, requireRole } from '../auth-postgres.js';
import { wrap, serializeShift, SHIFT_SELECT } from '../util-postgres.js';

export const router = Router();

router.get('/meta', (_req, res) => res.json({
  name: 'H-Staff',
  demo: config.demoMode,
  requireKycToApply: config.requireKycToApply,
  clockInEarlyMinutes: config.clockInEarlyMinutes,
  razorpayConfigured: config.razorpayEnabled
}));

router.use(authenticate);

// ---- dashboards ------------------------------------------------------------
router.get('/dashboard', wrap(async (req, res) => {
  const { role, id } = req.user;

  if (role === 'business') {
    const [
      active, needWorkers, positions, filled, tsTotal, tsDone,
      totalWorkers, pendingTimesheets, totalPayments, pendingApplications,
      recent
    ] = await Promise.all([
      query("SELECT COUNT(*)::int AS c FROM shifts WHERE business_id=$1 AND status IN ('Open','Filled','Ongoing')", [id]),
      query("SELECT COUNT(*)::int AS c FROM shifts WHERE business_id=$1 AND status='Open'", [id]),
      query("SELECT COALESCE(SUM(workers_needed),0) AS n FROM shifts WHERE business_id=$1 AND status IN ('Open','Filled','Ongoing')", [id]),
      query("SELECT COUNT(*)::int AS c FROM applications a JOIN shifts s ON s.id=a.shift_id WHERE s.business_id=$1 AND a.status='Accepted' AND s.status IN ('Open','Filled','Ongoing')", [id]),
      query('SELECT COUNT(*)::int AS c FROM timesheets t JOIN shifts s ON s.id=t.shift_id WHERE s.business_id=$1', [id]),
      query("SELECT COUNT(*)::int AS c FROM timesheets t JOIN shifts s ON s.id=t.shift_id WHERE s.business_id=$1 AND t.status IN ('Approved','Paid')", [id]),
      query("SELECT COUNT(DISTINCT a.worker_id)::int AS c FROM applications a JOIN shifts s ON s.id=a.shift_id WHERE s.business_id=$1 AND a.status='Accepted'", [id]),
      query("SELECT COUNT(*)::int AS c FROM timesheets t JOIN shifts s ON s.id=t.shift_id WHERE s.business_id=$1 AND t.status='Pending'", [id]),
      query('SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE business_id=$1', [id]),
      query("SELECT COUNT(*)::int AS c FROM applications a JOIN shifts s ON s.id=a.shift_id WHERE s.business_id=$1 AND a.status='Applied'", [id]),
      query(`${SHIFT_SELECT} WHERE s.business_id=$1 ORDER BY s.id DESC LIMIT 4`, [id])
    ]);

    return res.json({
      stats: {
        active_shifts: active.rows[0].c,
        need_workers: needWorkers.rows[0].c,
        total_workers: totalWorkers.rows[0].c,
        pending_timesheets: pendingTimesheets.rows[0].c,
        total_payments: totalPayments.rows[0].n,
        pending_applications: pendingApplications.rows[0].c
      },
      progress: {
        positions: positions.rows[0].n,
        filled: filled.rows[0].c,
        timesheets_total: tsTotal.rows[0].c,
        timesheets_done: tsDone.rows[0].c
      },
      recent_shifts: recent.rows.map(serializeShift)
    });
  }

  if (role === 'worker') {
    const [
      worker, available, mine, upcoming, completed, recommended
    ] = await Promise.all([
      query('SELECT kyc_status, rating FROM workers WHERE user_id=$1', [id]),
      query(`SELECT COUNT(*)::int AS c FROM shifts s
             WHERE s.status='Open' AND NOT EXISTS (
               SELECT 1 FROM applications a
               WHERE a.shift_id=s.id AND a.worker_id=$1 AND a.status!='Withdrawn'
             )`, [id]),
      query(`SELECT COUNT(*)::int AS c FROM applications a
             JOIN shifts s ON s.id=a.shift_id
             WHERE a.worker_id=$1 AND a.status IN ('Applied','Accepted')
             AND s.status IN ('Open','Filled','Ongoing')`, [id]),
      query(`SELECT COUNT(*)::int AS c FROM applications a
             JOIN shifts s ON s.id=a.shift_id
             WHERE a.worker_id=$1 AND a.status='Accepted'
             AND s.status IN ('Filled','Ongoing')`, [id]),
      query("SELECT COUNT(*)::int AS c FROM timesheets WHERE worker_id=$1 AND status IN ('Approved','Paid')", [id]),
      query(`${SHIFT_SELECT}
             WHERE s.status='Open' AND NOT EXISTS (
               SELECT 1 FROM applications a
               WHERE a.shift_id=s.id AND a.worker_id=$1 AND a.status!='Withdrawn'
             )
             ORDER BY s.date, s.start_time LIMIT 3`, [id])
    ]);

    const w = worker.rows[0] || {};
    const suggestions = recommended.rows.map(s => {
      const o = serializeShift(s);
      delete o.rate;
      return o;
    });

    return res.json({
      stats: {
        available_shifts: available.rows[0].c,
        my_shifts: mine.rows[0].c,
        upcoming: upcoming.rows[0].c,
        completed_shifts: completed.rows[0].c
      },
      kyc_status: w.kyc_status ?? null,
      rating: w.rating ?? null,
      recommended: suggestions
    });
  }

  const [
    workers, businesses, active, pendingKyc, disputes, payments, registrations
  ] = await Promise.all([
    query("SELECT COUNT(*)::int AS c FROM users WHERE role='worker'"),
    query("SELECT COUNT(*)::int AS c FROM users WHERE role='business'"),
    query("SELECT COUNT(*)::int AS c FROM shifts WHERE status IN ('Open','Filled','Ongoing')"),
    query("SELECT COUNT(DISTINCT worker_id)::int AS c FROM kyc_documents WHERE status='Pending'"),
    query("SELECT COUNT(*)::int AS c FROM disputes WHERE status!='Resolved'"),
    query("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE status='Pending'"),
    query(`SELECT u.id, u.name, u.role, u.created_at,
                  CASE WHEN u.role='worker' THEN w.kyc_status ELSE u.status END AS status
           FROM users u LEFT JOIN workers w ON w.user_id=u.id
           WHERE u.role!='admin' ORDER BY u.id DESC LIMIT 5`)
  ]);

  res.json({
    stats: {
      total_workers: workers.rows[0].c,
      total_businesses: businesses.rows[0].c,
      active_shifts: active.rows[0].c,
      pending_kyc: pendingKyc.rows[0].c,
      open_disputes: disputes.rows[0].c,
      pending_payments: payments.rows[0].n
    },
    recent_registrations: registrations.rows
  });
}));

// ---- people directories ----------------------------------------------------
router.get('/workers', requireRole('business', 'admin'), wrap(async (req, res) => {
  const base = `
    SELECT u.id, u.name, u.phone, u.status, u.created_at,
           w.skills, w.location, w.rating, w.kyc_status
    FROM users u JOIN workers w ON w.user_id=u.id
  `;

  const result = req.user.role === 'admin'
    ? await query(`${base} ORDER BY u.name`)
    : await query(`${base}
        WHERE u.id IN (
          SELECT a.worker_id FROM applications a
          JOIN shifts s ON s.id=a.shift_id
          WHERE s.business_id=$1 AND a.status IN ('Applied','Accepted')
        )
        ORDER BY u.name`, [req.user.id]);

  res.json({
    workers: req.user.role === 'admin'
      ? result.rows
      : result.rows.map(({ phone, ...r }) => r)
  });
}));

router.get('/businesses', requireRole('admin'), wrap(async (_req, res) => {
  const result = await query(`
    SELECT u.id, u.name, u.email, u.phone, u.status, u.created_at,
           b.company, b.address,
           (SELECT COUNT(*)::int FROM shifts s WHERE s.business_id=u.id) AS shifts
    FROM users u JOIN businesses b ON b.user_id=u.id
    ORDER BY b.company
  `);

  res.json({ businesses: result.rows });
}));

// ---- notifications ---------------------------------------------------------
router.get('/notifications', wrap(async (req, res) => {
  const [unread, notifications] = await Promise.all([
    query('SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND read=0', [req.user.id]),
    query('SELECT id, message, read, created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [req.user.id])
  ]);

  res.json({
    unread: unread.rows[0].c,
    notifications: notifications.rows
  });
}));

router.post('/notifications/read', wrap(async (req, res) => {
  await query('UPDATE notifications SET read=1 WHERE user_id=$1', [req.user.id]);
  res.json({ ok: true });
}));

