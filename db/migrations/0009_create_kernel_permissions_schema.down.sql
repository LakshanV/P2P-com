-- migration: 0009_create_kernel_permissions_schema
-- direction: down
-- owner: kernel_permissions
--
-- Reverses 0009. Nothing outside K-04 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Because there is no foreign key into `kernel_identity`, `kernel_accounts` or
-- `kernel_authentication`, this rollback is independent of K-01, K-02 and K-03: it runs whether or
-- not migrations 0006, 0007 and 0008 have been applied, and leaves all three exactly as they were.
--
-- Order matters twice. Triggers reference their function, so triggers go first. The tables' CHECK
-- constraints reference `is_opaque_identifier`, so the **tables** go before that function —
-- dropping it earlier would fail on the dependency, which is the database correctly refusing to
-- leave a constraint pointing at nothing.
--
-- RESTRICT rather than CASCADE on the schema: if something unexpected has been created inside it,
-- this should stop and say so rather than remove objects no migration described.
--
-- **Rolling this back discards every policy version, grant, revocation and decision record.** That
-- is the whole authority history, including the record of who could do what and who said so. Today
-- it costs nothing, because no unit calls K-04 and nothing has ever been granted. Once something
-- does, this becomes a destructive operation an operator should expect to be asked about rather
-- than to discover — and one whose result is that everything denies, which is the safe direction.

BEGIN;

DROP INDEX IF EXISTS kernel_permissions.permission_decision_subject_idx;

DROP INDEX IF EXISTS kernel_permissions.permission_grant_subject_account_idx;

DROP TRIGGER IF EXISTS permission_decision_is_append_only
  ON kernel_permissions.permission_decision;

DROP TRIGGER IF EXISTS permission_revocation_is_append_only
  ON kernel_permissions.permission_revocation;

DROP TRIGGER IF EXISTS permission_grant_is_append_only
  ON kernel_permissions.permission_grant;

DROP TRIGGER IF EXISTS permission_policy_version_is_append_only
  ON kernel_permissions.permission_policy_version;

DROP FUNCTION IF EXISTS kernel_permissions.refuse_mutation();

DROP TABLE IF EXISTS kernel_permissions.permission_decision;

DROP TABLE IF EXISTS kernel_permissions.permission_revocation;

DROP TABLE IF EXISTS kernel_permissions.permission_grant;

DROP TABLE IF EXISTS kernel_permissions.permission_policy_version;

DROP FUNCTION IF EXISTS kernel_permissions.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_permissions RESTRICT;

COMMIT;
