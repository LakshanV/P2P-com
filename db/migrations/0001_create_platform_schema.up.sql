-- migration: 0001_create_platform_schema
-- direction: up
-- owner: platform
--
-- Declares the substrate's own namespace. Every unit gets a schema of its own and nothing is
-- placed in `public`, which sits on the default search_path and would therefore be readable and
-- writable by every unit while being owned by none.
--
-- The schema itself is BOOTSTRAP-OWNED: the runner creates it, together with the migration
-- ledger, inside the same transaction as this migration on a fresh database. This file is
-- therefore written to be a no-op when the runner has already created it, and to be sufficient on
-- its own when applied by hand with psql.
--
-- This migration adds no business-module tables.

BEGIN;

CREATE SCHEMA IF NOT EXISTS platform;

COMMENT ON SCHEMA platform IS
  'Platform substrate. Owns the migration ledger and any object that belongs to no business unit.';

COMMIT;
