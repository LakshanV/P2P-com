-- migration: 0001_add_order_payment_link
-- direction: down
-- owner: module_orders

BEGIN;
DROP TABLE IF EXISTS module_orders.purchase;
COMMIT;
