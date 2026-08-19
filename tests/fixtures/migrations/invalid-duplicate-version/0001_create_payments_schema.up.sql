-- migration: 0001_create_payments_schema
-- direction: up
-- owner: module_payments

BEGIN;
CREATE SCHEMA IF NOT EXISTS module_payments;
COMMIT;
