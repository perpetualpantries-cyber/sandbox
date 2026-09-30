-- ============================================================================
-- Head-office PP Command. A client with several regions runs one PP Command
-- per region (each its own org, with its own sites and Ronin) plus one
-- head-office PP Command: an org with command_tier 'head_office' and no sites
-- of its own. A region links to its head office with a one-time code the head
-- office issues (kind 'region'), the same way a café links to a region.
--
-- Head office is not a mirror: it reads each region's promoted site snapshots
-- (the same whitelist PP Command already sees), never anything below that.
-- It sets group policy the regions inherit, decides escalations they raise,
-- and sends requests to a region's Ronin — never to a site's Gavin.
-- Idempotent: safe to re-run.
-- ============================================================================
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS parent_org_id    UUID REFERENCES orgs(id) ON DELETE SET NULL;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS region_name      TEXT;          -- how head office labels this region
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS parent_linked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_orgs_parent ON orgs(parent_org_id);

ALTER TABLE link_codes DROP CONSTRAINT IF EXISTS link_codes_kind_check;
ALTER TABLE link_codes ADD CONSTRAINT link_codes_kind_check CHECK (kind IN ('org','site','region'));
ALTER TABLE link_codes ADD COLUMN IF NOT EXISTS region_org_id UUID REFERENCES orgs(id) ON DELETE SET NULL;  -- set when a region claims

-- One policy per head office; `version` gives optimistic concurrency like canopy_store.
CREATE TABLE IF NOT EXISTS group_policies (
  org_id      UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,   -- the head office
  policy      JSONB NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Region -> head office: decisions a region can't make on its own.
CREATE TABLE IF NOT EXISTS hq_escalations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hq_org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  region_org_id  UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  subject        TEXT NOT NULL,
  body           TEXT,
  amount_cents   BIGINT,
  status         TEXT NOT NULL DEFAULT 'awaiting_decision'
                 CHECK (status IN ('awaiting_decision','approved','declined','withdrawn')),
  decision_note  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hq_esc_hq ON hq_escalations(hq_org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hq_esc_region ON hq_escalations(region_org_id, created_at DESC);

-- Head office -> region: requests from head office (or its Ronin) to a region's Ronin.
CREATE TABLE IF NOT EXISTS hq_region_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hq_org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  region_org_id  UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  intent         TEXT NOT NULL,
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','answered')),
  response_text  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hq_req_hq ON hq_region_requests(hq_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hq_req_region ON hq_region_requests(region_org_id, status, created_at DESC);
