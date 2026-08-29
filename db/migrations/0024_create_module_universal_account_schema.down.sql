-- migration: 0024_create_module_universal_account_schema
-- direction: down
-- owner: module_universal_account
--
-- Reverses 0024. Nothing outside M-01 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters. The trigger references `refuse_mutation`, so it goes first. The tables' CHECK
-- constraints reference `is_opaque_identifier`, so the tables go before that function.

BEGIN;

DROP INDEX IF EXISTS module_universal_account.outbox_unprocessed_idx;

DROP INDEX IF EXISTS module_universal_account.capability_state_account_idx;
DROP INDEX IF EXISTS module_universal_account.capability_state_capability_idx;

DROP INDEX IF EXISTS module_universal_account.account_capability_status_idx;
DROP INDEX IF EXISTS module_universal_account.account_capability_capability_idx;
DROP INDEX IF EXISTS module_universal_account.account_capability_account_idx;

DROP TRIGGER IF EXISTS capability_state_is_append_only
  ON module_universal_account.capability_state;

DROP TABLE IF EXISTS module_universal_account.outbox;

DROP TABLE IF EXISTS module_universal_account.capability_state;

DROP TABLE IF EXISTS module_universal_account.account_capability;

DROP FUNCTION IF EXISTS module_universal_account.refuse_mutation();

DROP FUNCTION IF EXISTS module_universal_account.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_universal_account RESTRICT;

COMMIT;
