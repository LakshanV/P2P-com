-- migration: add-orders-table
-- direction: up
-- owner: module_orders

BEGIN;
CREATE SCHEMA IF NOT EXISTS module_orders;
COMMIT;
