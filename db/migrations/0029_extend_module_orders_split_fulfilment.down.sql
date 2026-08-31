-- migration: 0029_extend_module_orders_split_fulfilment
-- direction: down
-- owner: module_orders
--
-- Reverses 0029. It drops only what 0029 added: the index, the four constraints and the two
-- columns. It must not drop the schema, the tables, or the shared functions — those belong to 0028,
-- and a rollback that took them with it would make the two migrations one unit.

BEGIN;

DROP INDEX IF EXISTS module_orders.order_header_parent_idx;

ALTER TABLE module_orders.order_header
  DROP CONSTRAINT IF EXISTS order_header_parent_id_opaque,
  DROP CONSTRAINT IF EXISTS order_header_no_self_parent,
  DROP CONSTRAINT IF EXISTS order_header_child_has_parent,
  DROP CONSTRAINT IF EXISTS order_header_fulfilment_role_known;

ALTER TABLE module_orders.order_header
  DROP COLUMN IF EXISTS fulfilment_role,
  DROP COLUMN IF EXISTS parent_order_id;

COMMIT;
