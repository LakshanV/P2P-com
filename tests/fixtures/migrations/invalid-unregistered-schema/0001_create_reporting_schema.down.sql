-- migration: 0001_create_reporting_schema
-- direction: down
-- owner: module_reporting

BEGIN;
DROP SCHEMA IF EXISTS module_reporting RESTRICT;
COMMIT;
