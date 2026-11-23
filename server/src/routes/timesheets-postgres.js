import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db-postgres.js';
import { authenticate, requireRole } from '../auth-postgres.js';
import {
  wrap, forbidden, notFound, conflict, parseId, audit, pad
} from '../util-postgres.js';
import { createPaymentForTimesheet } from '../services-postgres.js';

export const router = Router();
router.use(authenticate);

const BASE = `
  SELECT t.*,s.title AS shift_title,s.date,s.business_id,s.location,
         b.company,u.name AS worker_name
  FROM timesheets t
  JOIN shifts s ON s.id=t.shift_id
  JOIN businesses b ON b.user_id=s.business_id
  JOIN users u ON u.id=t.worker_id
`;

const shape = t => ({
  ...t,
  code:pad('TS',t.id),
  shift_code:pad('SFT',t.shift_id)
});

router.get('/', wrap(async (req,res) => {
  const { role,id } = req.user;
  let result;

  if (role === 'business') {
    result = await query(`${BASE} WHERE s.business_id=$1 ORDER BY t.id DESC`,[id]);
  } else if (role === 'worker') {
    result = await query(`${BASE} WHERE t.worker_id=$1 ORDER BY t.id DESC`,[id]);
  } else {
    result = await query(`${BASE} ORDER BY t.id DESC`);
  }

  const rows = result.rows;
  const count = status => rows.filter(r => r.status === status).length;

  res.json({
    timesheets:rows.map(shape),
    summary:{
      pending:count('Pending'),
      approved:count('Approved'),
      disputed:count('Disputed'),
      paid:count('Paid')
    }
  });
}));

async function loadForBusiness(req) {
  const result = await query(`${BASE} WHERE t.id=$1`,[parseId(req.params.id)]);
  const t = result.rows[0];

  if (!t) throw notFound('Timesheet not found');
  if (req.user.role === 'business' && Number(t.business_id) !== Number(req.user.id)) {
    throw forbidden();
  }
  return t;
}

router.post('/:id/approve',requireRole('business','admin'),wrap(async (req,res) => {
  const t = await loadForBusiness(req);
  if (t.status !== 'Pending') {
    throw conflict(`Timesheet is already ${t.status.toLowerCase()}`);
  }

  await tx(async client => {
    await client.query(
      "UPDATE timesheets SET status='Approved',decided_at=NOW() WHERE id=$1",
      [t.id]
    );

    const fee = await createPaymentForTimesheet(t);

    await client.query(
      'INSERT INTO notifications(user_id,message) VALUES($1,$2)',
      [
        t.worker_id,
        `Timesheet ${pad('TS',t.id)} approved. Payment of ₹${t.amount} is being processed.`
      ]
    );
  });

  await audit(req,'timesheet.approve','timesheet',t.id);
  res.json({ok:true});
}));

router.post('/:id/dispute',wrap(async (req,res) => {
  const {reason} = z.object({
    reason:z.string().trim().min(5,'Please describe the issue').max(1000)
  }).parse(req.body);

  const result = await query(`${BASE} WHERE t.id=$1`,[parseId(req.params.id)]);
  const t = result.rows[0];

  if (!t) throw notFound('Timesheet not found');

  const allowed =
    (req.user.role === 'business' && Number(t.business_id) === Number(req.user.id)) ||
    (req.user.role === 'worker' && Number(t.worker_id) === Number(req.user.id));

  if (!allowed) throw forbidden();
  if (!['Pending','Approved'].includes(t.status)) {
    throw conflict(`A ${t.status.toLowerCase()} timesheet cannot be disputed`);
  }

  const disputeId = await tx(async client => {
    const pay = await client.query(
      'SELECT status FROM payments WHERE timesheet_id=$1 FOR UPDATE',
      [t.id]
    );

    if (pay.rows[0]?.status === 'Paid') {
      throw conflict('This timesheet has already been paid');
    }

    await client.query(
      "UPDATE timesheets SET status='Disputed' WHERE id=$1",
      [t.id]
    );

    if (pay.rows[0]) {
      await client.query('DELETE FROM payments WHERE timesheet_id=$1',[t.id]);
    }

    const dispute = await client.query(
      `INSERT INTO disputes(timesheet_id,raised_by,subject,description)
       VALUES($1,$2,$3,$4) RETURNING id`,
      [t.id,req.user.id,`Hours dispute – ${pad('TS',t.id)}`,reason]
    );

    return dispute.rows[0].id;
  });

  await audit(req,'timesheet.dispute','timesheet',t.id,reason);
  res.status(201).json({ok:true,dispute:pad('DSP',disputeId)});
}));
