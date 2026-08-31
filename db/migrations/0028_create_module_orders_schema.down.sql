-- migration: 0028_create_module_orders_schema
-- direction: down
-- owner: module_orders
--
-- Reverses 0028. Nothing outside M-11 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters. The triggers reference `refuse_mutation`, so they go first. The tables' CHECK
-- constraints reference `is_opaque_identifier`, so the tables go before that function.

BEGIN;

DROP INDEX IF EXISTS module_orders.outbox_unprocessed_idx;

DROP INDEX IF EXISTS module_orders.order_event_order_idx;

DROP INDEX IF EXISTS module_orders.order_item_version_idx;
DROP INDEX IF EXISTS module_orders.order_item_order_idx;

DROP INDEX IF EXISTS module_orders.order_header_status_idx;
DROP INDEX IF EXISTS module_orders.order_header_seller_idx;
DROP INDEX IF EXISTS module_orders.order_header_buyer_idx;

DROP TRIGGER IF EXISTS order_event_is_append_only ON module_orders.order_event;
DROP TRIGGER IF EXISTS order_snapshot_is_append_only ON module_orders.order_snapshot;
DROP TRIGGER IF EXISTS order_item_is_append_only ON module_orders.order_item;

DROP TABLE IF EXISTS module_orders.outbox;

DROP TABLE IF EXISTS module_orders.order_event;

DROP TABLE IF EXISTS module_orders.order_snapshot;

DROP TABLE IF EXISTS module_orders.order_item;

DROP TABLE IF EXISTS module_orders.order_header;

DROP FUNCTION IF EXISTS module_orders.refuse_mutation();

DROP FUNCTION IF EXISTS module_orders.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_orders RESTRICT;

COMMIT;
