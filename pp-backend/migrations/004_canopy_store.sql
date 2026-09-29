-- ============================================================================
-- PPcanopy's own records (clients, quotes, invoices, pricing, team, ...) held
-- server-side so every PP staff member and device sees the same data.
-- One row per PPcanopy collection; `version` gives optimistic concurrency so
-- two people saving at once can't silently overwrite each other.
-- Idempotent: safe to re-run.
-- ============================================================================
CREATE TABLE IF NOT EXISTS canopy_store (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES pp_staff(id) ON DELETE SET NULL
);
