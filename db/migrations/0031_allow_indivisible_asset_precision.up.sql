-- migration: 0031_allow_indivisible_asset_precision
-- direction: up
-- owner: kernel_ledger_foundation
--
-- Widen `asset_type_precision_positive` so an **indivisible** asset can be registered.
--
-- 0017 required `precision > 0`, which quietly made one whole class of value unrepresentable: a
-- loyalty stamp, a ticket, a seat, and a reward point that comes only in whole units. A ledger that
-- describes itself as universal and cannot express those is not universal, and the workaround —
-- inventing a fictional minor unit and remembering never to use it — is the kind of thing that is
-- fine until somebody divides by it.
--
-- The rule was also inconsistent with itself across the financial zone: M-12 Payments already
-- accepts an asset scale of zero, with a comment saying that an indivisible unit is legitimate. Two
-- components in the same zone disagreeing about whether a reward point can exist is a defect
-- whichever way it is resolved, and this is the direction that loses nothing.
--
-- A ceiling of 18 is added at the same time. It was previously unbounded, so `precision = 4000`
-- would have been accepted and no amount denominated in it could have been rendered by anything.
-- Eighteen is the largest decimal exponent in common use.
--
-- **Widening only.** Every asset type that satisfied the old constraint satisfies the new one, so
-- no existing row can be invalidated and the migration cannot fail on live data.

BEGIN;

ALTER TABLE kernel_ledger_foundation.asset_type
  DROP CONSTRAINT IF EXISTS asset_type_precision_positive;

ALTER TABLE kernel_ledger_foundation.asset_type
  ADD CONSTRAINT asset_type_precision_plausible
    CHECK (precision >= 0 AND precision <= 18);

COMMENT ON COLUMN kernel_ledger_foundation.asset_type.precision IS
  'Decimal places the asset divides into. Zero means indivisible — a stamp, a ticket, a whole-unit reward point.';

COMMIT;
