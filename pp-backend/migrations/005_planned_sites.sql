-- Sites PPcanopy has sold/planned for a client that aren't linked yet. PP Command sees them
-- as "Waiting to link" and turns one into a site link code; redeeming that code links the
-- café and marks the planned site linked, so PPcanopy's billing venue ties to the real site.
CREATE TABLE IF NOT EXISTS planned_sites (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  tier             TEXT,
  canopy_venue_id  TEXT,                                  -- PPcanopy's billing-venue id
  status           TEXT NOT NULL DEFAULT 'waiting',       -- waiting, linked, dismissed
  site_id          UUID REFERENCES sites(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, canopy_venue_id)
);
CREATE INDEX IF NOT EXISTS planned_sites_org ON planned_sites(org_id, status);
ALTER TABLE link_codes ADD COLUMN IF NOT EXISTS planned_site_id UUID REFERENCES planned_sites(id) ON DELETE SET NULL;
