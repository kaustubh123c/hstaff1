
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

import { query, tx } from '../db-postgres.js';
import { signToken, authenticate } from '../auth-postgres.js';
import {
  wrap, bad, conflict, audit, HttpError, sendSms
} from '../util-postgres.js';
import { config } from '../config.js';
import { verifyGoogleIdentityToken } from '../google-auth.js';
import { createAdminAccountPostgres } from '../admin-provision-postgres.js';

export const router = Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 500 : 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' }
});

const password = z.string().min(8, 'Password must be at least 8 characters').max(100);
const phoneSchema = z.string().trim().regex(/^\+?[1-9]\d{9,14}$/);

const otpHash = (phone, code) =>
  crypto.createHmac('sha256', config.jwtSecret)
    .update(`${phone}:${code}`).digest('hex');

const databaseRole = role => role === 'user' ? 'business' : role;

const normalizePhone = phone =>
  phone ? (phone.startsWith('+') ? phone : `+${phone}`) : null;

const registerSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('worker'),
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().email(),
    password,
    phone: z.string().trim().max(20).optional(),
    skills: z.string().trim().max(200).optional(),
    location: z.string().trim().max(120).optional()
  }),
  z.object({
    role: z.literal('user'),
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().email(),
    password,
    phone: z.string().trim().max(20).optional()
  })
]);

async function publicUser(id) {
  const result = await query(
    `SELECT id, email, role, name, phone, status, created_at
     FROM users WHERE id = $1`,
    [id]
  );

  const user = result.rows[0];
  if (!user) return null;

  if (user.role === 'business') {
    const profile = await query(
      'SELECT company, address FROM businesses WHERE user_id = $1',
      [id]
    );
    user.profile = profile.rows[0] ?? null;
  }

  if (user.role === 'worker') {
    const profile = await query(
      `SELECT skills, location, rating, kyc_status, available
       FROM workers WHERE user_id = $1`,
      [id]
    );
    user.profile = profile.rows[0] ?? null;
  }

  return user;
}

// Request a phone OTP.
router.post('/otp/request', limiter, wrap(async (req, res) => {
  const d = z.object({
    phone: phoneSchema,
    role: z.enum(['worker', 'user']).optional(),
    name: z.string().trim().min(2).max(80).optional(),
    email: z.string().trim().email().optional(),
    skills: z.string().trim().max(200).optional(),
    location: z.string().trim().max(120).optional()
  }).parse(req.body);

  const localOtp = config.devOtpEnabled;

  if (!localOtp && !config.otpSmsConfigured) {
    throw new HttpError(
      503,
      'SMS delivery is unavailable. Configure Twilio credentials in server/.env.'
    );
  }

  const phone = normalizePhone(d.phone);

  const users = await query(
    'SELECT COUNT(*)::integer AS n FROM users WHERE phone = $1',
    [phone]
  );

  if (users.rows[0].n > 1) {
    throw conflict('This phone number is linked to multiple accounts. Contact support.');
  }

  const recent = await query(
    'SELECT requested_at FROM auth_otps WHERE phone = $1',
    [phone]
  );

  if (
    !localOtp &&
    recent.rows[0]?.requested_at &&
    Date.now() - new Date(recent.rows[0].requested_at).getTime() < 60000
  ) {
    throw conflict('Please wait one minute before requesting another code.');
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const expires = new Date(Date.now() + config.otpTtlSeconds * 1000);

  const delivered = localOtp
    ? false
    : await sendSms(
        phone,
        `Your H-Staff sign-in code is ${code}. It expires in ${Math.ceil(config.otpTtlSeconds / 60)} minutes.`
      );

  await query(
    `INSERT INTO auth_otps
      (phone, code_hash, expires_at, attempts, requested_at, consumed_at)
     VALUES ($1, $2, $3, 0, $4, NULL)
     ON CONFLICT (phone) DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       attempts = 0,
       requested_at = EXCLUDED.requested_at,
       consumed_at = NULL`,
    [phone, otpHash(phone, code), expires, delivered ? new Date() : null]
  );

  res.json({
    ok: true,
    expires_in: config.otpTtlSeconds,
    ...(localOtp ? { development_otp: code } : {}),
    delivery: localOtp ? 'development' : 'sms'
  });
}));

// Verify a phone OTP and sign in or create an account.
router.post('/otp/verify', limiter, wrap(async (req, res) => {
  const d = z.object({
    phone: phoneSchema,
    otp: z.string().regex(/^\d{6}$/),
    role: z.enum(['worker', 'user']).optional(),
    name: z.string().trim().min(2).max(80).optional(),
    email: z.string().trim().email().optional(),
    skills: z.string().trim().max(200).optional(),
    location: z.string().trim().max(120).optional()
  }).parse(req.body);

  const phone = normalizePhone(d.phone);

  const result = await tx(async client => {
    const otpResult = await client.query(
      'SELECT * FROM auth_otps WHERE phone = $1 FOR UPDATE',
      [phone]
    );

    const row = otpResult.rows[0];

    if (
      !row ||
      row.consumed_at ||
      new Date(row.expires_at).getTime() <= Date.now()
    ) {
      throw new HttpError(400, 'The code is invalid or expired. Request a new code.');
    }

    if (row.attempts >= 5) {
      throw new HttpError(429, 'Too many incorrect codes. Request a new code.');
    }

    const actual = Buffer.from(row.code_hash, 'hex');
    const expected = Buffer.from(otpHash(phone, d.otp), 'hex');

    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) {
      await client.query(
        'UPDATE auth_otps SET attempts = attempts + 1 WHERE phone = $1',
        [phone]
      );

      // Return instead of throwing so the attempt increment commits.
      return { invalidCode: true };
    }

    const userResult = await client.query(
      'SELECT * FROM users WHERE phone = $1 FOR UPDATE',
      [phone]
    );

    let user = userResult.rows[0];
    let created = false;

    if (!user) {
      if (!d.role) {
        throw bad('Choose Worker or User to create your account.');
      }

      const email = d.email ||
        `${phone.replace(/\D/g, '')}@phone.hstaff.local`;

      const duplicate = await client.query(
        'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );

      if (duplicate.rowCount) {
        throw conflict('That email is already in use. Sign in with the existing account.');
      }

      const role = databaseRole(d.role);
      const passwordHash = await bcrypt.hash(
        crypto.randomBytes(32).toString('hex'),
        12
      );

      const inserted = await client.query(
        `INSERT INTO users
          (email, password_hash, role, name, phone)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          email,
          passwordHash,
          role,
          d.name ?? (role === 'worker' ? 'Worker profile' : 'User profile'),
          phone
        ]
      );

      user = inserted.rows[0];

      if (role === 'worker') {
        await client.query(
          'INSERT INTO workers (user_id, skills, location) VALUES ($1, $2, $3)',
          [user.id, d.skills ?? '', d.location ?? null]
        );
      } else {
        await client.query(
          'INSERT INTO businesses (user_id, company) VALUES ($1, $2)',
          [user.id, d.name ?? 'User']
        );
      }

      created = true;
    }

    if (user.role === 'admin') {
      throw new HttpError(
        403,
        'Administrators must sign in with their provisioned email and password.'
      );
    }

    if (user.status !== 'Active') {
      throw new HttpError(403, 'This account is suspended');
    }

    await client.query(
      'DELETE FROM auth_otps WHERE phone = $1',
      [phone]
    );

    return { user, created };
  });

  if (result.invalidCode) {
    throw new HttpError(400, 'The code is incorrect.');
  }

  req.user = result.user;

  await audit(
    req,
    result.created ? 'auth.phone_register' : 'auth.phone_otp',
    'user',
    result.user.id
  );

  const onboardingIncomplete =
    ['Worker profile', 'User profile'].includes(result.user.name);

  res.json({
    token: signToken(result.user),
    user: await publicUser(result.user.id),
    ...(result.created || onboardingIncomplete ? { created: true } : {})
  });
}));

// Register using email and password.
router.post('/register', limiter, wrap(async (req, res) => {
  const d = registerSchema.parse(req.body);
  const role = databaseRole(d.role);
  const phone = normalizePhone(d.phone);
  const hash = await bcrypt.hash(d.password, 12);

  const id = await tx(async client => {
    const duplicate = await client.query(
      `SELECT 1 FROM users
       WHERE LOWER(email) = LOWER($1)
          OR ($2::text IS NOT NULL AND phone = $2)`,
      [d.email, phone]
    );

    if (duplicate.rowCount) {
      throw conflict('This email or phone number is already registered.');
    }

    const inserted = await client.query(
      `INSERT INTO users
        (email, password_hash, role, name, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [d.email, hash, role, d.name, phone]
    );

    const userId = inserted.rows[0].id;

    if (role === 'worker') {
      await client.query(
        'INSERT INTO workers (user_id, skills, location) VALUES ($1, $2, $3)',
        [userId, d.skills ?? '', d.location ?? null]
      );
    } else {
      await client.query(
        'INSERT INTO businesses (user_id, company, address) VALUES ($1, $2, $3)',
        [userId, d.name, null]
      );
    }

    return userId;
  });

  req.user = { id };

  await audit(req, 'auth.register', 'user', id, d.role);

  res.status(201).json({
    token: signToken({ id, role }),
    user: await publicUser(id)
  });
}));

// Development-only local admin registration.
router.post('/admin/register', limiter, wrap(async (req, res) => {
  const localAddresses = new Set([
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1'
  ]);

  if (
    !config.devAdminRegistrationEnabled ||
    !localAddresses.has(req.socket.remoteAddress)
  ) {
    throw new HttpError(404, 'Admin self-registration is unavailable.');
  }

  const d = z.object({
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().email().max(254),
    password: z.string().min(12).max(100)
  }).parse(req.body);

  const id = await createAdminAccountPostgres(
    d,
    { source: 'development Admin sign-up page' }
  );

  res.status(201).json({
    ok: true,
    user: { id, name: d.name, email: d.email, role: 'admin' }
  });
}));

// Google login and registration.
router.post('/google', limiter, wrap(async (req, res) => {
  const d = z.object({
    credential: z.string().min(100).max(8192),
    intent: z.enum(['user', 'worker', 'admin'])
  }).parse(req.body);

  const identity = await verifyGoogleIdentityToken(d.credential);

  const result = await tx(async client => {
    const bySubjectResult = await client.query(
      'SELECT * FROM users WHERE google_sub = $1 FOR UPDATE',
      [identity.sub]
    );

    const byEmailResult = await client.query(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1) FOR UPDATE',
      [identity.email]
    );

    const bySubject = bySubjectResult.rows[0];
    const byEmail = byEmailResult.rows[0];

    if (
      bySubject &&
      byEmail &&
      String(bySubject.id) !== String(byEmail.id)
    ) {
      throw new HttpError(
        409,
        'This Google identity and email are associated with different accounts. Contact support.'
      );
    }

    let user = bySubject || byEmail;
    let created = false;

    if (d.intent === 'admin') {
      if (!user || user.role !== 'admin') {
        throw new HttpError(
          403,
          'Google sign-in is available only to an existing authorized administrator account.'
        );
      }
    } else if (user?.role === 'admin') {
      throw new HttpError(
        403,
        'Use the separate Admin sign-in option for this administrator account.'
      );
    } else if (user && user.role !== databaseRole(d.intent)) {
      throw new HttpError(
        403,
        `This Google account belongs to a ${user.role === 'worker' ? 'Worker' : 'User'} account. Choose the matching account type.`
      );
    }

    if (user?.google_sub && user.google_sub !== identity.sub) {
      throw new HttpError(
        409,
        'This account is linked to a different Google identity. Contact support.'
      );
    }

    if (!user) {
      const dbRole = databaseRole(d.intent);
      const passwordHash = await bcrypt.hash(
        crypto.randomBytes(32).toString('hex'),
        12
      );

      const inserted = await client.query(
        `INSERT INTO users
          (email, password_hash, role, name, google_sub)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [identity.email, passwordHash, dbRole, identity.name, identity.sub]
      );

      user = inserted.rows[0];

      if (dbRole === 'worker') {
        await client.query(
          'INSERT INTO workers (user_id, skills, location) VALUES ($1, $2, $3)',
          [user.id, '', null]
        );
      } else {
        await client.query(
          'INSERT INTO businesses (user_id, company) VALUES ($1, $2)',
          [user.id, identity.name]
        );
      }

      created = true;
    } else if (!user.google_sub) {
      const linked = await client.query(
        'UPDATE users SET google_sub = $1 WHERE id = $2 RETURNING *',
        [identity.sub, user.id]
      );
      user = linked.rows[0];
    }

    if (user.status !== 'Active') {
      throw new HttpError(403, 'This account is suspended');
    }

    return { user, created };
  });

  req.user = result.user;

  await audit(
    req,
    result.created ? 'auth.google_register' : 'auth.google_login',
    'user',
    result.user.id,
    result.user.role
  );

  res.json({
    token: signToken(result.user),
    user: await publicUser(result.user.id),
    ...(result.created ? { created: true } : {})
  });
}));

// Email and password login.
router.post('/login', limiter, wrap(async (req, res) => {
  const { email, password: pw } = z.object({
    email: z.string().trim().email(),
    password: z.string().min(1)
  }).parse(req.body);

  const result = await query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
    [email]
  );

  const user = result.rows[0];

  const dummyHash =
    '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';

  const valid = await bcrypt.compare(
    pw,
    user?.password_hash ?? dummyHash
  );

  if (!user || !valid) {
    throw new HttpError(401, 'Incorrect email or password');
  }

  if (user.status !== 'Active') {
    throw new HttpError(403, 'This account is suspended');
  }

  req.user = user;

  await audit(req, 'auth.login', 'user', user.id);

  res.json({
    token: signToken(user),
    user: await publicUser(user.id)
  });
}));

// Get the currently authenticated user's profile.
router.get('/me', authenticate, wrap(async (req, res) => {
  const user = await publicUser(req.user.id);

  if (!user) {
    throw new HttpError(404, 'User account not found.');
  }

  res.json({ user });
}));

// Update profile.
router.put('/me', authenticate, wrap(async (req, res) => {
  const d = z.object({
    name: z.string().trim().min(2).max(80).optional(),
    email: z.string().trim().email().optional(),
    phone: z.string().trim().max(20).optional(),
    skills: z.string().trim().max(200).optional(),
    location: z.string().trim().max(120).optional(),
    company: z.string().trim().min(2).max(120).optional(),
    address: z.string().trim().max(200).optional()
  }).parse(req.body);

  const email = d.email?.trim();
  const phone = d.phone === undefined ? undefined : normalizePhone(d.phone);

  await tx(async client => {
    if (email) {
      const duplicate = await client.query(
        `SELECT 1 FROM users
         WHERE LOWER(email) = LOWER($1) AND id <> $2`,
        [email, req.user.id]
      );

      if (duplicate.rowCount) {
        throw conflict('That email is already in use.');
      }
    }

    if (phone) {
      const duplicate = await client.query(
        'SELECT 1 FROM users WHERE phone = $1 AND id <> $2',
        [phone, req.user.id]
      );

      if (duplicate.rowCount) {
        throw conflict('That phone number is already linked to another account.');
      }
    }

    await client.query(
      `UPDATE users SET
         name = COALESCE($1, name),
         email = COALESCE($2, email),
         phone = COALESCE($3, phone)
       WHERE id = $4`,
      [d.name ?? null, email ?? null, phone ?? null, req.user.id]
    );

    if (req.user.role === 'worker') {
      await client.query(
        `UPDATE workers SET
           skills = COALESCE($1, skills),
           location = COALESCE($2, location)
         WHERE user_id = $3`,
        [d.skills ?? null, d.location ?? null, req.user.id]
      );
    }

    if (req.user.role === 'business') {
      await client.query(
        `UPDATE businesses SET
           company = CASE
             WHEN $1::text IS NOT NULL THEN $1
             WHEN company = 'User' THEN $2
             ELSE company
           END,
           address = COALESCE($3, address)
         WHERE user_id = $4`,
        [d.company ?? null, d.name ?? null, d.address ?? null, req.user.id]
      );
    }
  });

  await audit(req, 'profile.update', 'user', req.user.id);

  res.json({ user: await publicUser(req.user.id) });
}));

// Change password.
router.post('/change-password', authenticate, limiter, wrap(async (req, res) => {
  const d = z.object({
    current: z.string().min(1),
    next: password
  }).parse(req.body);

  const result = await query(
    'SELECT password_hash FROM users WHERE id = $1',
    [req.user.id]
  );

  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(d.current, user.password_hash))) {
    throw bad('Current password is incorrect');
  }

  const hash = await bcrypt.hash(d.next, 12);

  await query(
    'UPDATE users SET password_hash = $1 WHERE id = $2',
    [hash, req.user.id]
  );

  await audit(req, 'auth.password_change', 'user', req.user.id);

  res.json({ ok: true });
}));
