-- migration: 0030_create_module_payments_schema
-- direction: up
-- owner: module_payments
--
-- M-12 Payments' own namespace: the payment header, the append-only record of every provider call,
-- refunds, webhook receipts, and the module outbox.
--
-- Owned data:
--   * `payment`          — the administrative state of one payment against one external rail.
--   * `payment_attempt`  — one call to a provider, recorded whether it succeeded or not.
--     Append-only. This is the reconciliation trail.
--   * `refund`           — one return of captured value. Append-only.
--   * `webhook_receipt`  — one delivery from a provider, recorded before it is believed.
--     Append-only except for the one-way `processed_at` stamp.
--   * `outbox`           — the module's transactional outbox for K-08 events and K-09 audit records.
--
-- **No column in this schema holds an instrument.** There is no card number, no PAN, no CVV, no
-- expiry, no bank account, no IBAN and no cardholder name, and there never may be. A payment row
-- outlives the transaction it describes and is copied into every projection built from it, so a PAN
-- written here is disclosed for as long as the platform exists and no later deletion policy can
-- recall it. What is stored is `instrument_token`: the opaque handle the provider gave back, held
-- to the same opacity rule as every identifier — which is what refuses a "token" shaped like a card
-- number, an IBAN or an email.
--
-- `order_id` is an opaque M-11 identifier and deliberately **not** a foreign key: M-11 is the same
-- layer as M-12, so the two communicate by event and neither joins to the other's tables
-- (MODULE_MAP §10.4). The same applies to `payer_account_id` and `payee_account_id` (K-03). The cost
-- is stated rather than hidden: the database will not stop a payment referencing an order that does
-- not exist.
--
-- M-12 sits in the deterministic financial authority zone. Every amount here is an exact integer in
-- minor units. **No `double precision`, `real`, `float` or `money` column exists in this schema.**
--
-- `asset_code` is deliberately not constrained to a three-letter fiat code: a settlement may be LKR
-- today and BTC, USDC or a licensed provider's unit tomorrow, and a CHECK that assumed ISO-4217
-- would have to be dropped to allow it. It **is** constrained to exclude the value JAYA issues
-- itself. Rewards, cashback, merchant credit, promotional credit, delivery credit and community
-- credit are internal liabilities that no bank, card network or custodian has heard of; M-13
-- allocates those against the universal ledger, and a payment row claiming to settle one externally
-- would be a claim on money the platform never held.
--
-- `is_opaque_identifier` is M-12's own copy of the rule set used by every other unit, in M-12's
-- schema, for the same ownership reason: a CHECK calling another schema's function would make the
-- two units one object. The copies are required to be character-for-character identical by
-- `tests/migrations.test.ts`.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_payments;

COMMENT ON SCHEMA module_payments IS
  'M-12 Payments. Payment headers, provider attempts, refunds, webhook receipts and the module outbox. Holds tokens, never instruments.';

-- Character-for-character identical to the copies in every other schema that carries one, and
-- required to stay so by test.
CREATE OR REPLACE FUNCTION module_payments.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION module_payments.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- ---------------------------------------------------------------------------
-- Payment: the administrative state of one payment
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_payments.payment (
  payment_id          text        NOT NULL,
  order_id            text        NOT NULL,
  payer_account_id    text        NOT NULL,
  payee_account_id    text        NOT NULL,
  status              text        NOT NULL,
  provider            text        NOT NULL,
  rail                text        NOT NULL,
  instrument_token    text        NOT NULL,
  asset_code          text        NOT NULL,
  asset_scale         integer     NOT NULL,
  amount_minor        bigint      NOT NULL,
  captured_minor      bigint      NOT NULL,
  refunded_minor      bigint      NOT NULL,
  provider_reference  text        NULL,
  authorised_at       timestamptz NULL,
  captured_at         timestamptz NULL,
  failed_at           timestamptz NULL,
  cancelled_at        timestamptz NULL,
  failure_code        text        NULL,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  correlation_id      text        NOT NULL,
  idempotency_key     text        NOT NULL,

  CONSTRAINT payment_pkey PRIMARY KEY (payment_id),
  CONSTRAINT payment_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT payment_id_opaque
    CHECK (module_payments.is_opaque_identifier(payment_id)),
  CONSTRAINT payment_order_id_opaque
    CHECK (module_payments.is_opaque_identifier(order_id)),
  CONSTRAINT payment_payer_opaque
    CHECK (module_payments.is_opaque_identifier(payer_account_id)),
  CONSTRAINT payment_payee_opaque
    CHECK (module_payments.is_opaque_identifier(payee_account_id)),
  -- The check that keeps the instrument on the provider's side of the boundary. A card number is a
  -- long digit run, an IBAN has its own shape, an email carries an `@` — and the rule set refuses
  -- all three. A "token" with any of those shapes is not a token.
  CONSTRAINT payment_instrument_token_opaque
    CHECK (module_payments.is_opaque_identifier(instrument_token)),
  CONSTRAINT payment_correlation_opaque
    CHECK (module_payments.is_opaque_identifier(correlation_id)),
  CONSTRAINT payment_idempotency_opaque
    CHECK (module_payments.is_opaque_identifier(idempotency_key)),

  CONSTRAINT payment_status_known
    CHECK (status IN ('requires-authorisation', 'authorised', 'captured',
                      'partially-refunded', 'refunded', 'failed', 'cancelled')),
  CONSTRAINT payment_rail_known
    CHECK (rail IN ('card', 'bank-transfer', 'external-wallet', 'digital-asset',
                    'cash-on-delivery')),
  CONSTRAINT payment_provider_well_formed
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT payment_failure_code_known
    CHECK (failure_code IS NULL OR failure_code IN
      ('card-declined', 'insufficient-funds', 'expired-instrument', 'invalid-token',
       'risk-rejected', 'provider-timeout', 'provider-unavailable', 'provider-error')),

  -- Open to any settlement asset an external counterparty can actually settle. Not ISO-4217:
  -- assuming three letters here would make the column fiat-only for ever.
  CONSTRAINT payment_asset_code_well_formed
    CHECK (asset_code ~ '^[A-Z0-9]{3,12}$'),
  -- And closed to the value JAYA issues itself. No rail carries a reward or a merchant credit, and
  -- a row claiming one was settled externally is a claim on money the platform never held. Stated
  -- explicitly rather than left to the shape rule above, because the guardrail is the point.
  CONSTRAINT payment_asset_is_externally_settleable
    CHECK (asset_code NOT IN ('JAYA_REWARD', 'CASHBACK', 'MERCHANT_CREDIT', 'PROMO_CREDIT',
                              'DELIVERY_CREDIT', 'COMMUNITY_CREDIT')),
  CONSTRAINT payment_asset_scale_plausible
    CHECK (asset_scale >= 0 AND asset_scale <= 18),

  CONSTRAINT payment_amount_non_negative CHECK (amount_minor >= 0),
  CONSTRAINT payment_captured_non_negative CHECK (captured_minor >= 0),
  CONSTRAINT payment_refunded_non_negative CHECK (refunded_minor >= 0),
  -- The two invariants that keep a payment honest. Without them a refund can quietly exceed what
  -- was taken, and the difference is money the platform never held.
  CONSTRAINT payment_captured_within_authorised CHECK (captured_minor <= amount_minor),
  CONSTRAINT payment_refunded_within_captured CHECK (refunded_minor <= captured_minor),

  -- The status and its timestamps must agree. A row claiming to be cancelled with no instant of
  -- cancellation states two facts that disagree, with nobody to arbitrate.
  CONSTRAINT payment_authorised_at_present_once_authorised
    CHECK (status NOT IN ('authorised', 'captured', 'partially-refunded', 'refunded')
           OR authorised_at IS NOT NULL),
  CONSTRAINT payment_captured_at_present_once_captured
    CHECK (status NOT IN ('captured', 'partially-refunded', 'refunded')
           OR captured_at IS NOT NULL),
  CONSTRAINT payment_failed_at_matches_status
    CHECK ((status = 'failed') = (failed_at IS NOT NULL)),
  CONSTRAINT payment_failure_code_matches_status
    CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT payment_cancelled_at_matches_status
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  -- Nothing is captured before a capture, and something is captured after one.
  CONSTRAINT payment_nothing_captured_before_capture
    CHECK (status NOT IN ('requires-authorisation', 'authorised', 'cancelled')
           OR captured_minor = 0),
  CONSTRAINT payment_something_captured_once_captured
    CHECK (status NOT IN ('captured', 'partially-refunded', 'refunded') OR captured_minor > 0),
  -- A fully refunded payment has returned everything it took; a partially refunded one has not.
  CONSTRAINT payment_refunded_means_everything_back
    CHECK (status <> 'refunded' OR refunded_minor = captured_minor),
  CONSTRAINT payment_partially_refunded_means_some_back
    CHECK (status <> 'partially-refunded'
           OR (refunded_minor > 0 AND refunded_minor < captured_minor)),

  CONSTRAINT payment_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT payment_updated_at_finite
    CHECK (updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_payments.payment IS
  'One payment against one external settlement rail. Holds an opaque provider token, never an instrument.';

COMMENT ON COLUMN module_payments.payment.instrument_token IS
  'The opaque handle the provider gave back. Never a card number, IBAN, account number or any other instrument.';

COMMENT ON COLUMN module_payments.payment.asset_code IS
  'The settlement asset: LKR, USD, BTC, USDC or a provider unit. Never internally issued JAYA value, which M-13 allocates.';

CREATE INDEX IF NOT EXISTS payment_order_idx
  ON module_payments.payment (order_id, created_at, payment_id);

CREATE INDEX IF NOT EXISTS payment_payer_idx
  ON module_payments.payment (payer_account_id, created_at, payment_id);

CREATE INDEX IF NOT EXISTS payment_payee_idx
  ON module_payments.payment (payee_account_id, created_at, payment_id);

CREATE INDEX IF NOT EXISTS payment_status_idx
  ON module_payments.payment (status);

-- ---------------------------------------------------------------------------
-- Payment attempt: one call to a provider, successful or not
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_payments.payment_attempt (
  attempt_id          text        NOT NULL,
  payment_id          text        NOT NULL,
  kind                text        NOT NULL,
  outcome             text        NOT NULL,
  amount_minor        bigint      NOT NULL,
  provider_reference  text        NULL,
  failure_code        text        NULL,
  attempted_at        timestamptz NOT NULL,
  correlation_id      text        NOT NULL,
  idempotency_key     text        NOT NULL,

  CONSTRAINT payment_attempt_pkey PRIMARY KEY (attempt_id),
  CONSTRAINT payment_attempt_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT payment_attempt_id_opaque
    CHECK (module_payments.is_opaque_identifier(attempt_id)),
  CONSTRAINT payment_attempt_payment_id_opaque
    CHECK (module_payments.is_opaque_identifier(payment_id)),
  CONSTRAINT payment_attempt_correlation_opaque
    CHECK (module_payments.is_opaque_identifier(correlation_id)),
  CONSTRAINT payment_attempt_idempotency_opaque
    CHECK (module_payments.is_opaque_identifier(idempotency_key)),

  CONSTRAINT payment_attempt_kind_known
    CHECK (kind IN ('authorise', 'capture', 'cancel', 'refund')),
  CONSTRAINT payment_attempt_outcome_known
    CHECK (outcome IN ('succeeded', 'failed')),
  CONSTRAINT payment_attempt_failure_code_known
    CHECK (failure_code IS NULL OR failure_code IN
      ('card-declined', 'insufficient-funds', 'expired-instrument', 'invalid-token',
       'risk-rejected', 'provider-timeout', 'provider-unavailable', 'provider-error')),
  -- A failed attempt says why, and a successful one does not claim to have failed. Either half of
  -- this being wrong makes the reconciliation trail unreadable.
  CONSTRAINT payment_attempt_failure_matches_outcome
    CHECK ((outcome = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT payment_attempt_amount_non_negative CHECK (amount_minor >= 0),
  CONSTRAINT payment_attempt_attempted_at_finite
    CHECK (attempted_at > '-infinity'::timestamptz AND attempted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_payments.payment_attempt IS
  'One call to a provider, recorded whether it succeeded or not. Append-only: a failed attempt is as important to keep as a successful one.';

CREATE INDEX IF NOT EXISTS payment_attempt_payment_idx
  ON module_payments.payment_attempt (payment_id, attempted_at, attempt_id);

CREATE INDEX IF NOT EXISTS payment_attempt_reference_idx
  ON module_payments.payment_attempt (provider_reference)
  WHERE provider_reference IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Refund: one return of captured value
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_payments.refund (
  refund_id           text        NOT NULL,
  payment_id          text        NOT NULL,
  amount_minor        bigint      NOT NULL,
  reason              text        NOT NULL,
  provider_reference  text        NULL,
  refunded_at         timestamptz NOT NULL,
  correlation_id      text        NOT NULL,
  idempotency_key     text        NOT NULL,

  CONSTRAINT refund_pkey PRIMARY KEY (refund_id),
  CONSTRAINT refund_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT refund_id_opaque
    CHECK (module_payments.is_opaque_identifier(refund_id)),
  CONSTRAINT refund_payment_id_opaque
    CHECK (module_payments.is_opaque_identifier(payment_id)),
  CONSTRAINT refund_correlation_opaque
    CHECK (module_payments.is_opaque_identifier(correlation_id)),
  CONSTRAINT refund_idempotency_opaque
    CHECK (module_payments.is_opaque_identifier(idempotency_key)),

  -- A refund of zero is not a refund.
  CONSTRAINT refund_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT refund_reason_present
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  CONSTRAINT refund_refunded_at_finite
    CHECK (refunded_at > '-infinity'::timestamptz AND refunded_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_payments.refund IS
  'One return of captured value, partial or full. Append-only.';

CREATE INDEX IF NOT EXISTS refund_payment_idx
  ON module_payments.refund (payment_id, refunded_at, refund_id);

-- ---------------------------------------------------------------------------
-- Webhook receipt: one delivery from a provider, recorded before it is believed
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_payments.webhook_receipt (
  receipt_id          text        NOT NULL,
  provider            text        NOT NULL,
  provider_event_id   text        NOT NULL,
  payment_id          text        NULL,
  kind                text        NOT NULL,
  signature_verified  boolean     NOT NULL,
  payload             jsonb       NOT NULL,
  received_at         timestamptz NOT NULL,
  processed_at        timestamptz NULL,
  correlation_id      text        NOT NULL,
  idempotency_key     text        NOT NULL,

  CONSTRAINT webhook_receipt_pkey PRIMARY KEY (receipt_id),
  CONSTRAINT webhook_receipt_idempotency_unique UNIQUE (idempotency_key),
  -- The constraint that makes a redelivered webhook harmless. Every provider eventually delivers
  -- the same event twice; without this the second delivery would move money a second time.
  CONSTRAINT webhook_receipt_provider_event_unique UNIQUE (provider, provider_event_id),

  CONSTRAINT webhook_receipt_id_opaque
    CHECK (module_payments.is_opaque_identifier(receipt_id)),
  CONSTRAINT webhook_receipt_payment_id_opaque
    CHECK (payment_id IS NULL OR module_payments.is_opaque_identifier(payment_id)),
  CONSTRAINT webhook_receipt_correlation_opaque
    CHECK (module_payments.is_opaque_identifier(correlation_id)),
  CONSTRAINT webhook_receipt_idempotency_opaque
    CHECK (module_payments.is_opaque_identifier(idempotency_key)),

  CONSTRAINT webhook_receipt_provider_well_formed
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
  -- Not held to the opacity rule: this is the provider's own id and its shape is the provider's
  -- business. Bounded and non-empty so it can be half of a unique key, and nothing more is claimed.
  CONSTRAINT webhook_receipt_provider_event_present
    CHECK (length(btrim(provider_event_id)) > 0 AND length(provider_event_id) <= 200),
  CONSTRAINT webhook_receipt_kind_present
    CHECK (length(btrim(kind)) > 0 AND length(kind) <= 100),
  CONSTRAINT webhook_receipt_payload_is_object
    CHECK (jsonb_typeof(payload) = 'object'),
  -- M-12 refuses to act on an unverified delivery, so an unverified one is never stored either. A
  -- webhook is an instruction from outside the platform to move money.
  CONSTRAINT webhook_receipt_signature_verified
    CHECK (signature_verified),
  CONSTRAINT webhook_receipt_received_at_finite
    CHECK (received_at > '-infinity'::timestamptz AND received_at < 'infinity'::timestamptz),
  CONSTRAINT webhook_receipt_processed_after_received
    CHECK (processed_at IS NULL OR processed_at >= received_at)
);

COMMENT ON TABLE module_payments.webhook_receipt IS
  'One provider delivery, recorded before it is believed. UNIQUE (provider, provider_event_id) makes a redelivery take effect once.';

CREATE INDEX IF NOT EXISTS webhook_receipt_payment_idx
  ON module_payments.webhook_receipt (payment_id, received_at, receipt_id)
  WHERE payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS webhook_receipt_unprocessed_idx
  ON module_payments.webhook_receipt (received_at, receipt_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Outbox: the module's transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_payments.outbox (
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

COMMENT ON TABLE module_payments.outbox IS
  'Transactional outbox for payment events and audit records, dispatched by a relay.';

CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON module_payments.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION module_payments.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'Payment records are append-only: % on % is refused',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION module_payments.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against an append-only table in this schema.';

CREATE TRIGGER payment_attempt_is_append_only
  BEFORE UPDATE OR DELETE ON module_payments.payment_attempt
  FOR EACH ROW EXECUTE FUNCTION module_payments.refuse_mutation();

CREATE TRIGGER refund_is_append_only
  BEFORE UPDATE OR DELETE ON module_payments.refund
  FOR EACH ROW EXECUTE FUNCTION module_payments.refuse_mutation();

-- A receipt is append-only with one exception: the moment M-12 acted on it. That stamp is one-way,
-- because re-stamping it would erase when the platform actually responded to the provider — which
-- is the fact a dispute turns on. Everything else about a delivery is what the provider sent, and
-- editing that would be rewriting the evidence.
CREATE OR REPLACE FUNCTION module_payments.refuse_receipt_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Webhook receipts are append-only: DELETE is refused'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.processed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Webhook receipt % was already processed at %; the stamp is one-way',
      OLD.receipt_id, OLD.processed_at
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF ROW(NEW.receipt_id, NEW.provider, NEW.provider_event_id, NEW.payment_id, NEW.kind,
         NEW.signature_verified, NEW.payload, NEW.received_at, NEW.correlation_id,
         NEW.idempotency_key)
     IS DISTINCT FROM
     ROW(OLD.receipt_id, OLD.provider, OLD.provider_event_id, OLD.payment_id, OLD.kind,
         OLD.signature_verified, OLD.payload, OLD.received_at, OLD.correlation_id,
         OLD.idempotency_key)
  THEN
    RAISE EXCEPTION
      'Webhook receipt % may only be stamped processed; the delivery itself is what the provider sent',
      OLD.receipt_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION module_payments.refuse_receipt_rewrite() IS
  'Permits stamping processed_at once; refuses every other change to a webhook receipt, and every delete.';

CREATE TRIGGER webhook_receipt_stamp_only
  BEFORE UPDATE OR DELETE ON module_payments.webhook_receipt
  FOR EACH ROW EXECUTE FUNCTION module_payments.refuse_receipt_rewrite();

COMMIT;
