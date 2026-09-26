-- ============================================================================
-- Org-level linking: PPcanopy no longer hands PP Command a permanent raw
-- API key at client-creation time (shown once, no recovery if lost). Instead
-- it issues the same kind of single-use, 24h-expiry code already used for
-- site linking, and PP Command redeems it once to receive the org's key.
-- Mirrors the existing org->site link_codes flow exactly; `kind` tells the
-- two apart in the same table.
-- Idempotent: safe to re-run.
-- ============================================================================
ALTER TABLE link_codes ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'site';
ALTER TABLE link_codes DROP CONSTRAINT IF EXISTS link_codes_kind_check;
ALTER TABLE link_codes ADD CONSTRAINT link_codes_kind_check CHECK (kind IN ('org','site'));

-- An org can now exist before it's ever claimed by a PP Command console.
ALTER TABLE orgs ALTER COLUMN api_key_hash DROP NOT NULL;
ALTER TABLE orgs ALTER COLUMN api_key_hint DROP NOT NULL;
