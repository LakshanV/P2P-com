-- migration: 0031_allow_indivisible_asset_precision
-- direction: down
-- owner: kernel_ledger_foundation
--
-- Restores 0017's `precision > 0`.
--
-- **This rollback can fail, and that is correct.** If any asset type has been registered as
-- indivisible, restoring the narrower constraint would invalidate a live row, and PostgreSQL will
-- refuse to add the constraint rather than silently accept a table that violates it. An operator
-- who genuinely needs to roll back past this point has to decide what those asset types should
-- become — and that is a decision about money, not something a migration should make on their
-- behalf.

BEGIN;

ALTER TABLE kernel_ledger_foundation.asset_type
  DROP CONSTRAINT IF EXISTS asset_type_precision_plausible;

ALTER TABLE kernel_ledger_foundation.asset_type
  ADD CONSTRAINT asset_type_precision_positive
    CHECK (precision > 0);

COMMENT ON COLUMN kernel_ledger_foundation.asset_type.precision IS
  'Decimal places the asset divides into.';

COMMIT;
