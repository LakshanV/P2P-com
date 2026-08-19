-- migration: 0005_create_kernel_audit_foundation_schema
-- direction: down
-- owner: kernel_audit_foundation
--
-- Reverses 0005. Nothing outside K-09 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters: the trigger references the function, so the trigger goes first.
--
-- RESTRICT rather than CASCADE on the schema: if something unexpected has been created inside it,
-- this should stop and say so rather than remove objects no migration described.
--
-- **Rolling this back discards the audit trail.** That is a deliberate consequence of removing the
-- component, not an accident to be worked around, and it is the one rollback in this repository
-- that destroys evidence rather than merely state. An operator who may ever need to answer a
-- question about what happened should export the table before running it. The trigger that makes
-- the table append-only is dropped first, which is the only moment at which those rows are
-- deletable at all.

BEGIN;

DROP INDEX IF EXISTS kernel_audit_foundation.audit_record_action_idx;

DROP INDEX IF EXISTS kernel_audit_foundation.audit_record_correlation_idx;

DROP INDEX IF EXISTS kernel_audit_foundation.audit_record_resource_idx;

DROP INDEX IF EXISTS kernel_audit_foundation.audit_record_actor_idx;

DROP INDEX IF EXISTS kernel_audit_foundation.audit_record_chronological_idx;

DROP TRIGGER IF EXISTS audit_record_is_append_only ON kernel_audit_foundation.audit_record;

DROP FUNCTION IF EXISTS kernel_audit_foundation.refuse_mutation();

DROP TABLE IF EXISTS kernel_audit_foundation.audit_record;

DROP SCHEMA IF EXISTS kernel_audit_foundation RESTRICT;

COMMIT;
