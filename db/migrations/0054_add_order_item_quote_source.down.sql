-- migration: 0054_add_order_item_quote_source
-- direction: down
-- owner: module_orders
--
-- Narrows an order line back to a listing source only.
--
-- **This rollback can fail, and that is the correct behaviour.** Restoring NOT NULL on `listing_id`,
-- `version_id` and `commerce_unit_type_id` is impossible while any quote-sourced line exists, and
-- the only ways to make it possible are to delete those lines or to invent a listing for them. The
-- first destroys the record of what a buyer agreed to; the second writes a reference to something
-- that does not exist. Neither is a decision a migration may take on an operator's behalf, so it
-- refuses and says why.
--
-- With no quote-sourced lines on record, this reverses cleanly.

BEGIN;

DROP INDEX IF EXISTS module_orders.order_item_quote_idx;

ALTER TABLE module_orders.order_item
  DROP CONSTRAINT IF EXISTS order_item_names_one_source,
  DROP CONSTRAINT IF EXISTS order_item_line_kind_known,
  DROP CONSTRAINT IF EXISTS order_item_quote_id_opaque,
  DROP CONSTRAINT IF EXISTS order_item_listing_id_opaque,
  DROP CONSTRAINT IF EXISTS order_item_version_id_opaque,
  DROP CONSTRAINT IF EXISTS order_item_unit_type_opaque;

ALTER TABLE module_orders.order_item
  DROP COLUMN IF EXISTS line_kind,
  DROP COLUMN IF EXISTS quote_id;

-- Fails with a NOT NULL violation if any quote-sourced line survives. See the note above.
ALTER TABLE module_orders.order_item
  ALTER COLUMN listing_id            SET NOT NULL,
  ALTER COLUMN version_id            SET NOT NULL,
  ALTER COLUMN commerce_unit_type_id SET NOT NULL;

ALTER TABLE module_orders.order_item
  ADD CONSTRAINT order_item_listing_id_opaque
    CHECK (module_orders.is_opaque_identifier(listing_id)),
  ADD CONSTRAINT order_item_version_id_opaque
    CHECK (module_orders.is_opaque_identifier(version_id)),
  ADD CONSTRAINT order_item_unit_type_opaque
    CHECK (module_orders.is_opaque_identifier(commerce_unit_type_id));

COMMIT;
