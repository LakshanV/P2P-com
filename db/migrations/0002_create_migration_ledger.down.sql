-- migration: 0002_create_migration_ledger
-- direction: down
-- owner: platform
--
-- Reverses the reversible part of 0002: the recency index and the table comment.
--
-- It deliberately does NOT drop platform.schema_migrations. An earlier revision did, and it was
-- unexecutable: the runner deletes the migration's ledger row in the same transaction, so the
-- rollback dropped the table and then failed on a DELETE against a relation that no longer
-- existed. Worse, had it succeeded it would have destroyed the row for 0001 as well — reversing
-- one migration must not erase the history of the others.
--
-- The table is bootstrap-owned. The runner creates it and nothing in the migration history
-- removes it.

BEGIN;

DROP INDEX IF EXISTS platform.schema_migrations_applied_at_idx;

COMMENT ON TABLE platform.schema_migrations IS NULL;

COMMIT;
