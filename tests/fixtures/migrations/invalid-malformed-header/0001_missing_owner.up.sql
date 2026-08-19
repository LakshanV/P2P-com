-- migration: 0001_missing_owner
-- direction: up

BEGIN;
CREATE SCHEMA IF NOT EXISTS platform;
COMMIT;
