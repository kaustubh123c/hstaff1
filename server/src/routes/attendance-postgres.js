import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db-postgres.js';
import { config } from '../config.js';
import { authenticate, requireRole } from '../auth-postgres.js';
import {
  wrap, bad, forbidden, notFound, conflict, parseId,
  audit, haversineMeters, verifyQrToken, shiftWindow,
  pad, serializeShift, SHIFT_SELECT
} from '../util-postgres.js';
import {
  closeAttendance, refreshShiftStatus
} from '../services-postgres.js';

export const router = Router();
router.use(authenticate);

const coords = {
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional()
};

function geofence(shift, lat, lng) {
  if (shift.lat == null || shift.lng == null) {
    throw forbidden('This shift has no site GPS pin. Ask the business to set its latitude and longitude before recording attendance.');
  }
  if (lat == null || lng == null) {
    throw bad('Location is required to verify attendance. Please allow location access.');
  }
  const distance = Math.round(haversineMeters(shift.lat, shift.lng, lat, lng));
  if (distance > shift.radius_m) {
    throw forbidden(`You are ${distance} m from the work location. You must be within ${shift.radius_m} m.`);
  }
  return { distance };
}

router.get('/mine', requireRole('worker'), wrap(async (req, res) => {
  const rows = await query(
    `${SHIFT_SELECT}
     JOIN applications a ON a.shift_id=s.id AND a.worker_id=$1 AND a.status='Accepted'
     WHERE s.status IN ('Filled','Ongoing','Open')
        OR EXISTS (
          SELECT 1 FROM attendance t
          WHERE t.shift_id=s.id AND t.worker_id=$1 AND t.clock_out IS NULL
        )
     ORDER BY s.date,s.start_time`,
    [req.user.id]
  );

  const history = await query(
    `SELECT t.*,s.title,s.date
     FROM attendance t JOIN shifts s ON s.id=t.shift_id
     WHERE t.worker_id=$1 ORDER BY t.clock_in DESC LIMIT 10`,
    [req.user.id]
  );

  const assignments = [];
  for (const s of rows.rows) {
    const attendance = await query(
      'SELECT id,clock_in,clock_out FROM attendance WHERE shift_id=$1 AND worker_id=$2',
      [s.id,req.user.id]
    );
    assignments.push(serializeShift(s, {
      attendance: attendance.rows[0] ?? null
    }));
  }

  res.json({ assignments, history: history.rows });
}));

router.post('/clock-in', requireRole('worker'), wrap(async (req, res) => {
  const d = z.object({
    token: z.string().min(10).max(200),
    ...coords
  }).parse(req.body);

  const shiftId = verifyQrToken(d.token);
  if (!shiftId) throw bad('Invalid or expired QR code');

  const result = await query('SELECT * FROM shifts WHERE id=$1', [shiftId]);
  const shift = result.rows[0];
  if (!shift) throw notFound('Shift not found');

  if (['Cancelled','Completed'].includes(shift.status)) {
    throw conflict(`This shift is ${shift.status.toLowerCase()}`);
  }

  const app = await query(
    "SELECT 1 FROM applications WHERE shift_id=$1 AND worker_id=$2 AND status='Accepted'",
    [shiftId,req.user.id]
  );
  if (!app.rows.length) throw forbidden('You are not assigned to this shift');

  const existing = await query(
    'SELECT 1 FROM attendance WHERE shift_id=$1 AND worker_id=$2',
    [shiftId,req.user.id]
  );
  if (existing.rows.length) throw conflict('You have already clocked in to this shift');

  if (config.enforceTimeWindow) {
    const { start,end } = shiftWindow(shift);
    const now = Date.now();
    if (now < start.getTime() - config.clockInEarlyMinutes * 60000) {
      throw forbidden(`Clock-in opens ${config.clockInEarlyMinutes} minutes before the shift starts`);
    }
    if (now > end.getTime() + 12 * 3600000) {
      throw forbidden('The clock-in grace period has ended. Ask the business to correct the shift or record an attendance adjustment.');
    }
  }

  const { distance } = geofence(shift,d.lat,d.lng);

  await tx(async client => {
    await client.query(
      `INSERT INTO attendance
       (shift_id,worker_id,clock_in,in_lat,in_lng,in_distance_m)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [shiftId,req.user.id,new Date().toISOString(),d.lat ?? null,d.lng ?? null,distance]
    );
  });

  await refreshShiftStatus(shiftId);
  await audit(req,'attendance.clock_in','shift',shiftId,`${distance} m from site`);

  res.status(201).json({
    ok:true,
    shift:pad('SFT',shiftId),
    distance_m:distance
  });
}));

router.post('/clock-out', requireRole('worker'), wrap(async (req, res) => {
  const d = z.object({
    shift_id:z.coerce.number().int().min(1),
    ...coords
  }).parse(req.body);

  const attendanceResult = await query(
    'SELECT * FROM attendance WHERE shift_id=$1 AND worker_id=$2',
    [d.shift_id,req.user.id]
  );
  const att = attendanceResult.rows[0];

  if (!att) throw notFound('You have not clocked in to this shift');
  if (att.clock_out) throw conflict('You have already clocked out');

  const shiftResult = await query('SELECT * FROM shifts WHERE id=$1', [d.shift_id]);
  const shift = shiftResult.rows[0];
  if (!shift) throw notFound('Shift not found');

  const { distance } = geofence(shift,d.lat,d.lng);
  const ts = await closeAttendance(att,shift,new Date(),{
    lat:d.lat,
    lng:d.lng,
    distance
  });

  await refreshShiftStatus(d.shift_id);
  await audit(req,'attendance.clock_out','shift',d.shift_id,`${ts.hours} h`);

  res.json({
    ok:true,
    hours:ts.hours,
    amount:ts.amount,
    timesheet:pad('TS',ts.id)
  });
}));

router.get('/shift/:id', requireRole('business','admin'), wrap(async (req, res) => {
  const result = await query('SELECT * FROM shifts WHERE id=$1', [parseId(req.params.id)]);
  const s = result.rows[0];

  if (!s) throw notFound('Shift not found');
  if (req.user.role === 'business' && Number(s.business_id) !== Number(req.user.id)) {
    throw forbidden();
  }

  const attendance = await query(
    `SELECT t.*,u.name
     FROM attendance t JOIN users u ON u.id=t.worker_id
     WHERE t.shift_id=$1`,
    [s.id]
  );

  res.json({ attendance:attendance.rows });
}));
