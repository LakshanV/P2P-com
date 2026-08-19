-- migration: 0001_create_platform_schema
-- direction: down
-- owner: platform
--
-- Reverses 0001. Deliberately RESTRICT rather than CASCADE: if anything still lives in the
-- schema, the rollback should fail loudly rather than silently destroy objects a later migration
-- created.

BEGIN;

DROP SCHEMA IF EXISTS platform RESTRICT;

COMMIT;
