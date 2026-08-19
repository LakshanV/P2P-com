-- migration: 0001_create_payments_schema
-- direction: down
-- owner: module_payments

BEGIN;
DROP SCHEMA IF EXISTS module_payments RESTRICT;
COMMIT;
