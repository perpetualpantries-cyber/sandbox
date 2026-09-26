-- ============================================================================
-- Perpetual Pantries backend — Phase 1A core schema
-- Subset of pp_schema.sql needed for linking, snapshots, Ronin<->Gavin messages
-- and Canopy<->Ronin asks, plus the deltas from PP_Backend_API_Spec.md §6.
-- Idempotent: safe to re-run.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Identity ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orgs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  sector        TEXT,
  api_key_hash  TEXT NOT NULL,
  api_key_hint  TEXT NOT NULL,                     -- last 4 chars, for the UI
  command_tier  TEXT NOT NULL DEFAULT 'compliance',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  external_venue_id TEXT UNIQUE,                   -- PP's own cafeDetails.id
  name              TEXT NOT NULL,
  suburb            TEXT,
  state             TEXT,
  tier              TEXT NOT NULL DEFAULT 'T1',
  timezone          TEXT NOT NULL DEFAULT 'Australia/Melbourne',
  org_may_approve   BOOLEAN NOT NULL DEFAULT false, -- org console may approve Ronin->Gavin requests on the site's behalf
  share_payroll     BOOLEAN NOT NULL DEFAULT false,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS link_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  code        TEXT UNIQUE NOT NULL,
  hint        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending, used, expired, revoked
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  site_id     UUID REFERENCES sites(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PP staff (PPcanopy users)
CREATE TABLE IF NOT EXISTS pp_staff (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         CITEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'Sales Manager',   -- Owner, Sales Manager, IT Staff
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Promoted data (the boundary) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revenue_week    NUMERIC(12,2),
  gp_pct          NUMERIC(5,2),
  labour_pct      NUMERIC(5,2),
  covers_week     INTEGER,
  stock_out       INTEGER,
  stock_low       INTEGER,
  stock_out_items TEXT[],
  stock_low_items TEXT[],
  stock_value     NUMERIC(12,2),
  open_orders     INTEGER,
  loyalty         JSONB
);
CREATE INDEX IF NOT EXISTS idx_site_snapshots_site_time ON site_snapshots(site_id, received_at DESC);

CREATE TABLE IF NOT EXISTS menu_items (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id   UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  category  TEXT,
  price     NUMERIC(10,2),
  active    BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, name)
);

CREATE TABLE IF NOT EXISTS site_shared_payroll (
  site_id    UUID PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  lines      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Encrypted full backup from /api/venue/sync. Never queried by Command/Canopy routes.
CREATE TABLE IF NOT EXISTS site_backups (
  site_id    UUID PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  ciphertext BYTEA NOT NULL,
  key_id     TEXT NOT NULL,
  pushed_at  TIMESTAMPTZ NOT NULL
);

-- ── Agent messaging ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ronin_gavin_messages (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  site_id                   UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  direction                 TEXT NOT NULL,          -- ronin_to_gavin, gavin_to_ronin
  intent                    TEXT NOT NULL,
  note                      TEXT,
  requires_manager_approval BOOLEAN NOT NULL DEFAULT false,
  status                    TEXT NOT NULL,          -- sent, awaiting_approval, approved, declined, completed, failed
  coordination_id           UUID,
  reply_to                  UUID REFERENCES ronin_gavin_messages(id),
  approved_by               TEXT,                   -- 'site' | 'org'
  approved_at               TIMESTAMPTZ,
  result                    JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rgm_site_status ON ronin_gavin_messages(site_id, status);
CREATE INDEX IF NOT EXISTS idx_rgm_org_created ON ronin_gavin_messages(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS org_notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT,
  status     TEXT NOT NULL DEFAULT 'unread',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_notif ON org_notifications(org_id, created_at DESC);

-- Canopy -> Ronin asks (pp_schema.sql canopy_ronin_requests + reconciliation id)
CREATE TABLE IF NOT EXISTS canopy_ronin_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  request_text      TEXT NOT NULL,
  requires_approval BOOLEAN NOT NULL DEFAULT true,
  status            TEXT NOT NULL DEFAULT 'awaiting_approval', -- awaiting_approval, approved, declined, answered, withdrawn
  response_text     TEXT,
  canopy_ask_id     TEXT,
  asked_by          UUID REFERENCES pp_staff(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_crr_org_status ON canopy_ronin_requests(org_id, status);

-- Idempotency keys for retried writes (24h)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  principal   TEXT NOT NULL,
  key         TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  body        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (principal, key)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
