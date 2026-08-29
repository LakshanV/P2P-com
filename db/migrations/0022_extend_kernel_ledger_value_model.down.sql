-- migration: 0022_extend_kernel_ledger_value_model
-- direction: down
-- owner: kernel_ledger_foundation
--
-- Undo 0022: remove the multi-value attributes from `asset_type` and the balance-state position
-- from `ledger_entry`, restoring the shape migration 0017 created.
--
-- Rolling this back is lossy by construction. Any entry written into the `pending` or `locked`
-- position collapses back into the single balance 0017 understood, and any asset type that declared
-- an issuer, an expiry or a restriction loses that declaration. That is the honest consequence of
-- undoing a widening, and the reason the rollback drops the constraints before the columns rather
-- than trying to preserve anything.
--
-- The entry primary key returns to the three columns 0017 declared. If two rows differ only by
-- `balance_state`, restoring the narrower key is impossible and PostgreSQL will refuse the
-- rollback rather than silently discard one of them — which is the correct outcome.

BEGIN;

-- --- ledger_entry ----------------------------------------------------------

DROP INDEX IF EXISTS kernel_ledger_foundation.ledger_entry_account_state_idx;

ALTER TABLE kernel_ledger_foundation.ledger_entry
  DROP CONSTRAINT IF EXISTS ledger_entry_pkey;

ALTER TABLE kernel_ledger_foundation.ledger_entry
  ADD CONSTRAINT ledger_entry_pkey PRIMARY KEY (transaction_id, account_id, side);

ALTER TABLE kernel_ledger_foundation.ledger_entry
  DROP CONSTRAINT IF EXISTS ledger_entry_balance_state_known;

ALTER TABLE kernel_ledger_foundation.ledger_entry
  DROP COLUMN IF EXISTS balance_state;

-- --- asset_type ------------------------------------------------------------

ALTER TABLE kernel_ledger_foundation.asset_type
  DROP CONSTRAINT IF EXISTS asset_type_issuer_opaque,
  DROP CONSTRAINT IF EXISTS asset_type_unit_shape,
  DROP CONSTRAINT IF EXISTS asset_type_expiry_days_positive,
  DROP CONSTRAINT IF EXISTS asset_type_restrictions_is_object,
  DROP CONSTRAINT IF EXISTS asset_type_custody_provider_opaque,
  DROP CONSTRAINT IF EXISTS asset_type_jurisdiction_known;

ALTER TABLE kernel_ledger_foundation.asset_type
  DROP COLUMN IF EXISTS issuer,
  DROP COLUMN IF EXISTS unit,
  DROP COLUMN IF EXISTS redeemable,
  DROP COLUMN IF EXISTS convertible,
  DROP COLUMN IF EXISTS expiry_days,
  DROP COLUMN IF EXISTS restrictions,
  DROP COLUMN IF EXISTS custody_provider,
  DROP COLUMN IF EXISTS jurisdiction;

DROP FUNCTION IF EXISTS kernel_ledger_foundation.is_jurisdiction(text);
DROP FUNCTION IF EXISTS kernel_ledger_foundation.is_unit_name(text);

COMMIT;
