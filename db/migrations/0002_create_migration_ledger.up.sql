-- migration: 0002_create_migration_ledger
-- direction: up
-- owner: platform
--
-- The ledger of applied migrations. A migration runner reads this table to decide what still
-- needs applying, and writes one row per forward migration inside the same transaction as the
-- migration itself, so a failed migration leaves no row claiming it succeeded.
--
-- checksum records the hash of the forward file as applied. A mismatch on a later run means the
-- file was edited after it ran somewhere, which is the single most common cause of environments
-- that disagree about their own schema.

BEGIN;

CREATE TABLE IF NOT EXISTS platform.schema_migrations (
  version      text        NOT NULL,
  slug         text        NOT NULL,
  checksum     text        NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  applied_by   text        NOT NULL DEFAULT current_user,
  duration_ms  integer     NULL,
  CONSTRAINT schema_migrations_pkey PRIMARY KEY (version),
  CONSTRAINT schema_migrations_version_format CHECK (version ~ '^[0-9]{4}$'),
  CONSTRAINT schema_migrations_slug_format CHECK (slug ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  CONSTRAINT schema_migrations_duration_nonnegative CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

COMMENT ON TABLE platform.schema_migrations IS
  'One row per applied forward migration. Written in the same transaction as the migration.';

CREATE INDEX IF NOT EXISTS schema_migrations_applied_at_idx
  ON platform.schema_migrations (applied_at DESC);

COMMIT;
