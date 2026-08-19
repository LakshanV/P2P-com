-- migration: 0001_create_identity_schema
-- direction: down
-- owner: kernel_identity

BEGIN;

DROP TABLE IF EXISTS kernel_identity.person;

DROP SCHEMA IF EXISTS kernel_identity RESTRICT;

COMMIT;
