-- migration: 0001_create_orders_schema
-- direction: up
-- owner: module_orders

BEGIN;
CREATE SCHEMA IF NOT EXISTS module_orders;
COMMIT;
