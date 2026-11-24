-- H-Staff on-demand start/finish OTP lifecycle (Supabase/PostgreSQL)
CREATE TABLE IF NOT EXISTS job_verifications (
  id BIGSERIAL PRIMARY KEY,
  shift_id BIGINT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('start','finish')),
  code_hash TEXT NOT NULL,
  code_ciphertext TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shift_id, purpose)
);
CREATE INDEX IF NOT EXISTS idx_job_verifications_active
  ON job_verifications (shift_id, purpose, expires_at)
  WHERE consumed_at IS NULL;
