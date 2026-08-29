-- migration: 0022_extend_kernel_ledger_value_model
-- direction: up
-- owner: kernel_ledger_foundation
--
-- K-10 Ledger Foundation — the universal multi-value model.
--
-- Migration 0017 gave K-10 a correct double-entry core in four asset classes. What it could not yet
-- express is the difference between kinds of value that happen to share a class. Two reward points
-- issued by different merchants, one redeemable and expiring, one not, were the same object.
--
-- This migration adds the attributes that make a value type describable, and splits an account's
-- single balance into the three positions every settlement system needs.
--
-- 1. `asset_type` gains eight attributes:
--
--      issuer            who stands behind the value, and therefore who a holder has a claim against
--      unit              the name of the minor unit amounts are counted in
--      redeemable        may a holder redeem it against the issuer's goods or services?
--      convertible       may it be converted into another asset type?
--      expiry_days       days from issue until it expires, NULL when it never does
--      restrictions      structured limits on use; '{}' means unrestricted
--      custody_provider  the custodian holding the underlying value, NULL when the platform does
--      jurisdiction      ISO 3166-1 alpha-2, or GLOBAL
--
--    Without these, reward points and community credits are indistinguishable from cash, which is
--    precisely the confusion a multi-value ledger exists to prevent.
--
-- 2. `ledger_entry` gains `balance_state`, so one account holds three positions rather than one:
--    available (spendable now), pending (promised, unsettled) and locked (reserved against an
--    obligation). Moving value between positions is an ordinary balanced transaction on the same
--    account — debit one position, credit another — so the journal stays append-only, the account
--    total does not change, and there is still no balance column to disagree with the entries.
--
--    The entry primary key widens to include `balance_state`, because one transaction may legally
--    debit an account's available position and credit its locked position.
--
-- Existing rows are backfilled to 'available', which is what every entry written before this
-- migration meant. The column defaults are dropped afterwards so a writer must state the value
-- rather than inherit one: an asset type whose issuer was defaulted is an asset type nobody decided.
--
-- Forward-additive: no column is dropped, no row is deleted, and the balanced-transaction trigger
-- from 0017 is untouched because debits must still equal credits across the whole transaction.
--
-- This migration touches no other unit's schema.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Asset type attributes
-- ---------------------------------------------------------------------------

-- The unit name: lower_snake_case, e.g. cent, satoshi, point.
CREATE OR REPLACE FUNCTION kernel_ledger_foundation.is_unit_name(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $unit$
  SELECT value ~ '^[a-z][a-z0-9_]*$'
$unit$;

COMMENT ON FUNCTION kernel_ledger_foundation.is_unit_name(text) IS
  'True when the value is a well-formed minor-unit name: lower_snake_case starting with a letter.';

-- ISO 3166-1 alpha-2, or the reserved word GLOBAL for value not bound to one jurisdiction.
CREATE OR REPLACE FUNCTION kernel_ledger_foundation.is_jurisdiction(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $jurisdiction$
  SELECT value ~ '^([A-Z]{2}|GLOBAL)$'
$jurisdiction$;

COMMENT ON FUNCTION kernel_ledger_foundation.is_jurisdiction(text) IS
  'True when the value is an ISO 3166-1 alpha-2 country code, or the reserved word GLOBAL.';

ALTER TABLE kernel_ledger_foundation.asset_type
  ADD COLUMN IF NOT EXISTS issuer           text    NOT NULL DEFAULT 'jaya_platform_v1',
  ADD COLUMN IF NOT EXISTS unit             text    NOT NULL DEFAULT 'minor_unit',
  ADD COLUMN IF NOT EXISTS redeemable       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS convertible      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS expiry_days      integer NULL,
  ADD COLUMN IF NOT EXISTS restrictions     jsonb   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS custody_provider text    NULL,
  ADD COLUMN IF NOT EXISTS jurisdiction     text    NOT NULL DEFAULT 'GLOBAL';

-- The defaults existed to backfill rows written under 0017. A writer must now state each value:
-- an issuer nobody chose is an issuer nobody stands behind.
ALTER TABLE kernel_ledger_foundation.asset_type
  ALTER COLUMN issuer       DROP DEFAULT,
  ALTER COLUMN unit         DROP DEFAULT,
  ALTER COLUMN redeemable   DROP DEFAULT,
  ALTER COLUMN convertible  DROP DEFAULT,
  ALTER COLUMN restrictions DROP DEFAULT,
  ALTER COLUMN jurisdiction DROP DEFAULT;

ALTER TABLE kernel_ledger_foundation.asset_type
  ADD CONSTRAINT asset_type_issuer_opaque
    CHECK (kernel_ledger_foundation.is_opaque_identifier(issuer)),
  ADD CONSTRAINT asset_type_unit_shape
    CHECK (kernel_ledger_foundation.is_unit_name(unit)),
  ADD CONSTRAINT asset_type_expiry_days_positive
    CHECK (expiry_days IS NULL OR expiry_days > 0),
  ADD CONSTRAINT asset_type_restrictions_is_object
    CHECK (jsonb_typeof(restrictions) = 'object'),
  ADD CONSTRAINT asset_type_custody_provider_opaque
    CHECK (custody_provider IS NULL
           OR kernel_ledger_foundation.is_opaque_identifier(custody_provider)),
  ADD CONSTRAINT asset_type_jurisdiction_known
    CHECK (kernel_ledger_foundation.is_jurisdiction(jurisdiction));

COMMENT ON COLUMN kernel_ledger_foundation.asset_type.issuer IS
  'The party that issued this value and stands behind it; who a holder has a claim against.';
COMMENT ON COLUMN kernel_ledger_foundation.asset_type.unit IS
  'The name of the minor unit amounts are counted in, e.g. cent, satoshi, point.';
COMMENT ON COLUMN kernel_ledger_foundation.asset_type.redeemable IS
  'May a holder redeem this value against goods or services from the issuer?';
COMMENT ON COLUMN kernel_ledger_foundation.asset_type.convertible IS
  'May this value be converted into another asset type?';
COMMENT ON COLUMN kernel_ledger_foundation.asset_type.expiry_days IS
  'Days from issue until the value expires; NULL when it never expires.';
COMMENT ON COLUMN kernel_ledger_foundation.asset_type.restrictions IS
  'Structured limits on how the value may be used. K-10 stores them; the spending module enforces them.';
COMMENT ON COLUMN kernel_ledger_foundation.asset_type.custody_provider IS
  'The custodian holding the underlying value; NULL when the platform holds it itself.';
COMMENT ON COLUMN kernel_ledger_foundation.asset_type.jurisdiction IS
  'ISO 3166-1 alpha-2 country code, or GLOBAL when the value is not bound to one jurisdiction.';

-- ---------------------------------------------------------------------------
-- 2. Balance states on ledger entries
-- ---------------------------------------------------------------------------

ALTER TABLE kernel_ledger_foundation.ledger_entry
  ADD COLUMN IF NOT EXISTS balance_state text NOT NULL DEFAULT 'available';

-- Same reasoning as above: the default existed to backfill rows written under 0017, where every
-- entry meant 'available'. New writers say which position they are moving.
ALTER TABLE kernel_ledger_foundation.ledger_entry
  ALTER COLUMN balance_state DROP DEFAULT;

ALTER TABLE kernel_ledger_foundation.ledger_entry
  ADD CONSTRAINT ledger_entry_balance_state_known
    CHECK (balance_state IN ('available', 'pending', 'locked'));

COMMENT ON COLUMN kernel_ledger_foundation.ledger_entry.balance_state IS
  'Which of the account''s three positions this line moves: available, pending or locked.';

-- One transaction may legally move value between two positions of the same account, which the
-- three-column key forbade.
ALTER TABLE kernel_ledger_foundation.ledger_entry
  DROP CONSTRAINT ledger_entry_pkey;

ALTER TABLE kernel_ledger_foundation.ledger_entry
  ADD CONSTRAINT ledger_entry_pkey
    PRIMARY KEY (transaction_id, account_id, side, balance_state);

CREATE INDEX IF NOT EXISTS ledger_entry_account_state_idx
  ON kernel_ledger_foundation.ledger_entry (account_id, balance_state);

COMMIT;
