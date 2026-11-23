
import { query, tx } from './db-postgres.js';
import { config } from './config.js';
import { roundHours, pad } from './util-postgres.js';

// Close attendance and create its timesheet atomically.
export async function closeAttendance(att, shift, when, out = {}) {
  return tx(async client => {
    const ms = Math.max(
      0,
      when.getTime() - new Date(att.clock_in).getTime()
    );

    const hours = roundHours(ms);
    const amount = Math.round(hours * Number(shift.rate));

    await client.query(
      `UPDATE attendance
       SET clock_out = $1,
           out_lat = $2,
           out_lng = $3,
           out_distance_m = $4
       WHERE id = $5`,
      [
        when.toISOString(),
        out.lat ?? null,
        out.lng ?? null,
        out.distance ?? null,
        att.id
      ]
    );

    const inserted = await client.query(
      `INSERT INTO timesheets
        (shift_id, worker_id, attendance_id, hours, rate, amount)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        shift.id,
        att.worker_id,
        att.id,
        hours,
        shift.rate,
        amount
      ]
    );

    const timesheetId = inserted.rows[0].id;

    await client.query(
      `INSERT INTO notifications (user_id, message)
       VALUES ($1, $2)`,
      [
        shift.business_id,
        `Timesheet ${pad('TS', timesheetId)} for ${shift.title} is ready for review.`
      ]
    );

    return {
      id: timesheetId,
      hours,
      amount
    };
  });
}

// Recalculate the shift status from its applications and attendance.
export async function refreshShiftStatus(shiftId) {
  return tx(async client => {
    const shiftResult = await client.query(
      'SELECT * FROM shifts WHERE id = $1 FOR UPDATE',
      [shiftId]
    );

    const shift = shiftResult.rows[0];

    if (!shift || ['Cancelled', 'Completed'].includes(shift.status)) {
      return;
    }

    const acceptedResult = await client.query(
      `SELECT COUNT(*)::integer AS count
       FROM applications
       WHERE shift_id = $1 AND status = 'Accepted'`,
      [shiftId]
    );

    const startedResult = await client.query(
      `SELECT COUNT(*)::integer AS count
       FROM attendance
       WHERE shift_id = $1`,
      [shiftId]
    );

    const accepted = acceptedResult.rows[0].count;
    const started = startedResult.rows[0].count;

    const status = started > 0
      ? 'Ongoing'
      : accepted >= shift.workers_needed
        ? 'Filled'
        : 'Open';

    if (status !== shift.status) {
      await client.query(
        'UPDATE shifts SET status = $1 WHERE id = $2',
        [status, shiftId]
      );
    }

    return status;
  });
}

// Create a payment record for an approved timesheet.
// ON CONFLICT DO NOTHING preserves the existing record if one already exists.
export async function createPaymentForTimesheet(ts) {
  return tx(async client => {
    const shiftResult = await client.query(
      'SELECT business_id FROM shifts WHERE id = $1',
      [ts.shift_id]
    );

    const shift = shiftResult.rows[0];

    if (!shift) {
      throw new Error(`Shift ${ts.shift_id} was not found.`);
    }

    const fee = Math.round(
      Number(ts.amount) * config.platformFeePercent / 100
    );

    const result = await client.query(
      `INSERT INTO payments
        (timesheet_id, business_id, worker_id, amount, fee)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        ts.id,
        shift.business_id,
        ts.worker_id,
        ts.amount,
        fee
      ]
    );

    return result.rows[0] ?? null;
  });
}
