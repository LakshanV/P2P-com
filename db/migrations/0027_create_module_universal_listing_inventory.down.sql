-- migration: 0027_create_module_universal_listing_inventory
-- direction: down
-- owner: module_universal_listing
--
-- Reverses 0027. The trigger references `refuse_mutation`, so it is dropped before the table.
-- `is_opaque_identifier` and `refuse_mutation` are owned by migration 0026 and are not dropped here.

BEGIN;

DROP TRIGGER IF EXISTS inventory_movement_is_append_only
  ON module_universal_listing.inventory_movement;

DROP TABLE IF EXISTS module_universal_listing.inventory_snapshot;

DROP TABLE IF EXISTS module_universal_listing.inventory_movement;

COMMIT;
