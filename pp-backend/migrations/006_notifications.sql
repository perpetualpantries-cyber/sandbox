-- Approval notifications for PP staff (PPcanopy): phone/desktop push subscriptions, plus a small
-- key/value table for server-generated settings (the Web Push VAPID key pair lives here, so push
-- works without any environment variables).
CREATE TABLE IF NOT EXISTS server_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    UUID NOT NULL REFERENCES pp_staff(id) ON DELETE CASCADE,
  endpoint    TEXT UNIQUE NOT NULL,
  keys        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS push_subscriptions_staff ON push_subscriptions(staff_id);
