-- migration: 0001_create_platform_schema
-- direction: down
-- owner: platform
--
-- Reverses what is reversible: the schema comment.
--
-- It deliberately does NOT drop the `platform` schema. The schema holds
-- platform.schema_migrations, which is the record of what has been applied — dropping it would
-- destroy the history that tells an operator what state the database is in, and would leave the
-- runner unable to answer `db:status` at all. The schema is bootstrap-owned infrastructure, not
-- migration-owned data.
--
-- To remove the platform schema entirely, drop the database or drop the schema by hand, as a
-- deliberate act outside the migration history.

BEGIN;

COMMENT ON SCHEMA platform IS NULL;

COMMIT;
