-- migration: 0006_create_kernel_identity_schema
-- direction: down
-- owner: kernel_identity
--
-- Reverses 0006. Nothing outside K-01 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters twice. The trigger references `refuse_mutation`, so the trigger goes first. The
-- table's opacity CHECKs reference `is_opaque_identifier`, so the **table** goes before that
-- function — dropping it earlier would fail on the dependency, which is the database correctly
-- refusing to leave a constraint pointing at nothing.
--
-- RESTRICT rather than CASCADE on the schema: if something unexpected has been created inside it,
-- this should stop and say so rather than remove objects no migration described.
--
-- **Rolling this back discards every identity subject.** Today that costs nothing, because no unit
-- creates one. Once K-03 Accounts references these ids it will cost a great deal, and the honest
-- statement of that is here rather than in a runbook nobody reads: a later migration that adds a
-- foreign key from another schema will make this rollback fail at the RESTRICT, which is the
-- correct outcome and not a defect to be worked around with CASCADE.

BEGIN;

DROP INDEX IF EXISTS kernel_identity.identity_subject_kind_idx;

DROP INDEX IF EXISTS kernel_identity.identity_subject_origin_idx;

DROP INDEX IF EXISTS kernel_identity.identity_subject_chronological_idx;

DROP TRIGGER IF EXISTS identity_subject_is_write_once ON kernel_identity.identity_subject;

DROP TABLE IF EXISTS kernel_identity.identity_subject;

DROP FUNCTION IF EXISTS kernel_identity.refuse_mutation();

DROP FUNCTION IF EXISTS kernel_identity.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_identity RESTRICT;

COMMIT;
