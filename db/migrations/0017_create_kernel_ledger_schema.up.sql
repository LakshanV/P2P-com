-- migration: 0017_create_kernel_ledger_schema
-- direction: up
-- owner: kernel_ledger_foundation
--
-- K-10 Ledger Foundation's own namespace and its four tables (FND-005d).
--
-- Every amount in the platform is recorded here as an integer number of minor units (`bigint`).
-- Floating point is never used for money.
--
-- The schema owns four business tables:
--
--   * `asset_type` — the unit of account: id, class, symbol, precision, transferability,
--     withdrawability and valuation source.
--   * `ledger_account` — one position in one asset type, with a normal balance side.
--   * `ledger_transaction` — the header of a balanced movement, carrying the asset type of all its
--     lines.
--   * `ledger_entry` — one line of a transaction: account, side and amount.
--
-- Plus the module's `outbox` table, following the same column layout as migrations 0013-0016.
--
-- All business tables are append-only: there is no UPDATE or DELETE path. Ledger state is derived
-- from the immutable journal of entries; editing a posted transaction would silently rewrite every
-- balance that ever depended on it.
--
-- `is_opaque_identifier` is K-10's own copy of the rule set used by K-01, K-02, K-03, K-04, K-06,
-- K-07 and K-11, in K-10's schema, for the same ownership reason: a CHECK calling another schema's
-- function would make the two components one object. The copies are required to be
-- character-for-character identical by `tests/migrations.test.ts`.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_ledger_foundation;

COMMENT ON SCHEMA kernel_ledger_foundation IS
  'K-10 Ledger Foundation. Asset types, ledger accounts, balanced transactions and entries. All money is integer minor units; no floating point.';

-- Character-for-character identical to the copies in kernel_identity, kernel_authentication,
-- kernel_accounts, kernel_permissions, kernel_policy_engine, kernel_feature_flags and
-- kernel_commerce_unit_registry, and required to stay so by test.
CREATE OR REPLACE FUNCTION kernel_ledger_foundation.is_opaque_identifier(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $rules$
  SELECT
    -- Shape: 8-128 characters, opaque alphabet, starting alphanumeric. Shorter than 8 is an
    -- ordinal, and an enumerable identity space lets anybody count the platform's parties.
        value ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    -- Credentials, by name and by shape. An identity record is permanent; a secret in one is
    -- disclosed for as long as the platform exists.
    AND value !~* '(password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|credential|authorization|bearer)'
    AND value !~ '\ysk-[A-Za-z0-9]{16,}'
    AND value !~ '\yghp_[A-Za-z0-9]{20,}'
    AND value !~ '\yAKIA[0-9A-Z]{16}'
    AND value !~ '\yeyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
    -- Natural keys. Each of these publishes personal data into every row that copies the id.
    AND position('@' in value) = 0
    AND value !~ '^[0-9]{7,}$'
    AND value !~ '[0-9]{12,}'
    AND value !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,}$'
    AND value !~* '^(https?|mailto|tel):'
    AND value !~* '\.(com|net|org|io|co|uk|lk)$'
    AND value !~ '^[A-Za-z]+[._-][A-Za-z]+$'
    AND value !~* '^(dob|ssn|nic|nin|tin|vat|passport)[-._:]'
$rules$;

COMMENT ON FUNCTION kernel_ledger_foundation.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- Asset type ids are lower_snake_case and scoped to K-10.
CREATE OR REPLACE FUNCTION kernel_ledger_foundation.is_asset_type_id(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $asset_id$
  SELECT value ~ '^[a-z][a-z0-9_]*$'
$asset_id$;

COMMENT ON FUNCTION kernel_ledger_foundation.is_asset_type_id(text) IS
  'True when the value is a well-formed K-10 asset type id: lower_snake_case starting with a letter.';

-- Asset symbols are upper-case tokens like LKR or JAYA_POINTS.
CREATE OR REPLACE FUNCTION kernel_ledger_foundation.is_asset_symbol(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $symbol$
  SELECT value ~ '^[A-Z][A-Z0-9_]{1,31}$'
$symbol$;

COMMENT ON FUNCTION kernel_ledger_foundation.is_asset_symbol(text) IS
  'True when the value is a well-formed asset symbol: upper-case letters, digits and underscores.';

-- ---------------------------------------------------------------------------
-- Asset types: the unit of account
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_ledger_foundation.asset_type (
  asset_type_id     text        NOT NULL,
  asset_class       text        NOT NULL,
  symbol            text        NOT NULL,
  precision         integer     NOT NULL,
  transferability   boolean     NOT NULL,
  withdrawability   boolean     NOT NULL,
  valuation_source  text        NOT NULL,

  CONSTRAINT asset_type_pkey PRIMARY KEY (asset_type_id),
  CONSTRAINT asset_type_id_shape
    CHECK (kernel_ledger_foundation.is_asset_type_id(asset_type_id)),
  CONSTRAINT asset_type_symbol_shape
    CHECK (kernel_ledger_foundation.is_asset_symbol(symbol)),
  CONSTRAINT asset_type_class_known
    CHECK (asset_class IN ('fiat', 'reward', 'digital_asset', 'community')),
  CONSTRAINT asset_type_precision_positive
    CHECK (precision > 0),
  CONSTRAINT asset_type_valuation_source_present
    CHECK (length(btrim(valuation_source)) > 0)
);

COMMENT ON TABLE kernel_ledger_foundation.asset_type IS
  'A unit of account. Asset type ids are lower_snake_case; symbols are upper-case tokens.';

-- ---------------------------------------------------------------------------
-- Ledger accounts: one position in one asset type
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_ledger_foundation.ledger_account (
  account_id        text        NOT NULL,
  asset_type_id     text        NOT NULL,
  owner_id          text        NOT NULL,
  normal_balance    text        NOT NULL,
  created_at        timestamptz NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT ledger_account_pkey PRIMARY KEY (account_id),
  CONSTRAINT ledger_account_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT ledger_account_id_opaque
    CHECK (kernel_ledger_foundation.is_opaque_identifier(account_id)),
  CONSTRAINT ledger_account_asset_type_id_shape
    CHECK (kernel_ledger_foundation.is_asset_type_id(asset_type_id)),
  CONSTRAINT ledger_account_owner_id_opaque
    CHECK (kernel_ledger_foundation.is_opaque_identifier(owner_id)),
  CONSTRAINT ledger_account_normal_balance_known
    CHECK (normal_balance IN ('debit', 'credit')),
  CONSTRAINT ledger_account_idempotency_key_opaque
    CHECK (kernel_ledger_foundation.is_opaque_identifier(idempotency_key)),
  CONSTRAINT ledger_account_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT ledger_account_asset_type_exists
    FOREIGN KEY (asset_type_id) REFERENCES kernel_ledger_foundation.asset_type(asset_type_id)
);

COMMENT ON TABLE kernel_ledger_foundation.ledger_account IS
  'A ledger position in one asset type. Balances are derived from entries; there is no balance column.';

CREATE INDEX IF NOT EXISTS ledger_account_asset_type_idx
  ON kernel_ledger_foundation.ledger_account (asset_type_id, account_id);

-- ---------------------------------------------------------------------------
-- Ledger transactions: the header of a balanced movement
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_ledger_foundation.ledger_transaction (
  transaction_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,
  posted_at         timestamptz NOT NULL,
  asset_type_id     text        NOT NULL,

  CONSTRAINT ledger_transaction_pkey PRIMARY KEY (transaction_id),
  CONSTRAINT ledger_transaction_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT ledger_transaction_id_opaque
    CHECK (kernel_ledger_foundation.is_opaque_identifier(transaction_id)),
  CONSTRAINT ledger_transaction_idempotency_key_opaque
    CHECK (kernel_ledger_foundation.is_opaque_identifier(idempotency_key)),
  CONSTRAINT ledger_transaction_asset_type_id_shape
    CHECK (kernel_ledger_foundation.is_asset_type_id(asset_type_id)),
  CONSTRAINT ledger_transaction_posted_at_finite
    CHECK (posted_at > '-infinity'::timestamptz AND posted_at < 'infinity'::timestamptz),
  CONSTRAINT ledger_transaction_asset_type_exists
    FOREIGN KEY (asset_type_id) REFERENCES kernel_ledger_foundation.asset_type(asset_type_id)
);

COMMENT ON TABLE kernel_ledger_foundation.ledger_transaction IS
  'The header of a balanced ledger movement. Every line is in the same asset type.';

-- ---------------------------------------------------------------------------
-- Ledger entries: the lines of a transaction
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_ledger_foundation.ledger_entry (
  transaction_id    text        NOT NULL,
  account_id        text        NOT NULL,
  side              text        NOT NULL,
  amount            bigint      NOT NULL,

  CONSTRAINT ledger_entry_pkey PRIMARY KEY (transaction_id, account_id, side),

  CONSTRAINT ledger_entry_side_known
    CHECK (side IN ('debit', 'credit')),
  CONSTRAINT ledger_entry_amount_non_negative
    CHECK (amount >= 0),
  CONSTRAINT ledger_entry_transaction_exists
    FOREIGN KEY (transaction_id) REFERENCES kernel_ledger_foundation.ledger_transaction(transaction_id),
  CONSTRAINT ledger_entry_account_exists
    FOREIGN KEY (account_id) REFERENCES kernel_ledger_foundation.ledger_account(account_id)
);

COMMENT ON TABLE kernel_ledger_foundation.ledger_entry IS
  'One line of a balanced transaction. Amounts are integer minor units.';

CREATE INDEX IF NOT EXISTS ledger_entry_account_idx
  ON kernel_ledger_foundation.ledger_entry (account_id);

-- ---------------------------------------------------------------------------
-- Deferred constraint trigger: every transaction must balance, every entry must
-- reference an account in the transaction's asset type, and a transaction must
-- have at least one entry.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION kernel_ledger_foundation.enforce_balanced_transaction()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  v_asset_type_id text;
  v_debits bigint;
  v_credits bigint;
  v_count integer;
BEGIN
  SELECT asset_type_id INTO v_asset_type_id
    FROM kernel_ledger_foundation.ledger_transaction
   WHERE transaction_id = NEW.transaction_id;

  IF v_asset_type_id IS NULL THEN
    RAISE EXCEPTION 'transaction % does not exist', NEW.transaction_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT count(*), COALESCE(SUM(amount) FILTER (WHERE side = 'debit'), 0),
         COALESCE(SUM(amount) FILTER (WHERE side = 'credit'), 0)
    INTO v_count, v_debits, v_credits
    FROM kernel_ledger_foundation.ledger_entry
   WHERE transaction_id = NEW.transaction_id;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'transaction % has no entries', NEW.transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'transaction % is unbalanced: debits %, credits %',
      NEW.transaction_id, v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM 1
    FROM kernel_ledger_foundation.ledger_entry e
    JOIN kernel_ledger_foundation.ledger_account a ON a.account_id = e.account_id
   WHERE e.transaction_id = NEW.transaction_id
     AND a.asset_type_id <> v_asset_type_id;

  IF FOUND THEN
    RAISE EXCEPTION 'transaction % references accounts of different asset types', NEW.transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION kernel_ledger_foundation.enforce_balanced_transaction() IS
  'Deferred trigger function that refuses unbalanced transactions, empty transactions, or mixed-asset-type entries.';

CREATE CONSTRAINT TRIGGER ledger_entry_balanced
  AFTER INSERT OR UPDATE ON kernel_ledger_foundation.ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION kernel_ledger_foundation.enforce_balanced_transaction();

-- ---------------------------------------------------------------------------
-- Outbox: the module's transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_ledger_foundation.outbox (
  outbox_id           text        NOT NULL,
  idempotency_key     text        NOT NULL,
  kind                text        NOT NULL,
  payload             jsonb       NOT NULL,
  recorded_at         timestamptz NOT NULL,
  producer            text        NOT NULL,
  correlation_id      text        NOT NULL,
  processed_at        timestamptz NULL,
  retry_count         integer     NOT NULL DEFAULT 0,
  last_error          text        NULL,

  CONSTRAINT outbox_pkey PRIMARY KEY (outbox_id),
  CONSTRAINT outbox_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT outbox_kind_known CHECK (kind IN ('event', 'audit')),
  CONSTRAINT outbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_retry_non_negative CHECK (retry_count >= 0)
);

COMMENT ON TABLE kernel_ledger_foundation.outbox IS
  'Transactional outbox for ledger events and audit records, dispatched by a relay.';

CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON kernel_ledger_foundation.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION kernel_ledger_foundation.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'ledger history is append-only: % on % is refused. A correction is a new transaction, not an edit',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_ledger_foundation.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any business table in this schema.';

CREATE TRIGGER asset_type_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_ledger_foundation.asset_type
  FOR EACH ROW EXECUTE FUNCTION kernel_ledger_foundation.refuse_mutation();

CREATE TRIGGER ledger_account_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_ledger_foundation.ledger_account
  FOR EACH ROW EXECUTE FUNCTION kernel_ledger_foundation.refuse_mutation();

CREATE TRIGGER ledger_transaction_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_ledger_foundation.ledger_transaction
  FOR EACH ROW EXECUTE FUNCTION kernel_ledger_foundation.refuse_mutation();

CREATE TRIGGER ledger_entry_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_ledger_foundation.ledger_entry
  FOR EACH ROW EXECUTE FUNCTION kernel_ledger_foundation.refuse_mutation();

COMMIT;
