-- migration: 0001_create_offers_schema
-- direction: down
-- owner: module_offers

BEGIN;
DROP SCHEMA IF EXISTS module_offers RESTRICT;
COMMIT;
