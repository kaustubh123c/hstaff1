import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, tx } from '../db-postgres.js';
import { authenticate, requireRole } from '../auth-postgres.js';
import { config } from '../config.js';
import {
  wrap, bad, forbidden, notFound, conflict, parseId,
  audit, notify, HttpError, sendSms
} from '../util-postgres.js';

export const router = Router();
router.use(authenticate);

const point = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180)
});

const dist = (a, b, c, d) => {
  const r = x => x * Math.PI / 180;
  const x = r(c - a), y = r(d - b);
  return 6371000 * 2 * Math.asin(Math.sqrt(
    Math.sin(x / 2) ** 2 +
    Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(y / 2) ** 2
  ));
};

const hash = (id, code) =>
  crypto.createHmac('sha256', config.jwtSecret).update(`${id}:${code}`).digest('hex');

const encrypt = (id, code) => {
  const key = crypto.createHash('sha256').update(config.jwtSecret).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(String(id)));
  const ciphertext = Buffer.concat([c.update(code), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ciphertext]).toString('base64');
};

const decrypt = (id, value) => {
  const b = Buffer.from(value, 'base64');
  const d = crypto.createDecipheriv(
    'aes-256-gcm',
    crypto.createHash('sha256').update(config.jwtSecret).digest(),
    b.subarray(0, 12)
  );
  d.setAAD(Buffer.from(String(id)));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString();
};

const job = async (id, client = null) => {
  const executor = client ? client.query.bind(client) : query;
  const result = await executor(
    "SELECT * FROM shifts WHERE id=$1 AND job_type='ondemand'",
    [id]
  );
  return result.rows[0] || null;
};

const timestamp = date => date.toISOString();

router.post('/jobs', requireRole('business'), wrap(async (req, res) => {
  const d = z.object({
    title: z.string().trim().min(2).max(80),
    description: z.string().max(1000).optional().default(''),
    skills: z.array(z.string()).max(10).optional().default([]),
    location: z.string().trim().min(2).max(160),
    ...point.shape,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    rate: z.coerce.number().int().min(1).max(100000),
    radius_m: z.coerce.number().int().min(25).max(5000).optional().default(300)
  }).parse(req.body);

  if (d.start_time === d.end_time) throw bad('Start and end time must differ');

  const result = await query(
    `INSERT INTO shifts
      (business_id,title,description,skills,location,lat,lng,radius_m,
       date,start_time,end_time,workers_needed,rate,status,job_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,'Open','ondemand')
     RETURNING id`,
    [
      req.user.id, d.title, d.description, d.skills.join(','),
      d.location, d.lat, d.lng, d.radius_m, d.date,
      d.start_time, d.end_time, d.rate
    ]
  );

  const id = result.rows[0].id;
  const workers = await query(`
    SELECT u.id,w.lat,w.lng
    FROM workers w JOIN users u ON u.id=w.user_id
    WHERE w.available=true AND w.kyc_status='Verified'
      AND u.status='Active' AND w.lat IS NOT NULL
  `);

  for (const w of workers.rows) {
    if (dist(d.lat, d.lng, Number(w.lat), Number(w.lng)) <= d.radius_m) {
      await notify(w.id, 'A nearby work request is available: ' + d.title);
    }
  }

  await audit(req, 'ondemand.job_create', 'shift', id);
  res.status(201).json({ ok: true, job_id: Number(id) });
}));

router.post('/workers/location', requireRole('worker'), wrap(async (req, res) => {
  const p = point.extend({ available: z.boolean().optional() }).parse(req.body);

  const activeResult = await query(`
    SELECT s.id FROM shifts s
    JOIN applications a ON a.shift_id=s.id
    WHERE a.worker_id=$1 AND a.status='Accepted'
      AND s.job_type='ondemand' AND s.status='Ongoing'
    LIMIT 1
  `, [req.user.id]);

  const active = activeResult.rows[0];
  if (p.available === true && active) {
    throw conflict('Complete your active job before becoming available.');
  }

  await tx(async client => {
    await client.query(
      `UPDATE workers SET lat=$1,lng=$2,
       available=COALESCE($3,available) WHERE user_id=$4`,
      [p.lat, p.lng, p.available ?? null, req.user.id]
    );

    if (active) {
      await client.query(`
        INSERT INTO job_locations(shift_id,lat,lng)
        VALUES($1,$2,$3)
        ON CONFLICT(shift_id) DO UPDATE
        SET lat=EXCLUDED.lat,lng=EXCLUDED.lng,updated_at=NOW()
      `, [active.id, p.lat, p.lng]);
    }
  });

  res.json({ ok: true });
}));

router.get('/jobs/nearby', requireRole('worker'), wrap(async (req, res) => {
  const p = point.parse(req.query);
  const radius = Math.min(50000, Math.max(100, Number(req.query.radius) || 15000));

  const eligible = await query(
    'SELECT available,kyc_status FROM workers WHERE user_id=$1',
    [req.user.id]
  );

  if (!eligible.rows[0]?.available || eligible.rows[0].kyc_status !== 'Verified') {
    return res.json({ jobs: [] });
  }

  const result = await query(`
    SELECT s.id,s.title,s.description,s.skills,s.location,s.lat,s.lng,
           s.date,s.start_time,s.end_time,s.rate,s.status,b.company
    FROM shifts s JOIN businesses b ON b.user_id=s.business_id
    WHERE s.job_type='ondemand' AND s.status='Open' AND s.lat IS NOT NULL
  `);

  const jobs = result.rows.map(j => ({
    ...j,
    distance_m: Math.round(dist(p.lat, p.lng, Number(j.lat), Number(j.lng)))
  })).filter(j => j.distance_m <= radius)
    .sort((a, b) => a.distance_m - b.distance_m);

  res.json({ jobs });
}));

router.get('/workers/nearby', requireRole('business', 'admin'), wrap(async (req, res) => {
  const p = point.parse(req.query);
  const radius = Math.min(50000, Math.max(100, Number(req.query.radius) || 10000));

  const result = await query(`
    SELECT u.id,u.name,w.skills,w.rating,w.kyc_status,w.lat,w.lng
    FROM workers w JOIN users u ON u.id=w.user_id
    WHERE u.status='Active' AND w.kyc_status='Verified'
      AND w.available=true AND w.lat IS NOT NULL
  `);

  const workers = result.rows.map(w => {
    const distance_m = Math.round(dist(p.lat, p.lng, Number(w.lat), Number(w.lng)));
    const { lat, lng, ...safe } = w;
    return { ...safe, distance_m };
  }).filter(w => w.distance_m <= radius)
    .sort((a, b) => a.distance_m - b.distance_m);

  res.json({ workers });
}));

router.get('/jobs/mine', requireRole('business', 'worker', 'admin'), wrap(async (req, res) => {
  let where = '';
  const params = [];

  if (req.user.role === 'business') {
    where = 'AND s.business_id=$1';
    params.push(req.user.id);
  } else if (req.user.role === 'worker') {
    where = 'AND a.worker_id=$1';
    params.push(req.user.id);
  }

  const result = await query(`
    SELECT s.id,s.title,s.location,s.lat,s.lng,s.date,s.start_time,s.end_time,
      s.rate,s.status,s.business_id,s.completion_requested_at,
      a.worker_id,u.name AS worker_name,b.company,
      jl.lat AS worker_lat,jl.lng AS worker_lng,jl.updated_at AS location_updated,
      jp.id AS job_payment_id,jp.amount AS job_amount,jp.fee AS job_fee,
      jp.status AS job_payment_status,jr.id AS rating_id,
      jr.rating,jr.feedback
    FROM shifts s
    LEFT JOIN applications a ON a.shift_id=s.id AND a.status='Accepted'
    LEFT JOIN users u ON u.id=a.worker_id
    JOIN businesses b ON b.user_id=s.business_id
    LEFT JOIN job_locations jl ON jl.shift_id=s.id
    LEFT JOIN job_payments jp ON jp.shift_id=s.id
    LEFT JOIN job_ratings jr ON jr.shift_id=s.id
    WHERE s.job_type='ondemand' ${where}
    ORDER BY s.id DESC
  `, params);

  if (req.user.role === 'worker') {
    return res.json({
      jobs: result.rows.map(({ rate, job_payment_id, job_amount, job_fee,
        job_payment_status, rating_id, rating, feedback, ...safe }) => safe)
    });
  }

  res.json({ jobs: result.rows });
}));

// Verify that the business can receive an arrival code before accepting a job.
router.post('/jobs/:id/request', requireRole('worker'), wrap(async (req, res, next) => {
  if (config.devOtpEnabled) return next();
  if (!config.otpSmsConfigured) {
    throw new HttpError(503, 'Configure Twilio before accepting jobs that require SMS verification.');
  }

  const s = await job(parseId(req.params.id));
  if (!s) throw notFound('Job not found');

  const u = await query('SELECT phone FROM users WHERE id=$1', [s.business_id]);
  if (!u.rows[0]?.phone) {
    throw new HttpError(503, 'The business account needs a phone number for arrival-code delivery.');
  }

  next();
}));

router.post('/jobs/:id/request', requireRole('worker'), wrap(async (req, res) => {
  const id = parseId(req.params.id);

  if (!config.devOtpEnabled && !config.otpSmsConfigured) {
    throw new HttpError(503, 'Configure Twilio before accepting jobs that require SMS verification.');
  }

  const workerResult = await query(`
    SELECT w.available,w.kyc_status,u.status
    FROM workers w JOIN users u ON u.id=w.user_id
    WHERE w.user_id=$1
  `, [req.user.id]);

  const w = workerResult.rows[0];
  if (!w?.available || w.status !== 'Active') throw conflict('Set availability before accepting work.');
  if (w.kyc_status !== 'Verified') throw forbidden('Worker verification is required.');

  const code = String(crypto.randomInt(100000, 1000000));
  const expires = new Date(Date.now() + 600000);
  const expiresAt = timestamp(expires);
  let output;

  await tx(async client => {
    const s = await job(id, client);
    if (!s) throw notFound('Job not found');
    if (s.status !== 'Open') throw conflict('This job is no longer available.');

    const assigned = await client.query(`
      SELECT 1 FROM applications a JOIN shifts s ON s.id=a.shift_id
      WHERE a.worker_id=$1 AND a.status='Accepted'
        AND s.status IN ('Filled','Ongoing') LIMIT 1
    `, [req.user.id]);

    if (assigned.rows.length) throw conflict('You already have an assigned job.');

    const app = await client.query(`
      INSERT INTO applications(shift_id,worker_id,status)
      VALUES($1,$2,'Accepted') RETURNING id
    `, [id, req.user.id]);

    const changed = await client.query(`
      UPDATE shifts SET status='Filled',start_otp_hash=$1
      WHERE id=$2 AND status='Open' RETURNING id
    `, [hash(id, code), id]);

    if (!changed.rows.length) throw conflict('This job is no longer available.');

    await client.query(`
      INSERT INTO job_verifications
        (shift_id,purpose,code_hash,code_ciphertext,expires_at)
      VALUES($1,'start',$2,$3,$4)
      ON CONFLICT(shift_id,purpose) DO UPDATE SET
        code_hash=EXCLUDED.code_hash,
        code_ciphertext=EXCLUDED.code_ciphertext,
        expires_at=EXCLUDED.expires_at,
        attempts=0,consumed_at=NULL
    `, [id, hash(id, code), encrypt(id, code), expiresAt]);

    // Prepare the finish code at acceptance; it is shown only in the worker portal
    // and is verified by the business after payment.
    const finishCode = String(crypto.randomInt(100000, 1000000));
    const finishExpires = timestamp(new Date(Date.now() + 24 * 60 * 60 * 1000));
    await client.query(`
      INSERT INTO job_verifications
        (shift_id,purpose,code_hash,code_ciphertext,expires_at)
      VALUES($1,'finish',$2,$3,$4)
      ON CONFLICT(shift_id,purpose) DO UPDATE SET
        code_hash=EXCLUDED.code_hash,
        code_ciphertext=EXCLUDED.code_ciphertext,
        expires_at=EXCLUDED.expires_at,
        attempts=0,consumed_at=NULL
    `, [id, hash(id, finishCode), encrypt(id, finishCode), finishExpires]);

    await client.query('UPDATE workers SET available=false WHERE user_id=$1', [req.user.id]);

    output = {
      business_id: s.business_id,
      application_id: app.rows[0].id
    };

    await notify(s.business_id, `${req.user.name} accepted your nearby job ${s.title}.`);
  });

  const owner = await query('SELECT phone FROM users WHERE id=$1', [output.business_id]);

  if (config.otpSmsConfigured && owner.rows[0]?.phone) {
    await sendSms(owner.rows[0].phone,
      `H-Staff job ${id} arrival code: ${code}. Expires in 10 minutes.`);
    await query(
      "UPDATE job_verifications SET delivery_status='sent' WHERE shift_id=$1 AND purpose='start'",
      [id]
    );
  }

  await audit(req, 'ondemand.worker_accept', 'shift', id);

  res.status(201).json({
    ok: true,
    application_id: Number(output.application_id),
    verification_expires_in: 600
  });
}));

router.get('/jobs/:id/otp/start', requireRole('business'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const s = await job(id);
  if (!s) throw notFound('Job not found');
  if (String(s.business_id) !== String(req.user.id)) throw forbidden();

  const result = await query(
    "SELECT * FROM job_verifications WHERE shift_id=$1 AND purpose='start'",
    [id]
  );

  const v = result.rows[0];
  if (!v || v.consumed_at || new Date(v.expires_at).getTime() <= Date.now()) {
    throw conflict('Arrival code expired or already used.');
  }

  if (config.devOtpEnabled) {
    return res.json({
      otp: decrypt(id, v.code_ciphertext),
      expires_at: v.expires_at,
      development: true
    });
  }

  const u = await query('SELECT phone FROM users WHERE id=$1', [req.user.id]);
  if (!config.otpSmsConfigured || !u.rows[0]?.phone) {
    throw new HttpError(503, 'Configure a verified phone and SMS provider.');
  }

  if (v.delivery_status !== 'sent') {
    await sendSms(u.rows[0].phone,
      `H-Staff arrival code for job ${id}: ${decrypt(id, v.code_ciphertext)}. Expires in 10 minutes.`);
    await query("UPDATE job_verifications SET delivery_status='sent' WHERE id=$1", [v.id]);
  }

  res.json({ sent: true, expires_at: v.expires_at, delivery: 'sms' });
}));

router.post('/jobs/:id/otp/start/resend', requireRole('business'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const s = await job(id);
  if (!s) throw notFound('Job not found');
  if (String(s.business_id) !== String(req.user.id)) throw forbidden();
  if (s.status !== 'Filled') throw conflict('Arrival codes can only be renewed before a job starts.');

  if (!config.devOtpEnabled && !config.otpSmsConfigured) {
    throw new HttpError(503, 'Configure Twilio before resending job codes.');
  }

  const previous = await query(
    "SELECT created_at FROM job_verifications WHERE shift_id=$1 AND purpose='start'",
    [id]
  );

  if (previous.rows[0] && Date.now() - new Date(previous.rows[0].created_at).getTime() < 60000) {
    throw conflict('Wait one minute before requesting another code.');
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const expires = timestamp(new Date(Date.now() + 600000));

  await tx(async client => {
    await client.query(`
      UPDATE job_verifications
      SET code_hash=$1,code_ciphertext=$2,expires_at=$3,
          attempts=0,consumed_at=NULL,created_at=NOW()
      WHERE shift_id=$4 AND purpose='start'
    `, [hash(id, code), encrypt(id, code), expires, id]);

    await client.query(
      'UPDATE shifts SET start_otp_hash=$1 WHERE id=$2',
      [hash(id, code), id]
    );
  });

  if (!config.devOtpEnabled) {
    if (!req.user.phone) {
      const u = await query('SELECT phone FROM users WHERE id=$1', [req.user.id]);
      if (!u.rows[0]?.phone) throw new HttpError(503, 'Business account needs a phone number.');
      await sendSms(u.rows[0].phone, `H-Staff arrival code for job ${id}: ${code}. Expires in 10 minutes.`);
    } else {
      await sendSms(req.user.phone, `H-Staff arrival code for job ${id}: ${code}. Expires in 10 minutes.`);
    }
    return res.json({ sent: true, expires_at: expires });
  }

  res.json({ otp: code, expires_at: expires, development: true });
}));


// Worker-only view of the two job codes. Codes are never returned to the business API.
router.get('/jobs/:id/codes', requireRole('worker'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const s = await job(id);
  if (!s) throw notFound('Job not found');
  const assigned = await query(
    "SELECT 1 FROM applications WHERE shift_id=$1 AND worker_id=$2 AND status='Accepted'",
    [id, req.user.id]
  );
  if (!assigned.rows.length) throw forbidden();
  if (!['Filled', 'Ongoing'].includes(s.status)) throw conflict('Codes are only available for active jobs.');

  const result = await query(
    "SELECT purpose,code_ciphertext,consumed_at,expires_at FROM job_verifications WHERE shift_id=$1 AND purpose IN ('start','finish')",
    [id]
  );
  const values = Object.fromEntries(result.rows.map(v => [v.purpose, {
    code: v.code_ciphertext && !v.consumed_at && new Date(v.expires_at).getTime() > Date.now()
      ? decrypt(id, v.code_ciphertext) : null,
    used: Boolean(v.consumed_at)
  }]));
  res.json({
    status: s.status,
    start: values.start || { code: null, used: false },
    finish: values.finish || { code: null, used: false }
  });
}));

router.post('/jobs/:id/codes/regenerate', requireRole('worker'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const s = await job(id);
  if (!s) throw notFound('Job not found');
  const assigned = await query(
    "SELECT 1 FROM applications WHERE shift_id=$1 AND worker_id=$2 AND status='Accepted'",
    [id, req.user.id]
  );
  if (!assigned.rows.length) throw forbidden();
  if (!['Filled', 'Ongoing'].includes(s.status)) throw conflict('Codes are only available for active jobs.');
  const purposes = s.status === 'Filled' ? ['start', 'finish'] : ['finish'];
  await tx(async client => {
    for (const purpose of purposes) {
      const code = String(crypto.randomInt(100000, 1000000));
      const expires = timestamp(new Date(Date.now() + (purpose === 'start' ? 10 : 24 * 60) * 60000));
      await client.query(`
        INSERT INTO job_verifications
          (shift_id,purpose,code_hash,code_ciphertext,expires_at)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(shift_id,purpose) DO UPDATE SET
          code_hash=EXCLUDED.code_hash,code_ciphertext=EXCLUDED.code_ciphertext,
          expires_at=EXCLUDED.expires_at,attempts=0,consumed_at=NULL,delivery_status='pending'
      `, [id, purpose, hash(id, code), encrypt(id, code), expires]);
      if (purpose === 'start') {
        await client.query('UPDATE shifts SET start_otp_hash=$1 WHERE id=$2', [hash(id, code), id]);
      }
    }
  });
  if (s.status === 'Filled' && config.otpSmsConfigured) {
    const owner = await query('SELECT phone FROM users WHERE id=$1', [s.business_id]);
    if (owner.rows[0]?.phone) {
      const codeRow = await query("SELECT code_ciphertext FROM job_verifications WHERE shift_id=$1 AND purpose='start'", [id]);
      await sendSms(owner.rows[0].phone, `H-Staff job ${id} arrival code: ${decrypt(id, codeRow.rows[0].code_ciphertext)}. Expires in 10 minutes.`);
      await query("UPDATE job_verifications SET delivery_status='sent' WHERE shift_id=$1 AND purpose='start'", [id]);
    }
  }
  await audit(req, 'ondemand.codes_regenerated', 'shift', id);
  res.json({ ok: true });
}));

router.post('/jobs/:id/verify-start', requireRole('worker'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { otp } = z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(req.body);
  let invalid = false;

  await tx(async client => {
    const s = await job(id, client);
    if (!s) throw notFound('Job not found');
    if (s.status !== 'Filled') throw conflict('Job is not awaiting arrival verification.');

    const application = await client.query(
      "SELECT 1 FROM applications WHERE shift_id=$1 AND worker_id=$2 AND status='Accepted'",
      [id, req.user.id]
    );
    if (!application.rows.length) throw forbidden();

    const result = await client.query(
      "SELECT * FROM job_verifications WHERE shift_id=$1 AND purpose='start' FOR UPDATE",
      [id]
    );

    const v = result.rows[0];
    if (!v || v.consumed_at || new Date(v.expires_at).getTime() <= Date.now()) {
      throw bad('Arrival code expired.');
    }

    if (Number(v.attempts) >= 5) throw new HttpError(429, 'Too many incorrect attempts.');

    const a = Buffer.from(hash(id, otp));
    const b = Buffer.from(v.code_hash);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await client.query('UPDATE job_verifications SET attempts=attempts+1 WHERE id=$1', [v.id]);
      invalid = true;
      return;
    }

    const updated = await client.query(`
      UPDATE job_verifications
      SET consumed_at=NOW(),code_ciphertext=NULL
      WHERE id=$1 AND consumed_at IS NULL AND attempts<5
        AND expires_at>NOW()
      RETURNING id
    `, [v.id]);

    if (!updated.rows.length) throw conflict('Code expired or already used.');

    await client.query(`
      UPDATE shifts SET otp_verified_at=NOW(),status='Ongoing'
      WHERE id=$1 AND status='Filled'
    `, [id]);

    await notify(s.business_id, `Arrival verified for ${s.title}.`);
  });

  if (invalid) throw bad('Arrival code is incorrect.');

  await audit(req, 'ondemand.start_verified', 'shift', id);
  res.json({ ok: true, status: 'Ongoing' });
}));


router.post('/jobs/:id/verify-finish', requireRole('business'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const { otp } = z.object({ otp: z.string().regex(/^\d{6}$/) }).parse(req.body);
  let invalid = false;
  let output = null;
  await tx(async client => {
    const found = await client.query(`
      SELECT s.*,a.worker_id
      FROM shifts s JOIN applications a ON a.shift_id=s.id AND a.status='Accepted'
      WHERE s.id=$1 AND s.job_type='ondemand'
      FOR UPDATE OF s
    `, [id]);
    const s = found.rows[0];
    if (!s) throw notFound('Job not found');
    if (String(s.business_id) !== String(req.user.id)) throw forbidden();
    if (s.status !== 'Ongoing') throw conflict('This job has not been started.');
    const payment = await client.query('SELECT * FROM job_payments WHERE shift_id=$1 FOR UPDATE', [id]);
    const pay = payment.rows[0];
    if (!pay || pay.status !== 'paid') throw conflict(`Please complete payment before finishing this job${pay?.amount ? ` (₹${pay.amount})` : ''}.`);
    const vResult = await client.query(
      "SELECT * FROM job_verifications WHERE shift_id=$1 AND purpose='finish' FOR UPDATE", [id]
    );
    const v = vResult.rows[0];
    if (!v || v.consumed_at || new Date(v.expires_at).getTime() <= Date.now()) {
      throw bad('Finish code expired. Ask the worker to create a new code.');
    }
    if (Number(v.attempts) >= 5) throw new HttpError(429, 'Too many incorrect attempts.');
    const a = Buffer.from(hash(id, otp));
    const b = Buffer.from(v.code_hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await client.query('UPDATE job_verifications SET attempts=attempts+1 WHERE id=$1', [v.id]);
      invalid = true;
      return;
    }
    const consumed = await client.query(`
      UPDATE job_verifications SET consumed_at=NOW(),code_ciphertext=NULL
      WHERE id=$1 AND consumed_at IS NULL AND attempts<5 AND expires_at>NOW()
      RETURNING id
    `, [v.id]);
    if (!consumed.rows.length) throw conflict('Finish code expired or already used.');
    await client.query(
      "UPDATE shifts SET status='Completed',completion_requested_at=COALESCE(completion_requested_at,NOW()) WHERE id=$1 AND status='Ongoing'",
      [id]
    );
    await client.query('UPDATE workers SET available=false WHERE user_id=$1', [s.worker_id]);
    await client.query('DELETE FROM job_locations WHERE shift_id=$1', [id]);
    await notify(s.worker_id, 'Finish code verified. Your job is complete.');
    output = { amount: Number(pay.amount), fee: Number(pay.fee) };
  });
  if (invalid) throw bad('Finish code is incorrect.');
  await audit(req, 'ondemand.finish_verified', 'shift', id);
  res.json({ ok: true, status: 'Completed', ...output });
}));

router.post('/jobs/:id/location', requireRole('worker'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const p = point.parse(req.body);
  const s = await job(id);

  if (!s) throw notFound('Job not found');

  const application = await query(
    "SELECT 1 FROM applications WHERE shift_id=$1 AND worker_id=$2 AND status='Accepted'",
    [id, req.user.id]
  );

  if (s.status !== 'Ongoing' || !application.rows.length) throw forbidden();

  await query(`
    INSERT INTO job_locations(shift_id,lat,lng)
    VALUES($1,$2,$3)
    ON CONFLICT(shift_id) DO UPDATE
    SET lat=EXCLUDED.lat,lng=EXCLUDED.lng,updated_at=NOW()
  `, [id, p.lat, p.lng]);

  res.json({ ok: true });
}));

router.get('/jobs/:id/location', requireRole('business', 'worker', 'admin'), wrap(async (req, res) => {
  const id = parseId(req.params.id);

  const result = await query(`
    SELECT s.*,a.worker_id FROM shifts s
    LEFT JOIN applications a ON a.shift_id=s.id AND a.status='Accepted'
    WHERE s.id=$1 AND s.job_type='ondemand'
  `, [id]);

  const s = result.rows[0];
  if (!s) throw notFound('Job not found');

  if (req.user.role === 'business' && String(s.business_id) !== String(req.user.id) ||
      req.user.role === 'worker' && String(s.worker_id) !== String(req.user.id)) {
    throw forbidden();
  }

  if (s.status !== 'Ongoing') throw conflict('Tracking is available during active work only.');

  const location = await query(
    'SELECT lat,lng,updated_at FROM job_locations WHERE shift_id=$1',
    [id]
  );

  res.json({
    available: Boolean(location.rows[0]),
    location: location.rows[0] || null
  });
}));

router.post('/jobs/:id/complete', requireRole('worker'), wrap(async (req, res) => {
  const id = parseId(req.params.id);

  await tx(async client => {
    const s = await job(id, client);
    if (!s) throw notFound();
    if (s.status !== 'Ongoing') throw conflict('Only an active job can be completed.');
    if (s.completion_requested_at) throw conflict('Completion has already been submitted.');

    const application = await client.query(
      "SELECT 1 FROM applications WHERE shift_id=$1 AND worker_id=$2 AND status='Accepted'",
      [id, req.user.id]
    );
    if (!application.rows.length) throw forbidden();

    await client.query(
      'UPDATE shifts SET completion_requested_at=NOW() WHERE id=$1',
      [id]
    );

    await notify(s.business_id, `Worker marked ${s.title} complete. Confirm when ready.`);
  });

  res.json({ ok: true, status: 'completion_pending_confirmation' });
}));

router.post('/jobs/:id/confirm-completion', requireRole('business'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  let output;

  await tx(async client => {
    const result = await client.query(`
      SELECT s.*,a.worker_id
      FROM shifts s
      JOIN applications a ON a.shift_id=s.id AND a.status='Accepted'
      WHERE s.id=$1 AND s.job_type='ondemand'
      FOR UPDATE OF s
    `, [id]);

    const s = result.rows[0];
    if (!s) throw notFound();
    if (String(s.business_id) !== String(req.user.id)) throw forbidden();
    if (s.status !== 'Ongoing' || !s.completion_requested_at) {
      throw conflict('Worker has not submitted completion.');
    }

    const start = new Date(s.otp_verified_at).getTime();
    const end = new Date(s.completion_requested_at).getTime();
    const hours = Math.max(0.25, Math.round((end - start) / 3600000 * 4) / 4);
    const amount = Math.max(1, Math.round(hours * Number(s.rate)));
    const fee = Math.round(amount * config.platformFeePercent / 100);

    await client.query(
      "UPDATE shifts SET status='Completed' WHERE id=$1 AND status='Ongoing'",
      [id]
    );

    await client.query(`
      INSERT INTO job_payments(shift_id,business_id,worker_id,amount,fee)
      VALUES($1,$2,$3,$4,$5)
    `, [id, s.business_id, s.worker_id, amount, fee]);

    await client.query('UPDATE workers SET available=false WHERE user_id=$1', [s.worker_id]);
    await client.query('DELETE FROM job_locations WHERE shift_id=$1', [id]);
    await notify(s.worker_id, 'Completion confirmed.');

    output = { amount, fee };
  });

  await audit(req, 'ondemand.completion_confirmed', 'shift', id);
  res.json({ ok: true, status: 'Completed', ...output });
}));

router.post('/jobs/:id/ratings', requireRole('business'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const d = z.object({
    rating: z.number().int().min(1).max(5),
    feedback: z.string().trim().max(1000).optional().default('')
  }).parse(req.body);

  await tx(async client => {
    const result = await client.query(`
      SELECT s.*,a.worker_id FROM shifts s
      JOIN applications a ON a.shift_id=s.id AND a.status='Accepted'
      WHERE s.id=$1 AND s.job_type='ondemand'
      FOR UPDATE OF s
    `, [id]);

    const s = result.rows[0];
    if (!s) throw notFound();
    if (String(s.business_id) !== String(req.user.id)) throw forbidden();
    if (s.status !== 'Completed') throw conflict('Confirm completion before rating.');

    const existing = await client.query(
      'SELECT 1 FROM job_ratings WHERE shift_id=$1',
      [id]
    );
    if (existing.rows.length) throw conflict('Feedback has already been submitted.');

    await client.query(`
      INSERT INTO job_ratings(shift_id,business_id,worker_id,rating,feedback)
      VALUES($1,$2,$3,$4,$5)
    `, [id, req.user.id, s.worker_id, d.rating, d.feedback]);

    await client.query(`
      UPDATE workers
      SET rating=(SELECT AVG(rating) FROM job_ratings WHERE worker_id=$1)
      WHERE user_id=$1
    `, [s.worker_id]);

    await notify(s.worker_id, `You received a ${d.rating}-star rating.`);
  });

  res.status(201).json({ ok: true });
}));

router.get('/jobs/:id/verification', requireRole('business', 'admin'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  const s = await job(id);
  if (!s) throw notFound();
  if (req.user.role === 'business' && String(s.business_id) !== String(req.user.id)) {
    throw forbidden();
  }

  res.json({
    job_id: id,
    status: s.status,
    started: Boolean(s.otp_verified_at),
    completion_requested: Boolean(s.completion_requested_at)
  });
}));
