-- migration: 0011_create_kernel_policy_engine_schema
-- direction: down
-- owner: kernel_policy_engine
--
-- Reverses 0011. Nothing outside K-06 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Because K-06 has no foreign key into any other schema — it references no subject, no account, no
-- seller record — this rollback is independent of every other component: it runs whether or not
-- migrations 0005 through 0010 have been applied, and leaves all of them exactly as they were.
--
-- Order matters twice. Triggers reference their function, so triggers go first. The tables' CHECK
-- constraints reference `is_opaque_identifier` and `is_policy_key`, so the **tables** go before
-- those functions — dropping them earlier would fail on the dependency, which is the database
-- correctly refusing to leave a constraint pointing at nothing.
--
-- RESTRICT rather than CASCADE on the schema: if something unexpected has been created inside it,
-- this should stop and say so rather than remove objects no migration described.
--
-- **Rolling this back discards every policy version.** That is a more serious loss than any
-- rollback before it. A feature-flag rollback leaves every flag off, which is safe; a policy
-- rollback leaves every historic transaction holding a `policy_version_id` that no longer resolves
-- to anything — the commission charged last March becomes permanently unexplainable, and v3 §24's
-- requirement that a transaction retain the version applied to it is broken retroactively. Today
-- it costs nothing, because nothing evaluates a policy and no transaction has pinned one. Once
-- something does, **this rollback should be treated as data loss rather than as a reversal**, and
-- an operator should expect to be asked about it rather than to discover it.

BEGIN;

DROP INDEX IF EXISTS kernel_policy_engine.policy_version_key_idx;

DROP INDEX IF EXISTS kernel_policy_engine.policy_activation_first_unique;

DROP INDEX IF EXISTS kernel_policy_engine.policy_activation_supersedes_unique;

DROP TRIGGER IF EXISTS policy_retirement_is_append_only
  ON kernel_policy_engine.policy_retirement;

DROP TRIGGER IF EXISTS policy_activation_is_append_only
  ON kernel_policy_engine.policy_activation;

DROP TRIGGER IF EXISTS policy_version_is_append_only
  ON kernel_policy_engine.policy_version;

DROP TRIGGER IF EXISTS policy_draft_is_append_only
  ON kernel_policy_engine.policy_draft;

DROP FUNCTION IF EXISTS kernel_policy_engine.refuse_mutation();

DROP TABLE IF EXISTS kernel_policy_engine.policy_retirement;

DROP TABLE IF EXISTS kernel_policy_engine.policy_activation;

DROP TABLE IF EXISTS kernel_policy_engine.policy_version;

DROP TABLE IF EXISTS kernel_policy_engine.policy_draft;

DROP FUNCTION IF EXISTS kernel_policy_engine.is_policy_key(text);

DROP FUNCTION IF EXISTS kernel_policy_engine.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_policy_engine RESTRICT;

COMMIT;
