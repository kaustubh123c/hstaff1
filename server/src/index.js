import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ZodError } from 'zod';

import { config } from './config.js';
import { query as pgQuery } from './db-postgres.js';
import { HttpError, notify, pad } from './util-postgres.js';
import { createPaymentForTimesheet } from './services-postgres.js';

import { getSettings } from './routes/admin-postgres.js';
import { router as authRouter } from './routes/auth-postgres.js';
import { router as shiftsRouter, applicationsRouter } from './routes/shifts-postgres.js';
import { router as attendanceRouter } from './routes/attendance-postgres.js';
import { router as timesheetsRouter } from './routes/timesheets-postgres.js';
import { router as paymentsRouter, razorpayWebhook } from './routes/payments-postgres.js';
import { router as kycRouter } from './routes/kyc-postgres.js';
import { router as disputesRouter } from './routes/disputes-postgres.js';
import { router as adminRouter } from './routes/admin-postgres.js';
import { router as miscRouter } from './routes/misc-postgres.js';
import { router as onDemandRouter } from './routes/marketplace-postgres.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com'],
        frameSrc: ["'self'", 'https://accounts.google.com'],
        connectSrc: ["'self'", 'https://accounts.google.com', 'https://www.googleapis.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://*.gstatic.com']
      }
    }
  }));

  app.use(cors({
    origin: config.corsOrigin.split(','),
    credentials: false
  }));

  app.use(express.json({
    limit: '100kb',
    verify: (req, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    }
  }));

  app.use('/api', rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false
  }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.get('/api/health/supabase', async (_req, res) => {
    try {
      await pgQuery('SELECT 1');
      res.json({ ok: true, supabase: 'connected' });
    } catch (error) {
      console.error('Supabase health check failed:', error.message);
      res.status(503).json({ ok: false, supabase: 'unavailable' });
    }
  });

  // Vercel Cron: automatic timesheet approval
  app.get('/api/cron/auto-approve', async (req, res) => {
    const secret = process.env.CRON_SECRET;

    if (!secret || req.get('authorization') !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const approved = await autoApproveTimesheets();
      res.json({ ok: true, approved });
    } catch (error) {
      console.error('Auto-approval failed:', error);
      res.status(500).json({ error: 'Automatic approval failed' });
    }
  });

  // Razorpay webhook
  app.post('/api/payments/razorpay-webhook', (req, res) => {
    void razorpayWebhook(req, res);
  });

  // Application routes — PostgreSQL versions
  app.use('/api/auth', authRouter);
  app.use('/api/shifts', shiftsRouter);
  app.use('/api/applications', applicationsRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/timesheets', timesheetsRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/kyc', kycRouter);
  app.use('/api/disputes', disputesRouter);

  // Public meta endpoint is kept before authenticated miscellaneous routes.
  app.use('/api', miscRouter);
  app.use('/api', onDemandRouter);
  app.use('/api/admin', adminRouter);

  app.use('/api', (_req, _res, next) => {
    next(new HttpError(404, 'Endpoint not found'));
  });

  // Serve the built frontend in production.
  if (fs.existsSync(path.join(config.distDir, 'index.html'))) {
    app.use(express.static(config.distDir));
    app.get(/^\/(?!api).*/, (_req, res) => {
      res.sendFile(path.join(config.distDir, 'index.html'));
    });
  }

  // Central error handler.
  app.use((err, _req, res, _next) => {
    if (err instanceof ZodError) {
      const msg = err.issues
        .map(i => `${i.path.join('.') || 'request'}: ${i.message}`)
        .join('; ');

      return res.status(400).json({
        error: msg,
        details: err.issues
      });
    }

    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File is too large (max 5 MB)' });
    }

    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON body' });
    }

    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }

    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side' });
  });

  return app;
}

// Automatically approve timesheets that have remained pending.
export async function autoApproveTimesheets() {
  const settings = await getSettings();
  const hours = Number(settings.auto_approve_hours);

  if (!Number.isFinite(hours) || hours <= 0) return 0;

  const result = await pgQuery(
    `SELECT * FROM timesheets
     WHERE status = 'Pending'
       AND created_at <= NOW() - ($1::int * INTERVAL '1 hour')
     ORDER BY id`,
    [hours]
  );

  let approved = 0;

  for (const t of result.rows) {
    const updated = await pgQuery(
      `UPDATE timesheets
       SET status = 'Approved', decided_at = NOW()
       WHERE id = $1 AND status = 'Pending'
       RETURNING *`,
      [t.id]
    );

    if (!updated.rows.length) continue;

    const timesheet = updated.rows[0];

    await createPaymentForTimesheet(timesheet);

    await notify(
      timesheet.worker_id,
      `Timesheet ${pad('TS', timesheet.id)} was auto-approved after ${hours}h.`
    );

    await pgQuery(
      `INSERT INTO audit_logs (action, entity, entity_id, detail)
       VALUES ($1, $2, $3, $4)`,
      [
        'timesheet.auto_approve',
        'timesheet',
        String(timesheet.id),
        `after ${hours}h`
      ]
    );

    approved++;
  }

  return approved;
}

// Start the server directly when this file is executed.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const start = async () => {
    const existing = await pgQuery('SELECT 1 FROM users LIMIT 1');

    if (!existing.rows.length) {
      console.log('PostgreSQL database is empty. Run the database seed process.');
    }

    createApp().listen(config.port, () => {
      console.log(`H-Staff API listening on http://localhost:${config.port}`);
    });

    setInterval(() => {
      autoApproveTimesheets().catch(error => {
        console.error('Automatic timesheet approval failed:', error);
      });
    }, 10 * 60 * 1000).unref();
  };

  start().catch(error => {
    console.error('H-Staff server startup failed:', error);
    process.exitCode = 1;
  });
}
