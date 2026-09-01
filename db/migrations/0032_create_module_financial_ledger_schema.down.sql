-- migration: 0032_create_module_financial_ledger_schema
-- direction: down
-- owner: module_financial_ledger
--
-- Reverses 0032. Nothing outside M-13 depends on these objects and the migration ledger that records
-- this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters. The triggers reference `refuse_mutation` and `assert_plan_adds_up`, so they go
-- first. The tables' CHECK constraints reference `is_opaque_identifier`, so the tables go before
-- that function.

BEGIN;

DROP INDEX IF EXISTS module_financial_ledger.outbox_unprocessed_idx;

DROP INDEX IF EXISTS module_financial_ledger.value_leg_external_reference_idx;
DROP INDEX IF EXISTS module_financial_ledger.value_leg_transaction_idx;
DROP INDEX IF EXISTS module_financial_ledger.value_leg_plan_idx;

DROP INDEX IF EXISTS module_financial_ledger.value_plan_status_idx;
DROP INDEX IF EXISTS module_financial_ledger.value_plan_payer_idx;
DROP INDEX IF EXISTS module_financial_ledger.value_plan_live_obligation_idx;

DROP INDEX IF EXISTS module_financial_ledger.wallet_state_wallet_idx;
DROP INDEX IF EXISTS module_financial_ledger.wallet_asset_idx;
DROP INDEX IF EXISTS module_financial_ledger.wallet_owner_idx;

DROP TRIGGER IF EXISTS wallet_state_is_append_only ON module_financial_ledger.wallet_state;
DROP TRIGGER IF EXISTS value_leg_plan_adds_up ON module_financial_ledger.value_leg;

DROP TABLE IF EXISTS module_financial_ledger.outbox;

DROP TABLE IF EXISTS module_financial_ledger.value_leg;

DROP TABLE IF EXISTS module_financial_ledger.value_plan;

DROP TABLE IF EXISTS module_financial_ledger.wallet_state;

DROP TABLE IF EXISTS module_financial_ledger.wallet;

DROP FUNCTION IF EXISTS module_financial_ledger.assert_plan_adds_up();

DROP FUNCTION IF EXISTS module_financial_ledger.refuse_mutation();

DROP FUNCTION IF EXISTS module_financial_ledger.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_financial_ledger RESTRICT;

COMMIT;
