DO $$ BEGIN
  CREATE TYPE kyc_status AS ENUM ('unverified', 'verified', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS user_kyc (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status kyc_status NOT NULL DEFAULT 'unverified',
  nin_hash TEXT NOT NULL,
  nin_last4 TEXT NOT NULL,
  dob DATE NOT NULL,
  nin_card_data_url TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_kyc_nin_hash ON user_kyc (nin_hash);
