-- migration: 0001_missing_owner
-- direction: down
-- owner: platform

BEGIN;
DROP SCHEMA IF EXISTS platform RESTRICT;
COMMIT;
