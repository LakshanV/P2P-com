-- migration: 0012_create_kernel_commerce_unit_registry_schema
-- direction: down
-- owner: kernel_commerce_unit_registry
--
-- Reverses 0012. Nothing outside K-11 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Because K-11 has no foreign key into any other schema — tenant handles are opaque and are never
-- joined to `kernel_accounts` — this rollback is independent of every other component: it runs
-- whether or not migrations 0005 through 0011 have been applied, and leaves all of them as they
-- were.
--
-- Order matters twice. Triggers reference their function, so triggers go first. The tables' CHECK
-- constraints reference `is_opaque_identifier` and `is_type_key`, so the **tables** go before those
-- functions — dropping them earlier would fail on the dependency, which is the database correctly
-- refusing to leave a constraint pointing at nothing.
--
-- RESTRICT rather than CASCADE on the schema: if something unexpected has been created inside it,
-- this should stop and say so rather than remove objects no migration described.
--
-- **Rolling this back discards the platform's vocabulary.** Like migration 0011's, this is data
-- loss rather than a reversal once anything uses it: every listing, order line and invoice created
-- under a type holds a `type_version_id` that would no longer resolve to anything, so what those
-- records describe becomes permanently unreadable. Today it costs nothing, because nothing resolves
-- a type and no record has referenced one. Once something does, **an operator should expect to be
-- asked about this rather than to discover it**.

BEGIN;

DROP INDEX IF EXISTS kernel_commerce_unit_registry.commerce_unit_type_version_parent_idx;

DROP INDEX IF EXISTS kernel_commerce_unit_registry.commerce_unit_type_version_key_idx;

DROP INDEX IF EXISTS kernel_commerce_unit_registry.commerce_unit_type_activation_first_unique;

DROP INDEX IF EXISTS kernel_commerce_unit_registry.commerce_unit_type_activation_supersedes_unique;

DROP TRIGGER IF EXISTS commerce_unit_type_retirement_is_append_only
  ON kernel_commerce_unit_registry.commerce_unit_type_retirement;

DROP TRIGGER IF EXISTS commerce_unit_type_activation_is_append_only
  ON kernel_commerce_unit_registry.commerce_unit_type_activation;

DROP TRIGGER IF EXISTS commerce_unit_type_version_is_append_only
  ON kernel_commerce_unit_registry.commerce_unit_type_version;

DROP FUNCTION IF EXISTS kernel_commerce_unit_registry.refuse_mutation();

DROP TABLE IF EXISTS kernel_commerce_unit_registry.commerce_unit_type_retirement;

DROP TABLE IF EXISTS kernel_commerce_unit_registry.commerce_unit_type_activation;

DROP TABLE IF EXISTS kernel_commerce_unit_registry.commerce_unit_type_version;

DROP FUNCTION IF EXISTS kernel_commerce_unit_registry.is_type_key(text);

DROP FUNCTION IF EXISTS kernel_commerce_unit_registry.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_commerce_unit_registry RESTRICT;

COMMIT;
