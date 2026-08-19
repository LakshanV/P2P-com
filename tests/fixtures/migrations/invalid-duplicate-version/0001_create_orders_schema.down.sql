-- migration: 0001_create_orders_schema
-- direction: down
-- owner: module_orders

BEGIN;
DROP SCHEMA IF EXISTS module_orders RESTRICT;
COMMIT;
