-- migration: 0001_create_platform_schema
-- direction: up
-- owner: platform
--
-- Creates the substrate's own namespace. Every unit gets a schema of its own and nothing is
-- placed in `public`, which sits on the default search_path and would therefore be readable and
-- writable by every unit while being owned by none.
--
-- This migration adds no business-module tables. It establishes the namespace the migration
-- ledger lives in, and nothing else.

BEGIN;

CREATE SCHEMA IF NOT EXISTS platform;

COMMENT ON SCHEMA platform IS
  'Platform substrate. Owns the migration ledger and any object that belongs to no business unit.';

COMMIT;
