-- migration: 0010_create_kernel_feature_flags_schema
-- direction: down
-- owner: kernel_feature_flags
--
-- Reverses 0010. Nothing outside K-07 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Because K-07 has no foreign key into any other schema — it references no subject, no account and
-- no policy version — this rollback is independent of every other component: it runs whether or
-- not migrations 0005 through 0009 have been applied, and leaves all of them exactly as they were.
--
-- Order matters twice. Triggers reference their function, so triggers go first. The tables' CHECK
-- constraints reference `is_opaque_identifier` and `is_flag_key`, so the **tables** go before those
-- functions — dropping them earlier would fail on the dependency, which is the database correctly
-- refusing to leave a constraint pointing at nothing.
--
-- RESTRICT rather than CASCADE on the schema: if something unexpected has been created inside it,
-- this should stop and say so rather than remove objects no migration described.
--
-- **Rolling this back discards every flag definition, every activation and every kill switch.**
-- The result is that every flag evaluates to `no-such-flag`, which is off — the safe direction,
-- and the one thing that makes this rollback tolerable at all. What it does not preserve is the
-- record of *why* a feature was stopped and when, which is the evidence an incident review needs.
-- Today that costs nothing, because nothing in this repository evaluates a flag and none has ever
-- been killed. Once something does, this becomes a destructive operation an operator should expect
-- to be asked about rather than to discover.

BEGIN;

DROP INDEX IF EXISTS kernel_feature_flags.feature_flag_version_key_idx;

DROP INDEX IF EXISTS kernel_feature_flags.feature_flag_activation_first_unique;

DROP INDEX IF EXISTS kernel_feature_flags.feature_flag_activation_supersedes_unique;

DROP TRIGGER IF EXISTS feature_flag_lifecycle_is_append_only
  ON kernel_feature_flags.feature_flag_lifecycle;

DROP TRIGGER IF EXISTS feature_flag_activation_is_append_only
  ON kernel_feature_flags.feature_flag_activation;

DROP TRIGGER IF EXISTS feature_flag_version_is_append_only
  ON kernel_feature_flags.feature_flag_version;

DROP FUNCTION IF EXISTS kernel_feature_flags.refuse_mutation();

DROP TABLE IF EXISTS kernel_feature_flags.feature_flag_lifecycle;

DROP TABLE IF EXISTS kernel_feature_flags.feature_flag_activation;

DROP TABLE IF EXISTS kernel_feature_flags.feature_flag_version;

DROP FUNCTION IF EXISTS kernel_feature_flags.is_flag_key(text);

DROP FUNCTION IF EXISTS kernel_feature_flags.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_feature_flags RESTRICT;

COMMIT;
