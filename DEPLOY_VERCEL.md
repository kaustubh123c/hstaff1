# HStaff — Vercel + Supabase deployment notes

## What this package configures
- Vite builds the React frontend into `.hstaff-build`.
- `api/[...path].js` exposes the existing Express API as a Vercel Node function.
- The active API is `server/src/index.js` (PostgreSQL routes), not `backend-fastapi/`.
- `DATABASE_URL` is read only by the backend. Never expose it with a `VITE_` prefix.

## Vercel project settings
Import the repository root (the folder containing this `vercel.json`). Use:
- Framework preset: Other (or Vite if auto-detected)
- Install command: `npm install && npm install --prefix server`
- Build command: `npm run build`
- Output directory: `.hstaff-build`
- Node.js: 22.x

## Vercel environment variables
Set these in Project → Settings → Environment Variables (Production and Preview as appropriate):
- `NODE_ENV` = `production`
- `DATABASE_URL` = Supabase **Transaction pooler** connection URI (port 6543)
- `JWT_SECRET` = a long random secret (at least 48 random bytes recommended)
- `QR_SECRET` = a separate long random secret
- `CORS_ORIGIN` = the exact deployed frontend origin, e.g. `https://YOUR-PROJECT.vercel.app` (comma-separate additional trusted origins)
- `DEMO_MODE` = `false`
- `DEV_OTP_ENABLED` = `false`
- `DEV_ADMIN_REGISTRATION_ENABLED` = `false`
- `DATA_DIR` = `/tmp/hstaff-data`
- `UPLOAD_DIR` = `/tmp/hstaff-data/uploads`
- `PG_POOL_MAX` = `3`

Optional only when actually configured: `GOOGLE_CLIENT_ID`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID`, `CRON_SECRET`.

Set `VITE_GOOGLE_CLIENT_ID` at build time only if Google sign-in is enabled. Do not add secrets to any `VITE_` variable.

## Supabase connection
In Supabase Dashboard → Connect → Transaction pooler, copy the URI for port 6543. Use the username and host exactly as provided by Supabase; do not construct the pooler hostname yourself. URL-encode special characters in the database password. The existing `pg` driver is configured with a small pool for serverless use.

## Database prerequisite
This repository has PostgreSQL query code but does not include a complete, versioned PostgreSQL schema migration. The `docs/DATABASE_SCHEMA.md` describes the legacy SQLite schema and is not a PostgreSQL DDL script. Before deployment, confirm that the Supabase project already has every table/column/index expected by `server/src/routes/*-postgres.js`. Do not run the SQLite `npm run seed` script against Supabase; it imports `node:sqlite` and writes to a local SQLite file. Do not run `migrate-sqlite-data-to-supabase.mjs` blindly: that script expects a very specific one-user/one-business/one-shift source database and performs a limited migration.

## Important production blocker: KYC file storage
`server/src/routes/kyc-postgres.js` uses `multer.diskStorage()` and stores document bytes under `UPLOAD_DIR`. Vercel function filesystems are ephemeral; `/tmp` is not durable storage. KYC uploads may disappear between invocations or cold starts. Before enabling real KYC uploads, change this route to upload/download/delete objects in a **private Supabase Storage bucket**, store the bucket object path in PostgreSQL, and use authenticated server-side access or short-lived signed URLs. Do not use a public bucket for identity documents. This package does not pretend that ephemeral disk is persistent.

## Deploy steps
1. Create a private GitHub repository and push the contents of this folder (not the ZIP itself).
2. In Vercel, Add New → Project → Import the GitHub repository.
3. Set the project settings listed above.
4. Add the environment variables and redeploy.
5. Test `https://YOUR-PROJECT.vercel.app/api/health` and `/api/health/supabase`.
6. Test user/admin auth and all critical flows using non-production test accounts before launch.
7. Configure Supabase Storage for KYC before allowing document uploads.

## Local commands (Windows PowerShell)
```powershell
npm install
npm install --prefix server
npm run build
```

Do not commit `.env`, `server/.env`, database files, backups, or Supabase service credentials.
