import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { query, tx } from '../db-postgres.js';
import { config } from '../config.js';
import { authenticate, requireRole } from '../auth-postgres.js';
import {
  wrap, bad, forbidden, notFound, conflict, parseId,
  audit, notify, serializeShift, SHIFT_SELECT, makeQrToken,
  pad, shiftWindow
} from '../util-postgres.js';
import { refreshShiftStatus } from '../services-postgres.js';

export const router = Router();
router.use(authenticate);

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

const shiftSchema = z.object({
  title: z.string().trim().min(2).max(80),
  description: z.string().trim().max(1000).optional().default(''),
  skills: z.union([z.string(), z.array(z.string())]).optional().default('')
    .transform(v => (Array.isArray(v) ? v : v.split(',')).map(x => x.trim()).filter(Boolean).slice(0, 10).join(',')),
  location: z.string().trim().min(2).max(160),
  lat: z.coerce.number().min(-90).max(90).nullish(),
  lng: z.coerce.number().min(-180).max(180).nullish(),
  radius_m: z.coerce.number().int().min(25).max(5000).optional().default(config.defaultGeofenceMeters),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: time,
  end_time: time,
  workers_needed: z.coerce.number().int().min(1).max(100),
  rate: z.coerce.number().int().min(1).max(100000)
})
.refine(d => d.start_time !== d.end_time, {
  message: 'Start and end time must differ',
  path: ['end_time']
})
.refine(d => (d.lat == null) === (d.lng == null), {
  message: 'Provide both latitude and longitude, or leave both blank',
  path: ['lng']
});

async function loadShift(id) {
  const result = await query(`${SHIFT_SELECT} WHERE s.id=$1`, [id]);
  if (!result.rows[0]) throw notFound('Shift not found');
  return result.rows[0];
}

async function ownShift(req, id) {
  const s = await loadShift(id);
  if (req.user.role === 'business' && Number(s.business_id) !== Number(req.user.id)) {
    throw forbidden('This shift belongs to another business');
  }
  if (!['business', 'admin'].includes(req.user.role)) throw forbidden();
  return s;
}

router.get('/', wrap(async (req, res) => {
  const { role, id } = req.user;
  const q = (req.query.q || '').toString().toLowerCase();
  const status = req.query.status?.toString();
  let result;

  if (role === 'business') {
    result = await query(`${SHIFT_SELECT} WHERE s.business_id=$1 ORDER BY s.date DESC,s.id DESC`, [id]);
  } else if (role === 'admin') {
    result = await query(`${SHIFT_SELECT} ORDER BY s.date DESC,s.id DESC`);
  } else if (req.query.scope === 'mine') {
    result = await query(`${SHIFT_SELECT}
      JOIN applications a ON a.shift_id=s.id AND a.worker_id=$1
      ORDER BY s.date DESC`, [id]);
  } else {
    result = await query(`${SHIFT_SELECT}
      WHERE s.status='Open' AND s.job_type != 'ondemand'
      ORDER BY s.date,s.start_time`);
  }

  const out = [];
  for (const s of result.rows) {
    const extra = {};
    if (role === 'worker') {
      const app = await query(
        'SELECT id,status FROM applications WHERE shift_id=$1 AND worker_id=$2',
        [s.id, id]
      );
      const ts = await query(
        'SELECT id,hours,amount,status FROM timesheets WHERE shift_id=$1 AND worker_id=$2',
        [s.id, id]
      );
      extra.my_application = app.rows[0] ?? null;
      extra.my_timesheet = ts.rows[0] ?? null;
    } else {
      const pending = await query(
        "SELECT COUNT(*)::int AS c FROM applications WHERE shift_id=$1 AND status='Applied'",
        [s.id]
      );
      extra.pending_applications = pending.rows[0].c;
    }

    const item = await serializeShift(s, extra);
    if (role === 'worker') {
      delete item.rate;
      delete item.my_timesheet;
    }
    if ((!q || `${item.title} ${item.location} ${item.business}`.toLowerCase().includes(q))
      && (!status || status === 'All' || item.status === status)) out.push(item);
  }

  res.json({ shifts: out });
}));

router.get('/:id', wrap(async (req, res) => {
  const s = await loadShift(parseId(req.params.id));
  if (req.user.role === 'business' && Number(s.business_id) !== Number(req.user.id)) throw forbidden();
  res.json({ shift: await serializeShift(s) });
}));

router.post('/', requireRole('business'), wrap(async (req, res) => {
  const d = shiftSchema.parse(req.body);
  const { start } = shiftWindow(d);
  if (start.getTime() < Date.now() - 24 * 3600000) throw bad('Shift date cannot be in the past');

  const result = await query(
    `INSERT INTO shifts
    (business_id,title,description,skills,location,lat,lng,radius_m,date,start_time,end_time,workers_needed,rate)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING id`,
    [req.user.id,d.title,d.description,d.skills,d.location,d.lat ?? null,d.lng ?? null,
      d.radius_m,d.date,d.start_time,d.end_time,d.workers_needed,d.rate]
  );

  const id = result.rows[0].id;
  await audit(req, 'shift.create', 'shift', id, d.title);
  res.status(201).json({ shift: await serializeShift(await loadShift(id)) });
}));

router.put('/:id', requireRole('business'), wrap(async (req, res) => {
  const s = await ownShift(req, parseId(req.params.id));
  if (!['Open','Filled'].includes(s.status)) throw conflict(`A ${s.status.toLowerCase()} shift can no longer be edited`);

  const d = shiftSchema.parse({ ...s, skills: s.skills, ...req.body });
  const accepted = await query(
    "SELECT COUNT(*)::int AS c FROM applications WHERE shift_id=$1 AND status='Accepted'",
    [s.id]
  );
  if (d.workers_needed < accepted.rows[0].c) throw bad(`Cannot reduce below ${accepted.rows[0].c} already accepted workers`);

  await query(
    `UPDATE shifts SET title=$1,description=$2,skills=$3,location=$4,lat=$5,lng=$6,
    radius_m=$7,date=$8,start_time=$9,end_time=$10,workers_needed=$11,rate=$12
    WHERE id=$13`,
    [d.title,d.description,d.skills,d.location,d.lat ?? null,d.lng ?? null,d.radius_m,
      d.date,d.start_time,d.end_time,d.workers_needed,d.rate,s.id]
  );
  await refreshShiftStatus(s.id);
  await audit(req, 'shift.update', 'shift', s.id);
  res.json({ shift: await serializeShift(await loadShift(s.id)) });
}));

router.post('/:id/cancel', requireRole('business','admin'), wrap(async (req, res) => {
  const s = await ownShift(req, parseId(req.params.id));
  if (['Completed','Cancelled'].includes(s.status)) throw conflict(`Shift is already ${s.status.toLowerCase()}`);

  await tx(async client => {
    await client.query("UPDATE shifts SET status='Cancelled' WHERE id=$1", [s.id]);
    const workers = await client.query(
      "SELECT worker_id FROM applications WHERE shift_id=$1 AND status IN ('Applied','Accepted')",
      [s.id]
    );
    for (const a of workers.rows) {
      await client.query('INSERT INTO notifications(user_id,message) VALUES($1,$2)', [
        a.worker_id, `${pad('SFT',s.id)} (${s.title}) was cancelled by the business.`
      ]);
    }
  });

  await audit(req, 'shift.cancel', 'shift', s.id);
  res.json({ shift: await serializeShift(await loadShift(s.id)) });
}));

router.post('/:id/complete', requireRole('business','admin'), wrap(async (req, res) => {
  const s = await ownShift(req, parseId(req.params.id));
  if (!['Ongoing','Filled'].includes(s.status)) throw conflict('Only filled or ongoing shifts can be completed');

  const { end } = shiftWindow(s);
  const when = new Date() < end ? new Date() : end;
  const open = await query(
    'SELECT * FROM attendance WHERE shift_id=$1 AND clock_out IS NULL',
    [s.id]
  );
  for (const att of open.rows) {
    const { closeAttendance } = await import('../services-postgres.js');
    await closeAttendance(att, s, when);
  }

  await query("UPDATE shifts SET status='Completed' WHERE id=$1", [s.id]);
  await audit(req, 'shift.complete', 'shift', s.id);
  res.json({ shift: await serializeShift(await loadShift(s.id)) });
}));

router.post('/:id/apply', requireRole('worker'), wrap(async (req, res) => {
  const s = await loadShift(parseId(req.params.id));
  const worker = await query('SELECT kyc_status FROM workers WHERE user_id=$1', [req.user.id]);
  if (config.requireKycToApply && worker.rows[0]?.kyc_status !== 'Verified') {
    throw forbidden('Complete KYC verification before applying for shifts');
  }
  if (s.status !== 'Open') throw conflict('This shift is no longer open for applications');

  const mine = await query(`${SHIFT_SELECT}
    JOIN applications a ON a.shift_id=s.id
    WHERE a.worker_id=$1 AND a.status IN ('Applied','Accepted') AND s.status!='Cancelled'`,
    [req.user.id]
  );
  const win = shiftWindow(s);
  for (const other of mine.rows) {
    const ow = shiftWindow(other);
    if (ow.start < win.end && win.start < ow.end) {
      throw conflict(`This overlaps with your shift ${pad('SFT',other.id)} (${other.title})`);
    }
  }

  const existing = await query(
    'SELECT id,status FROM applications WHERE shift_id=$1 AND worker_id=$2',
    [s.id,req.user.id]
  );
  if (existing.rows[0] && existing.rows[0].status !== 'Withdrawn') {
    throw conflict('You have already applied for this shift');
  }

  if (existing.rows[0]) {
    await query("UPDATE applications SET status='Applied',created_at=NOW() WHERE id=$1", [existing.rows[0].id]);
  } else {
    await query('INSERT INTO applications(shift_id,worker_id) VALUES($1,$2)', [s.id,req.user.id]);
  }

  await notify(s.business_id, `${req.user.name} applied for ${s.title} (${pad('SFT',s.id)}).`);
  await audit(req, 'shift.apply', 'shift', s.id);
  res.status(201).json({ ok: true });
}));

router.delete('/:id/apply', requireRole('worker'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const app = await query('SELECT * FROM applications WHERE shift_id=$1 AND worker_id=$2', [id,req.user.id]);
  if (!app.rows[0] || app.rows[0].status === 'Withdrawn') throw notFound('No active application found');

  const attendance = await query('SELECT 1 FROM attendance WHERE shift_id=$1 AND worker_id=$2', [id,req.user.id]);
  if (attendance.rows.length) throw conflict('You have already clocked in to this shift');

  await query("UPDATE applications SET status='Withdrawn' WHERE id=$1", [app.rows[0].id]);
  await refreshShiftStatus(id);
  await audit(req, 'shift.withdraw', 'shift', id);
  res.json({ ok: true });
}));

router.get('/:id/applications', requireRole('business','admin'), wrap(async (req, res) => {
  const s = await ownShift(req, parseId(req.params.id));
  const rows = await query(
    `SELECT a.id,a.status,a.created_at,u.id AS worker_id,u.name,u.phone,w.skills,w.location,w.rating,w.kyc_status
    FROM applications a JOIN users u ON u.id=a.worker_id JOIN workers w ON w.user_id=u.id
    WHERE a.shift_id=$1 AND a.status!='Withdrawn' ORDER BY a.created_at`,
    [s.id]
  );
  res.json({ applications: rows.rows });
}));

router.get('/:id/qr', requireRole('business','admin'), wrap(async (req, res) => {
  const s = await ownShift(req, parseId(req.params.id));
  if (['Cancelled','Completed'].includes(s.status)) throw conflict('QR is unavailable for this shift');
  if (s.lat == null || s.lng == null) throw bad('Set both site latitude and longitude in shift details before generating an attendance QR code');

  const token = makeQrToken(s);
  res.set('Cache-Control','no-store');
  res.json({ token, svg: await QRCode.toString(token,{type:'svg',margin:2,errorCorrectionLevel:'H'}) });
}));

export const applicationsRouter = Router();
applicationsRouter.use(authenticate, requireRole('business','admin'));
applicationsRouter.post('/:id/decision', wrap(async (req, res) => {
  const { decision } = z.object({ decision:z.enum(['accept','reject']) }).parse(req.body);
  const found = await query('SELECT * FROM applications WHERE id=$1', [parseId(req.params.id)]);
  const a = found.rows[0];
  if (!a) throw notFound('Application not found');

  const s = await ownShift(req, a.shift_id);
  if (a.status === 'Withdrawn') throw conflict('The worker withdrew this application');
  if (['Cancelled','Completed'].includes(s.status)) throw conflict(`Shift is ${s.status.toLowerCase()}`);

  await tx(async client => {
    if (decision === 'accept') {
      const count = await client.query(
        "SELECT COUNT(*)::int AS c FROM applications WHERE shift_id=$1 AND status='Accepted'",
        [s.id]
      );
      if (a.status !== 'Accepted' && count.rows[0].c >= s.workers_needed) {
        throw conflict('All positions for this shift are already filled');
      }
    }
    await client.query('UPDATE applications SET status=$1 WHERE id=$2',
      [decision === 'accept' ? 'Accepted' : 'Rejected',a.id]);
    await client.query('INSERT INTO notifications(user_id,message) VALUES($1,$2)', [
      a.worker_id,
      `Your application for ${s.title} (${pad('SFT',s.id)}) was ${decision === 'accept' ? 'accepted' : 'declined'}.`
    ]);
  });

  await refreshShiftStatus(s.id);
  await audit(req, `application.${decision}`, 'application', a.id, `shift ${s.id}`);
  res.json({ ok:true });
}));

