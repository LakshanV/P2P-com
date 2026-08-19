-- migration: 0008_create_kernel_authentication_schema
-- direction: down
-- owner: kernel_authentication
--
-- Reverses 0008. Nothing outside K-02 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Because there is no foreign key into `kernel_identity`, this rollback is independent of K-01: it
-- runs whether or not migration 0006 has been applied, and leaves K-01 exactly as it was.
--
-- Order matters twice. Triggers reference their functions, so triggers go first. The tables' CHECK
-- constraints reference `is_opaque_identifier`, so the **tables** go before that function —
-- dropping it earlier would fail on the dependency, which is the database correctly refusing to
-- leave a constraint pointing at nothing.
--
-- RESTRICT rather than CASCADE on the schema: if something unexpected has been created inside it,
-- this should stop and say so rather than remove objects no migration described.
--
-- **Rolling this back signs everybody out and discards every authentication record.** Today that
-- costs nothing, because no verifier is wired and nobody can sign in. Once one is, this becomes a
-- destructive operation with a user-visible consequence, and an operator should expect to be asked
-- about it rather than to discover it.

BEGIN;

DROP INDEX IF EXISTS kernel_authentication.authentication_session_live_idx;

DROP INDEX IF EXISTS kernel_authentication.authentication_session_subject_idx;

DROP INDEX IF EXISTS kernel_authentication.authentication_evidence_subject_idx;

DROP INDEX IF EXISTS kernel_authentication.authentication_binding_subject_idx;

DROP TRIGGER IF EXISTS authentication_session_changes_are_bounded
  ON kernel_authentication.authentication_session;

DROP TRIGGER IF EXISTS authentication_evidence_is_write_once
  ON kernel_authentication.authentication_evidence;

DROP TRIGGER IF EXISTS authentication_binding_is_write_once
  ON kernel_authentication.authentication_binding;

DROP TABLE IF EXISTS kernel_authentication.authentication_session;

DROP TABLE IF EXISTS kernel_authentication.authentication_evidence;

DROP TABLE IF EXISTS kernel_authentication.authentication_binding;

DROP FUNCTION IF EXISTS kernel_authentication.refuse_session_rewrite();

DROP FUNCTION IF EXISTS kernel_authentication.refuse_mutation();

DROP FUNCTION IF EXISTS kernel_authentication.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_authentication RESTRICT;

COMMIT;
