import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, tx } from '../db-postgres.js';
import { authenticate, requireRole } from '../auth-postgres.js';
import { config } from '../config.js';
import {
  wrap, notFound, conflict, parseId, audit, notify, pad,
  forbidden, bad
} from '../util-postgres.js';

export const router = Router();

const hmac = (secret,text) =>
  crypto.createHmac('sha256',secret).update(text).digest('hex');

const safeEqualHex = (a,b) => {
  if (!/^[a-f0-9]+$/i.test(String(a || '')) ||
      !/^[a-f0-9]+$/i.test(String(b || ''))) return false;
  const aa = Buffer.from(a,'hex');
  const bb = Buffer.from(b,'hex');
  return aa.length === bb.length && crypto.timingSafeEqual(aa,bb);
};

async function razorpayRequest(path,body) {
  const auth = Buffer.from(
    `${config.razorpayKeyId}:${config.razorpayKeySecret}`
  ).toString('base64');

  const response = await fetch(`https://api.razorpay.com/v1${path}`,{
    method:body ? 'POST' : 'GET',
    headers:{
      Authorization:`Basic ${auth}`,
      ...(body ? {'Content-Type':'application/json'} : {})
    },
    ...(body ? {body:JSON.stringify(body)} : {})
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error?.description ||
      `Razorpay request failed (${response.status})`);
  }
  return data;
}

function requireGateway() {
  if (!config.razorpayEnabled) {
    throw conflict('Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET after activating your Razorpay account.');
  }
}

router.get('/',authenticate,wrap(async(req,res) => {
  const {role,id} = req.user;
  let result;

  const base = `
    SELECT p.*,s.title AS shift_title,s.date,s.id AS shift_id,
           uw.name AS worker_name,b.company
    FROM payments p
    JOIN timesheets t ON t.id=p.timesheet_id
    JOIN shifts s ON s.id=t.shift_id
    JOIN users uw ON uw.id=p.worker_id
    JOIN businesses b ON b.user_id=p.business_id
  `;

  if (role === 'business') {
    result = await query(`${base} WHERE p.business_id=$1 ORDER BY p.id DESC`,[id]);
  } else if (role === 'worker') {
    result = await query(`${base} WHERE p.worker_id=$1 ORDER BY p.id DESC`,[id]);
  } else {
    result = await query(`${base} ORDER BY p.id DESC`);
  }

  const rows = result.rows;
  const displayAmount = r =>
    Number(role === 'worker' ? r.amount-r.fee : r.amount);

  const sum = status =>
    rows.filter(r =>
      (role === 'worker' ? r.payout_status : r.collection_status) === status
    ).reduce((a,r) => a+displayAmount(r),0);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0,0,0,0);

  const paidThisMonth = rows.filter(r => {
    const status = role === 'worker' ? r.payout_status : r.collection_status;
    const date = role === 'worker' ? r.payout_updated_at : r.collection_paid_at;
    return status === 'paid' && date && new Date(date) >= monthStart;
  }).reduce((a,r) => a+displayAmount(r),0);

  res.json({
    gateway:{
      provider:'razorpay',
      configured:config.razorpayEnabled,
      mode:config.razorpayEnabled ? 'configured' : 'setup_required',
      fee_percent:config.platformFeePercent
    },
    payments:rows.map(r => ({
      ...r,
      code:`PAY-${String(r.id).padStart(4,'0')}`,
      timesheet_code:pad('TS',r.timesheet_id),
      shift_code:pad('SFT',r.shift_id),
      net_amount:Number(r.amount)-Number(r.fee)
    })),
    summary:{
      pending_amount:rows.filter(r =>
        role === 'worker'
          ? r.payout_status !== 'paid'
          : r.collection_status !== 'paid'
      ).reduce((a,r) => a+displayAmount(r),0),
      paid_amount:sum('paid'),
      count:rows.length,
      paid_this_month:paidThisMonth
    }
  });
}));

router.post('/jobs/:id/create-order',authenticate,requireRole('business'),wrap(async(req,res) => {
  requireGateway();

  const id = parseId(req.params.id);
  const result = await query(
    'SELECT * FROM job_payments WHERE shift_id=$1',[id]
  );
  const p = result.rows[0];

  if (!p) throw notFound('Confirmed on-demand job payment not found.');
  if (Number(p.business_id) !== Number(req.user.id)) throw forbidden();
  if (p.status === 'paid') throw conflict('This job is already paid.');

  if (p.razorpay_order_id) {
    return res.json({
      key_id:config.razorpayKeyId,
      order_id:p.razorpay_order_id,
      amount:Number(p.amount)*100,
      currency:'INR',
      payment_id:p.id,
      business_name:'H-Staff'
    });
  }

  const order = await razorpayRequest('/orders',{
    amount:Number(p.amount)*100,
    currency:'INR',
    receipt:`hstaff_job_${id}`,
    notes:{
      hstaff_job_id:String(id),
      business_id:String(p.business_id),
      worker_id:String(p.worker_id)
    }
  });

  await query(
    "UPDATE job_payments SET razorpay_order_id=$1 WHERE id=$2 AND status!='paid'",
    [order.id,p.id]
  );

  await audit(req,'job_payment.order_created','shift',id,order.id);

  res.json({
    key_id:config.razorpayKeyId,
    order_id:order.id,
    amount:order.amount,
    currency:order.currency,
    payment_id:p.id,
    business_name:'H-Staff'
  });
}));

router.post('/jobs/:id/verify-checkout',authenticate,requireRole('business'),wrap(async(req,res) => {
  requireGateway();

  const id = parseId(req.params.id);
  const {razorpay_order_id,razorpay_payment_id,razorpay_signature} =
    z.object({
      razorpay_order_id:z.string().min(1),
      razorpay_payment_id:z.string().min(1),
      razorpay_signature:z.string().min(1)
    }).parse(req.body);

  const result = await query(
    'SELECT * FROM job_payments WHERE shift_id=$1',[id]
  );
  const p = result.rows[0];

  if (!p) throw notFound('Job payment not found.');
  if (Number(p.business_id) !== Number(req.user.id)) throw forbidden();
  if (p.status === 'paid') return res.json({ok:true,status:'paid'});
  if (p.razorpay_order_id !== razorpay_order_id) {
    throw bad('Order does not match this job.');
  }

  if (!safeEqualHex(
    razorpay_signature,
    hmac(config.razorpayKeySecret,
      `${razorpay_order_id}|${razorpay_payment_id}`)
  )) throw bad('Razorpay checkout signature is invalid.');

  const gateway = await razorpayRequest(
    `/payments/${encodeURIComponent(razorpay_payment_id)}`
  );

  if (
    gateway.order_id !== razorpay_order_id ||
    gateway.amount !== Number(p.amount)*100 ||
    gateway.currency !== 'INR' ||
    gateway.status !== 'captured'
  ) throw conflict('Gateway has not confirmed the expected captured amount.');

  await tx(async client => {
    await client.query(
      `UPDATE job_payments
       SET status='paid',razorpay_payment_id=$1,paid_at=NOW()
       WHERE id=$2 AND status!='paid'`,
      [razorpay_payment_id,p.id]
    );

    const eventId = `job-checkout:${razorpay_payment_id}`;

    await client.query(
      `INSERT INTO payment_events(provider,event_id,event_type,payload_json)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(event_id) DO NOTHING`,
      ['razorpay',eventId,'job.checkout.verified',
       JSON.stringify({job_id:id,razorpay_payment_id})]
    );

    await client.query(
      'INSERT INTO notifications(user_id,message) VALUES($1,$2)',
      [p.worker_id,
       `Payment for completed job ${id} was received. Net earnings: ₹${Number(p.amount)-Number(p.fee)}.`]
    );
  });

  await audit(req,'job_payment.collected','shift',id,razorpay_payment_id);
  res.json({ok:true,status:'paid'});
}));

router.post('/:id/create-order',authenticate,requireRole('business'),wrap(async(req,res) => {
  requireGateway();

  const id = parseId(req.params.id);
  const result = await query(
    `SELECT p.*,t.status AS timesheet_status
     FROM payments p
     JOIN timesheets t ON t.id=p.timesheet_id
     WHERE p.id=$1`,
    [id]
  );
  const p = result.rows[0];

  if (!p) throw notFound('Payment not found');
  if (Number(p.business_id) !== Number(req.user.id)) {
    throw forbidden('This payment does not belong to your business.');
  }
  if (!['Approved','Paid'].includes(p.timesheet_status)) {
    throw conflict('Timesheet must be approved before payment.');
  }
  if (p.collection_status === 'paid') {
    throw conflict('Client payment has already been collected.');
  }

  if (p.razorpay_order_id && p.collection_status === 'created') {
    return res.json({
      key_id:config.razorpayKeyId,
      order_id:p.razorpay_order_id,
      amount:Number(p.amount)*100,
      currency:'INR',
      payment_id:p.id,
      business_name:'H-Staff'
    });
  }

  const order = await razorpayRequest('/orders',{
    amount:Number(p.amount)*100,
    currency:'INR',
    receipt:`hstaff_pay_${p.id}`,
    notes:{
      hstaff_payment_id:String(p.id),
      timesheet_id:String(p.timesheet_id),
      business_id:String(p.business_id),
      worker_id:String(p.worker_id)
    }
  });

  await query(
    `UPDATE payments
     SET razorpay_order_id=$1,collection_status='created',checkout_key=$2
     WHERE id=$3 AND collection_status!='paid'`,
    [order.id,crypto.randomUUID(),p.id]
  );

  await audit(req,'payment.razorpay_order_created','payment',p.id,order.id);

  res.json({
    key_id:config.razorpayKeyId,
    order_id:order.id,
    amount:order.amount,
    currency:order.currency,
    payment_id:p.id,
    business_name:'H-Staff'
  });
}));

router.post('/:id/verify-checkout',authenticate,requireRole('business'),wrap(async(req,res) => {
  requireGateway();

  const {razorpay_order_id,razorpay_payment_id,razorpay_signature} =
    z.object({
      razorpay_order_id:z.string().min(1),
      razorpay_payment_id:z.string().min(1),
      razorpay_signature:z.string().min(1)
    }).parse(req.body);

  const id = parseId(req.params.id);
  const result = await query('SELECT * FROM payments WHERE id=$1',[id]);
  const p = result.rows[0];

  if (!p) throw notFound('Payment not found');
  if (Number(p.business_id) !== Number(req.user.id)) {
    throw forbidden('This payment does not belong to your business.');
  }
  if (p.collection_status === 'paid') {
    return res.json({
      ok:true,
      collection_status:'paid',
      payout_status:p.payout_status
    });
  }
  if (p.razorpay_order_id !== razorpay_order_id) {
    throw bad('Order does not match this payment.');
  }

  if (!safeEqualHex(
    razorpay_signature,
    hmac(config.razorpayKeySecret,
      `${razorpay_order_id}|${razorpay_payment_id}`)
  )) throw bad('Razorpay checkout signature is invalid.');

  const gateway = await razorpayRequest(
    `/payments/${encodeURIComponent(razorpay_payment_id)}`
  );

  if (
    gateway.order_id !== razorpay_order_id ||
    gateway.amount !== Number(p.amount)*100 ||
    gateway.currency !== 'INR' ||
    gateway.status !== 'captured'
  ) {
    throw conflict('Payment is not captured for the expected amount. If you just paid, wait for confirmation and refresh.');
  }

  const eventId = `checkout:${razorpay_payment_id}`;

  await tx(async client => {
    const seen = await client.query(
      'SELECT id FROM payment_events WHERE event_id=$1 FOR UPDATE',
      [eventId]
    );

    if (seen.rows.length) return;

    await client.query(
      `UPDATE payments
       SET collection_status='paid',razorpay_payment_id=$1,
           collection_paid_at=NOW(),reference=$1
       WHERE id=$2 AND collection_status!='paid'`,
      [razorpay_payment_id,p.id]
    );

    await client.query(
      `INSERT INTO payment_events
       (provider,event_id,event_type,payment_id,payload_json)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(event_id) DO NOTHING`,
      ['razorpay',eventId,'checkout.verified',p.id,
       JSON.stringify({
         order_id:razorpay_order_id,
         payment_id:razorpay_payment_id
       })]
    );

    await client.query(
      'INSERT INTO notifications(user_id,message) VALUES($1,$2)',
      [p.worker_id,
       `Client payment received for ${pad('PAY',p.id)}. Worker payout is awaiting payout setup/processing.`]
    );
  });

  await audit(req,'payment.razorpay_collected','payment',p.id,razorpay_payment_id);

  res.json({
    ok:true,
    collection_status:'paid',
    payout_status:'not_started',
    message:'Client payment verified. Worker payout is tracked separately and is not automatically transferred by this checkout.'
  });
}));

router.post('/:id/mark-paid',authenticate,requireRole('admin'),wrap(async(req,res) => {
  const {reference} = z.object({
    reference:z.string().trim().min(4).max(100)
  }).parse(req.body ?? {});

  const id = parseId(req.params.id);
  const result = await query(
    `SELECT p.*,t.status AS timesheet_status
     FROM payments p
     JOIN timesheets t ON t.id=p.timesheet_id
     WHERE p.id=$1`,
    [id]
  );
  const p = result.rows[0];

  if (!p) throw notFound('Payment not found');
  if (!['Approved','Paid'].includes(p.timesheet_status)) {
    throw conflict('Only an approved timesheet can be recorded as paid.');
  }
  if (p.collection_status === 'paid' || p.status === 'Paid') {
    throw conflict('Payment is already recorded as paid.');
  }

  await tx(async client => {
    await client.query(
      `UPDATE payments
       SET status='Paid',collection_status='paid',payout_status='paid',
           reference=$1,payout_reference=$1,collection_paid_at=NOW(),
           paid_at=NOW(),payout_updated_at=NOW()
       WHERE id=$2 AND status!='Paid'`,
      [reference,id]
    );

    await client.query(
      `UPDATE timesheets SET status='Paid'
       WHERE id=$1 AND status='Approved'`,
      [p.timesheet_id]
    );

    await client.query(
      'INSERT INTO notifications(user_id,message) VALUES($1,$2)',
      [p.worker_id,
       `Offline payment ${pad('PAY',id)} recorded. Reference: ${reference}`]
    );
  });

  await audit(req,'payment.manual_recorded','payment',id,reference);
  res.json({
    ok:true,status:'Paid',
    collection_status:'paid',
    payout_status:'paid'
  });
}));

export async function razorpayWebhook(req,res) {
  if (!config.razorpayWebhookSecret) {
    return res.status(503).json({
      error:'Razorpay webhook secret is not configured.'
    });
  }

  const signature = req.get('x-razorpay-signature') || '';
  const raw = req.rawBody;

  if (!raw || !safeEqualHex(
    signature,hmac(config.razorpayWebhookSecret,raw)
  )) {
    return res.status(400).json({error:'Invalid webhook signature.'});
  }

  const event = req.body;
  const eventId = req.get('x-razorpay-event-id');

  if (!eventId) {
    return res.status(400).json({error:'Missing webhook event id.'});
  }

  try {
    await tx(async client => {
      const seen = await client.query(
        'SELECT id FROM payment_events WHERE event_id=$1 FOR UPDATE',
        [eventId]
      );
      if (seen.rows.length) return;

      const entity = event?.payload?.payment?.entity;
      const orderId = entity?.order_id;

      let p = null;
      let jp = null;

      if (orderId) {
        const paymentResult = await client.query(
          'SELECT * FROM payments WHERE razorpay_order_id=$1 FOR UPDATE',
          [orderId]
        );
        p = paymentResult.rows[0] || null;

        if (!p) {
          const jobResult = await client.query(
            'SELECT * FROM job_payments WHERE razorpay_order_id=$1 FOR UPDATE',
            [orderId]
          );
          jp = jobResult.rows[0] || null;
        }
      }

      await client.query(
        `INSERT INTO payment_events
         (provider,event_id,event_type,payment_id,payload_json)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(event_id) DO NOTHING`,
        [
          'razorpay',
          eventId,
          String(event.event || 'unknown'),
          p?.id ?? null,
          JSON.stringify(event)
        ]
      );

      if (
        p &&
        event.event === 'payment.captured' &&
        entity.amount === Number(p.amount)*100 &&
        entity.currency === 'INR'
      ) {
        await client.query(
          `UPDATE payments
           SET collection_status='paid',razorpay_payment_id=$1,
               collection_paid_at=COALESCE(collection_paid_at,NOW()),
               reference=$1
           WHERE id=$2 AND collection_status!='paid'`,
          [entity.id,p.id]
        );

        await client.query(
          'INSERT INTO notifications(user_id,message) VALUES($1,$2)',
          [p.worker_id,
           `Client payment received for ${pad('PAY',p.id)}. Worker payout is tracked separately.`]
        );
      } else if (
        p && event.event === 'payment.failed' &&
        p.collection_status !== 'paid'
      ) {
        await client.query(
          `UPDATE payments SET collection_status='failed'
           WHERE id=$1 AND collection_status!='paid'`,
          [p.id]
        );
      } else if (
        jp &&
        event.event === 'payment.captured' &&
        entity.amount === Number(jp.amount)*100 &&
        entity.currency === 'INR'
      ) {
        await client.query(
          `UPDATE job_payments
           SET status='paid',razorpay_payment_id=$1,
               paid_at=COALESCE(paid_at,NOW())
           WHERE id=$2 AND status!='paid'`,
          [entity.id,jp.id]
        );

        await client.query(
          'INSERT INTO notifications(user_id,message) VALUES($1,$2)',
          [jp.worker_id,
           `Payment for completed job ${jp.shift_id} was received.`]
        );
      }
    });

    return res.json({received:true});
  } catch (e) {
    console.error('Razorpay webhook processing failed:',e);
    return res.status(500).json({
      error:'Webhook processing failed; provider may retry.'
    });
  }
}

router.post('/:id/queue-payout',authenticate,requireRole('admin'),wrap(async(req,res) => {
  const id = parseId(req.params.id);
  const result = await query('SELECT * FROM payments WHERE id=$1',[id]);
  const p = result.rows[0];

  if (!p) throw notFound('Payment not found');
  if (p.collection_status !== 'paid') {
    throw conflict('Client funds must be captured before queuing a worker payout.');
  }
  if (p.payout_status === 'paid' || p.status === 'Paid') {
    throw conflict('Worker payout is already marked paid.');
  }

  const key = `hstaff-payout-${p.id}`;

  await tx(async client => {
    await client.query(
      `INSERT INTO payout_attempts(payment_id,idempotency_key,status,amount)
       VALUES($1,$2,'queued',$3)
       ON CONFLICT(idempotency_key) DO NOTHING`,
      [p.id,key,Number(p.amount)-Number(p.fee)]
    );

    await client.query(
      `UPDATE payments SET payout_status='queued',payout_updated_at=NOW()
       WHERE id=$1`,
      [p.id]
    );
  });

  await audit(req,'payment.payout_queued','payment',p.id,key);

  res.json({
    ok:true,
    payout_status:'queued',
    net_amount:Number(p.amount)-Number(p.fee),
    message:'Queued for payout operations. No bank transfer has been initiated: Razorpay marketplace/payout access and verified worker beneficiary details are required.'
  });
}));

router.post('/:id/confirm-payout',authenticate,requireRole('admin'),wrap(async(req,res) => {
  const {reference} = z.object({
    reference:z.string().trim().min(4).max(100)
  }).parse(req.body ?? {});

  const id = parseId(req.params.id);
  const result = await query('SELECT * FROM payments WHERE id=$1',[id]);
  const p = result.rows[0];

  if (!p) throw notFound('Payment not found');
  if (p.collection_status !== 'paid') {
    throw conflict('Client payment has not been collected.');
  }
  if (p.payout_status === 'paid' || p.status === 'Paid') {
    throw conflict('Payout already confirmed.');
  }

  await tx(async client => {
    await client.query(
      `UPDATE payments
       SET status='Paid',payout_status='paid',payout_reference=$1,
           payout_updated_at=NOW(),paid_at=NOW(),
           reference=COALESCE(reference,$1)
       WHERE id=$2 AND status!='Paid'`,
      [reference,id]
    );

    await client.query(
      `UPDATE timesheets SET status='Paid'
       WHERE id=$1 AND status='Approved'`,
      [p.timesheet_id]
    );

    await client.query(
      `UPDATE payout_attempts
       SET status='paid',reference=$1,updated_at=NOW()
       WHERE payment_id=$2`,
      [reference,id]
    );

    await client.query(
      'INSERT INTO notifications(user_id,message) VALUES($1,$2)',
      [p.worker_id,
       `Worker payout of ₹${Number(p.amount)-Number(p.fee)} confirmed. Reference: ${reference}`]
    );
  });

  await audit(req,'payment.payout_confirmed','payment',id,reference);
  res.json({ok:true,payout_status:'paid'});
}));
