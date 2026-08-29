-- migration: 0017_create_kernel_ledger_schema
-- direction: down
-- owner: kernel_ledger_foundation

BEGIN;

DROP TRIGGER IF EXISTS ledger_entry_is_append_only ON kernel_ledger_foundation.ledger_entry;
DROP TRIGGER IF EXISTS ledger_transaction_is_append_only ON kernel_ledger_foundation.ledger_transaction;
DROP TRIGGER IF EXISTS ledger_account_is_append_only ON kernel_ledger_foundation.ledger_account;
DROP TRIGGER IF EXISTS asset_type_is_append_only ON kernel_ledger_foundation.asset_type;

DROP TRIGGER IF EXISTS ledger_entry_balanced ON kernel_ledger_foundation.ledger_entry;

DROP FUNCTION IF EXISTS kernel_ledger_foundation.refuse_mutation();
DROP FUNCTION IF EXISTS kernel_ledger_foundation.enforce_balanced_transaction();

DROP INDEX IF EXISTS kernel_ledger_foundation.ledger_entry_account_idx;
DROP TABLE IF EXISTS kernel_ledger_foundation.ledger_entry;

DROP TABLE IF EXISTS kernel_ledger_foundation.ledger_transaction;

DROP INDEX IF EXISTS kernel_ledger_foundation.ledger_account_asset_type_idx;
DROP TABLE IF EXISTS kernel_ledger_foundation.ledger_account;

DROP TABLE IF EXISTS kernel_ledger_foundation.asset_type;

DROP INDEX IF EXISTS kernel_ledger_foundation.outbox_unprocessed_idx;
DROP TABLE IF EXISTS kernel_ledger_foundation.outbox;

DROP FUNCTION IF EXISTS kernel_ledger_foundation.is_asset_symbol(text);
DROP FUNCTION IF EXISTS kernel_ledger_foundation.is_asset_type_id(text);
DROP FUNCTION IF EXISTS kernel_ledger_foundation.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS kernel_ledger_foundation RESTRICT;

COMMIT;
