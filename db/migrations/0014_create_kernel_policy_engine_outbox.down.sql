-- migration: 0014_create_kernel_policy_engine_outbox
-- direction: down
-- owner: kernel_policy_engine

BEGIN;

DROP TABLE IF EXISTS kernel_policy_engine.outbox;

COMMIT;
