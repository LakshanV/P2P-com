-- migration: 0002_create_migration_ledger
-- direction: down
-- owner: platform
--
-- Reverses 0002. Dropping the ledger discards the record of what has been applied, so this
-- rollback is only ever correct as part of tearing the whole schema down.

BEGIN;

DROP INDEX IF EXISTS platform.schema_migrations_applied_at_idx;

DROP TABLE IF EXISTS platform.schema_migrations;

COMMIT;
