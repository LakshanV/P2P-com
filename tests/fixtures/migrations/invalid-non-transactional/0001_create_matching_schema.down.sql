-- migration: 0001_create_matching_schema
-- direction: down
-- owner: module_matching

BEGIN;
DROP SCHEMA IF EXISTS module_matching RESTRICT;
COMMIT;
