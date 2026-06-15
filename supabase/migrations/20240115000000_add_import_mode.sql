-- ============================================================
-- Migration: Ajout de la colonne mode sur import_jobs
-- Supporte le re-import partiel (lots_only / contacts_only)
-- ============================================================

ALTER TABLE import_jobs
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'full'
  CHECK (mode IN ('full', 'lots_only', 'contacts_only'));

CREATE INDEX IF NOT EXISTS idx_import_jobs_mode ON import_jobs(mode);
