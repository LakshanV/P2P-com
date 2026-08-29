-- migration: 0015_create_kernel_feature_flags_outbox
-- direction: down
-- owner: kernel_feature_flags

BEGIN;

DROP TABLE IF EXISTS kernel_feature_flags.outbox;

COMMIT;
