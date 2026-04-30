DO $$ BEGIN
  CREATE TYPE notification_type AS ENUM (
    'join_request_created',
    'join_request_approved',
    'join_request_rejected',
    'contribution_submitted',
    'contribution_confirmed',
    'contribution_rejected',
    'payout_recorded'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type notification_type NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id, read_at) WHERE read_at IS NULL;
