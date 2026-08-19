-- migration: 0003_create_kernel_configuration_schema
-- direction: down
-- owner: kernel_configuration
--
-- Reverses 0003. Unlike the bootstrap-owned platform objects, this schema and table belong to a
-- migration and so are genuinely reversible: nothing outside K-05 depends on them, and the
-- migration ledger that records this rollback lives in another schema entirely.
--
-- RESTRICT rather than CASCADE on the schema: if something unexpected has been created inside it,
-- the rollback should stop and say so rather than remove objects no migration described.

BEGIN;

DROP INDEX IF EXISTS kernel_configuration.config_version_resolution_idx;

DROP INDEX IF EXISTS kernel_configuration.config_version_one_active_per_scope;

DROP TABLE IF EXISTS kernel_configuration.config_version;

DROP SCHEMA IF EXISTS kernel_configuration RESTRICT;

COMMIT;
