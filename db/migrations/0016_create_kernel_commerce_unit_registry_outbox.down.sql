-- migration: 0016_create_kernel_commerce_unit_registry_outbox
-- direction: down
-- owner: kernel_commerce_unit_registry

BEGIN;

DROP TABLE IF EXISTS kernel_commerce_unit_registry.outbox;

COMMIT;
