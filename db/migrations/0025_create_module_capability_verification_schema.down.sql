-- migration: 0025_create_module_capability_verification_schema
-- direction: down
-- owner: module_capability_verification
--
-- Reverses 0025. Nothing outside M-02 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters. The triggers reference `refuse_mutation`, so they go first. The tables' CHECK
-- constraints reference `is_opaque_identifier`, so the tables go before that function.

BEGIN;

DROP INDEX IF EXISTS module_capability_verification.outbox_unprocessed_idx;

DROP INDEX IF EXISTS module_capability_verification.level_record_account_idx;
DROP INDEX IF EXISTS module_capability_verification.level_record_case_idx;

DROP INDEX IF EXISTS module_capability_verification.evidence_account_idx;
DROP INDEX IF EXISTS module_capability_verification.evidence_case_idx;

DROP INDEX IF EXISTS module_capability_verification.verification_case_achieved_level_idx;
DROP INDEX IF EXISTS module_capability_verification.verification_case_status_idx;
DROP INDEX IF EXISTS module_capability_verification.verification_case_account_idx;
DROP INDEX IF EXISTS module_capability_verification.verification_case_one_open_per_purpose_idx;

DROP TRIGGER IF EXISTS level_record_is_append_only
  ON module_capability_verification.level_record;

DROP TRIGGER IF EXISTS evidence_is_append_only
  ON module_capability_verification.evidence;

DROP TABLE IF EXISTS module_capability_verification.outbox;

DROP TABLE IF EXISTS module_capability_verification.level_record;

DROP TABLE IF EXISTS module_capability_verification.evidence;

DROP TABLE IF EXISTS module_capability_verification.verification_case;

DROP FUNCTION IF EXISTS module_capability_verification.refuse_mutation();

DROP FUNCTION IF EXISTS module_capability_verification.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_capability_verification RESTRICT;

COMMIT;
