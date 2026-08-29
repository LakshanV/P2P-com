-- migration: 0013_create_kernel_configuration_outbox
-- direction: down
-- owner: kernel_configuration

BEGIN;

DROP TABLE IF EXISTS kernel_configuration.outbox;

COMMIT;
