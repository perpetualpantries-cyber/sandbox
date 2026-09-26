-- ============================================================================
-- Server-side scheduled POs for auto-send catering events.
--
-- Draft-only scheduled POs (the default, human reviews in Orders) stay 100%
-- client-side — that path is unaffected. This table exists only for the
-- opt-in poAutoSend case: an order the café has explicitly said should go
-- out to the supplier automatically, with no human review step. That
-- promise cannot depend on the café's browser being open when the release
-- date arrives, so the schedule and the actual send both live here instead.
-- Idempotent: safe to re-run.
-- ============================================================================
CREATE TABLE IF NOT EXISTS scheduled_pos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  event_name     TEXT NOT NULL,
  event_date     DATE,
  po_number      TEXT,
  supplier_name  TEXT NOT NULL,
  supplier_email TEXT,
  lines          JSONB NOT NULL,              -- [{name, qty, unit, unit_cost}], price captured at schedule time
  total          NUMERIC(12,2) NOT NULL DEFAULT 0,
  release_date   DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled, released, sent, failed, cancelled
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at    TIMESTAMPTZ,
  sent_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_scheduled_pos_due ON scheduled_pos(status, release_date);
CREATE INDEX IF NOT EXISTS idx_scheduled_pos_site ON scheduled_pos(site_id, created_at DESC);
