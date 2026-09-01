-- migration: 0032_create_module_financial_ledger_schema
-- direction: up
-- owner: module_financial_ledger
--
-- M-13 Financial Ledger's own namespace: the wallet map, its append-only status history, the value
-- plan, its legs, and the module outbox.
--
-- Owned data:
--   * `wallet`       — a named position: this party, this asset type, this purpose, over one K-10
--     ledger account.
--   * `wallet_state` — how a wallet came to be frozen or closed. Append-only.
--   * `value_plan`   — one obligation and the several kinds of value paying it.
--   * `value_leg`    — one source of value against that obligation.
--   * `outbox`       — the module's transactional outbox for K-08 events and K-09 audit records.
--
-- **No balance column exists in this schema, and none ever may.** K-10 derives every balance by
-- summing entries; a column here would be a second source of truth about money, and it would be the
-- one that is wrong. `ledger_account_id` is an opaque K-10 identifier and deliberately **not** a
-- foreign key: MODULE_MAP §10.4 forbids one unit joining to another's tables. The same applies to
-- `owner_account_id` (K-03), `obligation_id` (usually M-11) and `external_reference` (M-12).
--
-- M-13 sits in the deterministic financial authority zone. Every amount is an exact integer in
-- minor units. **No `double precision`, `real`, `float` or `money` column exists here**, and neither
-- does a decimal rate: a rate is a pair of integers, checked by cross-multiplication.
--
-- Two rules in this file are worth reading before the columns.
--
-- `value_leg_rate_is_exact` makes the no-rounding rule a database rule. A leg's amount at its stated
-- rate must equal its settlement equivalent exactly, by multiplication rather than division, so a
-- rate that does not divide evenly cannot be stored at all.
--
-- `value_plan_legs_sum_to_target` is a **deferred constraint trigger**, because the invariant spans
-- rows and no CHECK can express it. It fires at commit, so a transaction may insert a plan and its
-- legs in any order, and it refuses a plan whose legs do not add up to what is owed. This is the
-- module's central rule; leaving it to the service alone would mean the only thing standing between
-- a short payment and the ledger is code nobody re-reads.
--
-- `is_opaque_identifier` is M-13's own copy of the rule set used by every other unit, in M-13's
-- schema, for the same ownership reason: a CHECK calling another schema's function would make the
-- two units one object. The copies are required to be character-for-character identical by
-- `tests/migrations.test.ts`.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_financial_ledger;

COMMENT ON SCHEMA module_financial_ledger IS
  'M-13 Financial Ledger. The wallet map over K-10 accounts, value plans and their legs, and the module outbox. Holds no balance.';

-- Character-for-character identical to the copies in every other schema that carries one, and
-- required to stay so by test.
CREATE OR REPLACE FUNCTION module_financial_ledger.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION module_financial_ledger.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- ---------------------------------------------------------------------------
-- Wallet: a named position over a K-10 account
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_financial_ledger.wallet (
  wallet_id          text        NOT NULL,
  owner_account_id   text        NOT NULL,
  asset_type_id      text        NOT NULL,
  purpose            text        NOT NULL,
  ledger_account_id  text        NOT NULL,
  status             text        NOT NULL,
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  correlation_id     text        NOT NULL,
  idempotency_key    text        NOT NULL,

  CONSTRAINT wallet_pkey PRIMARY KEY (wallet_id),
  CONSTRAINT wallet_idempotency_unique UNIQUE (idempotency_key),
  -- One party holds one wallet per asset type and purpose. Two would split their money in half with
  -- nothing to say which half is theirs.
  CONSTRAINT wallet_position_unique UNIQUE (owner_account_id, asset_type_id, purpose),
  -- One wallet per K-10 account. Two wallets naming one account would each report the whole balance
  -- as their own, and the same money would appear twice in any total.
  CONSTRAINT wallet_ledger_account_unique UNIQUE (ledger_account_id),

  CONSTRAINT wallet_id_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(wallet_id)),
  CONSTRAINT wallet_owner_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(owner_account_id)),
  CONSTRAINT wallet_ledger_account_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(ledger_account_id)),
  CONSTRAINT wallet_correlation_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(correlation_id)),
  CONSTRAINT wallet_idempotency_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(idempotency_key)),

  -- K-10's own asset type id rule, quoted rather than joined to.
  CONSTRAINT wallet_asset_type_well_formed
    CHECK (asset_type_id ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT wallet_purpose_known
    CHECK (purpose IN ('spending', 'earnings', 'escrow', 'savings', 'settlement', 'issuance')),
  CONSTRAINT wallet_status_known
    CHECK (status IN ('open', 'frozen', 'closed')),

  CONSTRAINT wallet_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT wallet_updated_at_finite
    CHECK (updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_financial_ledger.wallet IS
  'A named position over one K-10 ledger account: this party, this asset type, this purpose. Holds no balance.';

COMMENT ON COLUMN module_financial_ledger.wallet.purpose IS
  'What the wallet is for. Earnings is a purpose, not an asset class: a seller''s earnings and a buyer''s spending money may both be rupees.';

CREATE INDEX IF NOT EXISTS wallet_owner_idx
  ON module_financial_ledger.wallet (owner_account_id, created_at, wallet_id);

CREATE INDEX IF NOT EXISTS wallet_asset_idx
  ON module_financial_ledger.wallet (asset_type_id);

-- ---------------------------------------------------------------------------
-- Wallet state: how a wallet came to be frozen or closed
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_financial_ledger.wallet_state (
  state_id         text        NOT NULL,
  wallet_id        text        NOT NULL,
  from_status      text        NULL,
  to_status        text        NOT NULL,
  reason           text        NOT NULL,
  occurred_at      timestamptz NOT NULL,
  correlation_id   text        NOT NULL,
  idempotency_key  text        NOT NULL,

  CONSTRAINT wallet_state_pkey PRIMARY KEY (state_id),
  CONSTRAINT wallet_state_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT wallet_state_id_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(state_id)),
  CONSTRAINT wallet_state_wallet_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(wallet_id)),
  CONSTRAINT wallet_state_correlation_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(correlation_id)),
  CONSTRAINT wallet_state_idempotency_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(idempotency_key)),

  CONSTRAINT wallet_state_from_known
    CHECK (from_status IS NULL OR from_status IN ('open', 'frozen', 'closed')),
  CONSTRAINT wallet_state_to_known
    CHECK (to_status IN ('open', 'frozen', 'closed')),
  -- A transition that does not change the status is not a transition.
  CONSTRAINT wallet_state_changes_status
    CHECK (from_status IS NULL OR from_status <> to_status),
  CONSTRAINT wallet_state_reason_present
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  CONSTRAINT wallet_state_occurred_at_finite
    CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_financial_ledger.wallet_state IS
  'One change of a wallet''s status. Append-only: how a wallet came to be frozen is not editable.';

CREATE INDEX IF NOT EXISTS wallet_state_wallet_idx
  ON module_financial_ledger.wallet_state (wallet_id, occurred_at, state_id);

-- ---------------------------------------------------------------------------
-- Value plan: one obligation, several kinds of value
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_financial_ledger.value_plan (
  plan_id                   text        NOT NULL,
  obligation_id             text        NOT NULL,
  obligation_kind           text        NOT NULL,
  payer_account_id          text        NOT NULL,
  payee_account_id          text        NOT NULL,
  status                    text        NOT NULL,
  settlement_asset_type_id  text        NOT NULL,
  target_amount_minor       bigint      NOT NULL,
  committed_at              timestamptz NULL,
  settled_at                timestamptz NULL,
  cancelled_at              timestamptz NULL,
  cancellation_reason       text        NULL,
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  correlation_id            text        NOT NULL,
  idempotency_key           text        NOT NULL,

  CONSTRAINT value_plan_pkey PRIMARY KEY (plan_id),
  CONSTRAINT value_plan_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT value_plan_id_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(plan_id)),
  CONSTRAINT value_plan_obligation_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(obligation_id)),
  CONSTRAINT value_plan_payer_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(payer_account_id)),
  CONSTRAINT value_plan_payee_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(payee_account_id)),
  CONSTRAINT value_plan_correlation_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(correlation_id)),
  CONSTRAINT value_plan_idempotency_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(idempotency_key)),

  CONSTRAINT value_plan_obligation_kind_well_formed
    CHECK (obligation_kind ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT value_plan_settlement_asset_well_formed
    CHECK (settlement_asset_type_id ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT value_plan_status_known
    CHECK (status IN ('draft', 'committed', 'settled', 'cancelled')),
  -- An obligation of zero needs no plan, and an empty plan reported as paid is worse than none.
  CONSTRAINT value_plan_target_positive CHECK (target_amount_minor > 0),

  -- The status and its stamps must agree. A cancellation nobody can attribute is a support ticket.
  CONSTRAINT value_plan_cancelled_at_matches_status
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT value_plan_cancellation_reason_matches_status
    CHECK ((status = 'cancelled') = (cancellation_reason IS NOT NULL)),
  CONSTRAINT value_plan_cancellation_reason_present
    CHECK (cancellation_reason IS NULL
           OR (length(btrim(cancellation_reason)) > 0 AND length(cancellation_reason) <= 500)),
  CONSTRAINT value_plan_settled_at_present_once_settled
    CHECK (status <> 'settled' OR settled_at IS NOT NULL),
  CONSTRAINT value_plan_committed_at_present_once_past_draft
    CHECK (status IN ('draft', 'cancelled') OR committed_at IS NOT NULL),
  CONSTRAINT value_plan_draft_never_committed
    CHECK (status <> 'draft' OR committed_at IS NULL),

  CONSTRAINT value_plan_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT value_plan_updated_at_finite
    CHECK (updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_financial_ledger.value_plan IS
  'One obligation and the several kinds of value paying it. Its legs must sum to target_amount_minor exactly.';

-- One live plan per obligation. Partial, so a cancelled attempt does not block the next one, but two
-- committed plans against one order cannot exist — that would be the same thing paid for twice, and
-- downstream it would look like two ordinary payments.
CREATE UNIQUE INDEX IF NOT EXISTS value_plan_live_obligation_idx
  ON module_financial_ledger.value_plan (obligation_id)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS value_plan_payer_idx
  ON module_financial_ledger.value_plan (payer_account_id, created_at, plan_id);

CREATE INDEX IF NOT EXISTS value_plan_status_idx
  ON module_financial_ledger.value_plan (status);

-- ---------------------------------------------------------------------------
-- Value leg: one source of value against one obligation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_financial_ledger.value_leg (
  leg_id                       text        NOT NULL,
  plan_id                      text        NOT NULL,
  kind                         text        NOT NULL,
  status                       text        NOT NULL,
  asset_type_id                text        NOT NULL,
  source_wallet_id             text        NULL,
  destination_wallet_id        text        NOT NULL,
  amount_minor                 bigint      NOT NULL,
  rate_numerator               bigint      NOT NULL,
  rate_denominator             bigint      NOT NULL,
  settlement_equivalent_minor  bigint      NOT NULL,
  ledger_transaction_id        text        NULL,
  reversal_transaction_id      text        NULL,
  external_reference           text        NULL,
  created_at                   timestamptz NOT NULL,
  updated_at                   timestamptz NOT NULL,
  correlation_id               text        NOT NULL,
  idempotency_key              text        NOT NULL,

  CONSTRAINT value_leg_pkey PRIMARY KEY (leg_id),
  CONSTRAINT value_leg_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT value_leg_id_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(leg_id)),
  CONSTRAINT value_leg_plan_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(plan_id)),
  CONSTRAINT value_leg_source_opaque
    CHECK (source_wallet_id IS NULL
           OR module_financial_ledger.is_opaque_identifier(source_wallet_id)),
  CONSTRAINT value_leg_destination_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(destination_wallet_id)),
  CONSTRAINT value_leg_transaction_opaque
    CHECK (ledger_transaction_id IS NULL
           OR module_financial_ledger.is_opaque_identifier(ledger_transaction_id)),
  CONSTRAINT value_leg_reversal_opaque
    CHECK (reversal_transaction_id IS NULL
           OR module_financial_ledger.is_opaque_identifier(reversal_transaction_id)),
  CONSTRAINT value_leg_external_reference_opaque
    CHECK (external_reference IS NULL
           OR module_financial_ledger.is_opaque_identifier(external_reference)),
  CONSTRAINT value_leg_correlation_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(correlation_id)),
  CONSTRAINT value_leg_idempotency_opaque
    CHECK (module_financial_ledger.is_opaque_identifier(idempotency_key)),

  CONSTRAINT value_leg_asset_type_well_formed
    CHECK (asset_type_id ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT value_leg_kind_known CHECK (kind IN ('internal', 'external')),
  CONSTRAINT value_leg_status_known CHECK (status IN ('planned', 'posted', 'reversed')),

  CONSTRAINT value_leg_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT value_leg_settlement_non_negative CHECK (settlement_equivalent_minor >= 0),
  -- Both terms positive: a zero numerator makes value worthless and a zero denominator makes it
  -- undefined.
  CONSTRAINT value_leg_rate_terms_positive
    CHECK (rate_numerator > 0 AND rate_denominator > 0),
  -- The no-rounding rule, as a database rule. Multiplication rather than division, so a rate that
  -- does not divide evenly cannot be stored at all.
  CONSTRAINT value_leg_rate_is_exact
    CHECK (amount_minor * rate_numerator = settlement_equivalent_minor * rate_denominator),

  -- An external leg's value comes from outside the platform, so it has no source wallet. An
  -- internal leg without one would be issuance pretending to be a transfer.
  CONSTRAINT value_leg_external_has_no_source
    CHECK ((kind = 'external') = (source_wallet_id IS NULL)),
  CONSTRAINT value_leg_not_self_transfer
    CHECK (source_wallet_id IS NULL OR source_wallet_id <> destination_wallet_id),

  -- A planned leg has moved nothing; anything past planned names the transaction that moved it.
  CONSTRAINT value_leg_transaction_matches_status
    CHECK ((status = 'planned') = (ledger_transaction_id IS NULL)),
  CONSTRAINT value_leg_reversal_matches_status
    CHECK ((status = 'reversed') = (reversal_transaction_id IS NOT NULL)),
  -- A reversal is a different transaction from what it reverses. The original is never deleted.
  CONSTRAINT value_leg_reversal_is_distinct
    CHECK (reversal_transaction_id IS NULL
           OR reversal_transaction_id <> ledger_transaction_id),

  CONSTRAINT value_leg_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT value_leg_updated_at_finite
    CHECK (updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_financial_ledger.value_leg IS
  'One source of value against an obligation, in its own asset type, with what it counted for against the settlement asset.';

COMMENT ON CONSTRAINT value_leg_rate_is_exact ON module_financial_ledger.value_leg IS
  'Checked by cross-multiplication, never division: a rate that does not divide evenly is refused rather than rounded.';

CREATE INDEX IF NOT EXISTS value_leg_plan_idx
  ON module_financial_ledger.value_leg (plan_id, created_at, leg_id);

CREATE INDEX IF NOT EXISTS value_leg_transaction_idx
  ON module_financial_ledger.value_leg (ledger_transaction_id)
  WHERE ledger_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS value_leg_external_reference_idx
  ON module_financial_ledger.value_leg (external_reference)
  WHERE external_reference IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The allocation invariant, enforced at commit
-- ---------------------------------------------------------------------------

-- The module's central rule spans rows, so no CHECK can express it: the legs of a plan must sum to
-- what is owed, exactly. A deferred constraint trigger fires at commit, which means a transaction
-- may insert the plan and its legs in any order and still be judged on the whole picture.
--
-- Leaving this to the service alone would mean the only thing standing between a short payment and
-- the ledger is code nobody re-reads. A plan that under-covers is a payment somebody is still owed;
-- one that over-covers is value taken for nothing.
CREATE OR REPLACE FUNCTION module_financial_ledger.assert_plan_adds_up()
RETURNS trigger
LANGUAGE plpgsql
AS $invariant$
DECLARE
  affected_plan text;
  target        bigint;
  allocated     bigint;
BEGIN
  affected_plan := COALESCE(NEW.plan_id, OLD.plan_id);

  SELECT target_amount_minor INTO target
    FROM module_financial_ledger.value_plan
   WHERE plan_id = affected_plan;

  -- The plan may have been deleted in this same transaction, in which case there is nothing to
  -- check. Nothing in this module deletes a plan, but a constraint that assumed otherwise would
  -- fail confusingly rather than saying so.
  IF target IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(sum(settlement_equivalent_minor), 0) INTO allocated
    FROM module_financial_ledger.value_leg
   WHERE plan_id = affected_plan;

  IF allocated <> target THEN
    RAISE EXCEPTION
      'value_plan % is owed % and its legs are worth %: an allocation must add up exactly',
      affected_plan, target, allocated
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'value_plan_legs_sum_to_target';
  END IF;

  RETURN NULL;
END;
$invariant$;

COMMENT ON FUNCTION module_financial_ledger.assert_plan_adds_up() IS
  'Refuses at commit any plan whose legs do not sum to its target. The invariant spans rows, so no CHECK can express it.';

CREATE CONSTRAINT TRIGGER value_leg_plan_adds_up
  AFTER INSERT OR UPDATE OR DELETE ON module_financial_ledger.value_leg
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION module_financial_ledger.assert_plan_adds_up();

-- ---------------------------------------------------------------------------
-- Outbox: the module's transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_financial_ledger.outbox (
  outbox_id         text        NOT NULL,
  idempotency_key   text        NOT NULL,
  kind              text        NOT NULL,
  payload           jsonb       NOT NULL,
  recorded_at       timestamptz NOT NULL,
  producer          text        NOT NULL,
  correlation_id    text        NOT NULL,
  processed_at      timestamptz NULL,
  retry_count       integer     NOT NULL DEFAULT 0,
  last_error        text        NULL,

  CONSTRAINT outbox_pkey PRIMARY KEY (outbox_id),
  CONSTRAINT outbox_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT outbox_kind_known CHECK (kind IN ('event', 'audit')),
  CONSTRAINT outbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_retry_non_negative CHECK (retry_count >= 0)
);

COMMENT ON TABLE module_financial_ledger.outbox IS
  'Transactional outbox for wallet, plan and leg events and audit records, dispatched by a relay.';

CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON module_financial_ledger.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION module_financial_ledger.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'Financial ledger records are append-only: % on % is refused',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION module_financial_ledger.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against an append-only table in this schema.';

CREATE TRIGGER wallet_state_is_append_only
  BEFORE UPDATE OR DELETE ON module_financial_ledger.wallet_state
  FOR EACH ROW EXECUTE FUNCTION module_financial_ledger.refuse_mutation();

COMMIT;
