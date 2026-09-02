-- migration: 0053_create_module_quotes_schema
-- direction: up
-- owner: module_quotes
--
-- M-10 Quotes: what the market offered back.
--
-- **The terms of an offer are immutable, and the database is where that is actually true.** A
-- trigger refuses any UPDATE that changes the price, the quantity, the lead time, the delivery
-- terms or the validity. A supplier who wants a different price withdraws and submits a new offer,
-- which leaves both on the record. Enforced here rather than only in the service because a market
-- where the offer you accepted is not the offer you saw is not a market, and a rule that lives only
-- in one code path is a rule that a second code path will not have.
--
-- **A substitute must declare what differs, and nothing else may.** A CHECK ties
-- `kind = 'substitute'` to `substitution_note` in both directions: an undeclared substitution is how
-- a buyer discovers on delivery day that they did not get what they ordered, and a note on a `full`
-- offer says something differs when the offer claims nothing does.
--
-- **No score, rank or recommendation is stored.** A ranking depends on the weights in force and on
-- what else was offered, and both change. A stale score presented as current is worse than none, so
-- the comparison is computed when it is asked for.
--
-- `total_minor` is carried separately from `unit_price_minor * quantity` because the difference —
-- delivery, duties, handling — is exactly where a cheap offer becomes an expensive one, and a
-- comparison that ignored it would rank on the wrong number.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_quotes;

COMMENT ON SCHEMA module_quotes IS
  'M-10 Quotes. Supplier offers against a tender, immutable in their commercial terms once submitted.';

-- Character-for-character identical to every other schema's copy, and required to stay so by test.
CREATE OR REPLACE FUNCTION module_quotes.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION module_quotes.is_opaque_identifier(text) IS
  'M-10''s copy of the platform identifier rule. Byte-identical to every other schema''s, and checked by test.';

-- ---------------------------------------------------------------------------
-- The offer
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_quotes.quote (
  quote_id            text        NOT NULL,
  rfq_id              text        NOT NULL,
  supplier_account_id text        NOT NULL,
  kind                text        NOT NULL,
  status              text        NOT NULL,
  quantity            bigint      NOT NULL,
  unit_price_minor    bigint      NOT NULL,
  total_minor         bigint      NOT NULL,
  currency            text        NOT NULL,
  lead_time_days      integer     NOT NULL,
  delivery_terms      text        NOT NULL,
  valid_until         timestamptz NOT NULL,
  substitution_note   text        NULL,
  evidence_references jsonb       NOT NULL,
  submitted_at        timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  closed_at           timestamptz NULL,
  closure_reason      text        NULL,
  correlation_id      text        NOT NULL,
  idempotency_key     text        NOT NULL,

  CONSTRAINT quote_pkey PRIMARY KEY (quote_id),
  CONSTRAINT quote_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT quote_id_opaque CHECK (module_quotes.is_opaque_identifier(quote_id)),
  CONSTRAINT quote_rfq_id_opaque CHECK (module_quotes.is_opaque_identifier(rfq_id)),
  CONSTRAINT quote_supplier_opaque CHECK (module_quotes.is_opaque_identifier(supplier_account_id)),
  CONSTRAINT quote_correlation_opaque CHECK (module_quotes.is_opaque_identifier(correlation_id)),
  CONSTRAINT quote_idempotency_opaque CHECK (module_quotes.is_opaque_identifier(idempotency_key)),

  CONSTRAINT quote_kind_known CHECK (kind IN ('full', 'partial', 'substitute')),
  CONSTRAINT quote_status_known
    CHECK (status IN ('submitted', 'withdrawn', 'expired', 'accepted', 'rejected')),

  -- An offer for nothing is not an offer, and a negative price is not a discount.
  CONSTRAINT quote_quantity_positive CHECK (quantity > 0),
  CONSTRAINT quote_unit_price_non_negative CHECK (unit_price_minor >= 0),
  CONSTRAINT quote_total_non_negative CHECK (total_minor >= 0),
  CONSTRAINT quote_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT quote_lead_time_non_negative CHECK (lead_time_days >= 0),
  CONSTRAINT quote_delivery_terms_present
    CHECK (length(btrim(delivery_terms)) > 0 AND length(delivery_terms) <= 200),

  -- A substitute says what differs; nothing else may claim a difference it does not have.
  CONSTRAINT quote_substitution_declared
    CHECK ((kind = 'substitute') = (substitution_note IS NOT NULL)),
  CONSTRAINT quote_substitution_note_meaningful
    CHECK (substitution_note IS NULL
           OR (length(btrim(substitution_note)) >= 8 AND length(substitution_note) <= 1000)),

  CONSTRAINT quote_evidence_array CHECK (jsonb_typeof(evidence_references) = 'array'),

  -- An offer that expires as it arrives cannot be accepted, so it is not an offer.
  CONSTRAINT quote_valid_after_submission CHECK (valid_until > submitted_at),
  -- A closed offer says when it closed and an open one does not pretend to have.
  CONSTRAINT quote_closure_agrees
    CHECK ((status = 'submitted') = (closed_at IS NULL)
           AND (closed_at IS NULL) = (closure_reason IS NULL)),
  CONSTRAINT quote_closure_reason_present
    CHECK (closure_reason IS NULL
           OR (length(btrim(closure_reason)) > 0 AND length(closure_reason) <= 1000)),
  CONSTRAINT quote_submitted_at_finite
    CHECK (submitted_at > '-infinity'::timestamptz AND submitted_at < 'infinity'::timestamptz),
  CONSTRAINT quote_updated_not_before_submitted CHECK (updated_at >= submitted_at)
);

COMMENT ON TABLE module_quotes.quote IS
  'One supplier''s offer against one tender. The commercial terms cannot be changed after submission: a supplier who wants a different price withdraws and offers again, and both stay on the record.';

COMMENT ON COLUMN module_quotes.quote.total_minor IS
  'What the buyer pays all in. Carried separately from unit_price_minor * quantity because the difference is where a cheap offer becomes an expensive one.';

COMMENT ON COLUMN module_quotes.quote.substitution_note IS
  'What differs from the specification. Required for a substitute and refused for the other kinds, because an undeclared substitution is discovered on delivery day.';

-- What a buyer opens: every offer against one tender, best-priced first among the live ones.
CREATE INDEX IF NOT EXISTS quote_rfq_idx ON module_quotes.quote (rfq_id, total_minor);
-- What a supplier opens: their own offers, most recent first.
CREATE INDEX IF NOT EXISTS quote_supplier_idx
  ON module_quotes.quote (supplier_account_id, submitted_at DESC);
-- What an expiry sweep claims.
CREATE INDEX IF NOT EXISTS quote_expiry_idx
  ON module_quotes.quote (valid_until)
  WHERE status = 'submitted';

-- ---------------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_quotes.outbox (
  outbox_id          text        NOT NULL,
  idempotency_key    text        NOT NULL,
  kind               text        NOT NULL,
  payload            jsonb       NOT NULL,
  recorded_at        timestamptz NOT NULL,
  producer           text        NOT NULL,
  correlation_id     text        NOT NULL,
  causation_id       text        NULL,
  processed_at       timestamptz NULL,
  retry_count        integer     NOT NULL DEFAULT 0,
  last_error         text        NULL,
  next_attempt_at    timestamptz NULL,
  dead_lettered_at   timestamptz NULL,
  dead_letter_reason text        NULL,

  CONSTRAINT outbox_pkey PRIMARY KEY (outbox_id),
  CONSTRAINT outbox_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT outbox_kind_known CHECK (kind IN ('event', 'audit')),
  CONSTRAINT outbox_retry_count_non_negative CHECK (retry_count >= 0),
  CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_dead_letter_agrees
    CHECK ((dead_lettered_at IS NULL) = (dead_letter_reason IS NULL)),
  CONSTRAINT outbox_dead_letter_not_processed
    CHECK (dead_lettered_at IS NULL OR processed_at IS NULL)
);

COMMENT ON TABLE module_quotes.outbox IS
  'M-10''s transactional outbox. No price travels in an event: what a supplier quoted is the most commercially sensitive number they give this platform, and the event log is read by every subscriber.';

CREATE INDEX IF NOT EXISTS outbox_claimable_idx
  ON module_quotes.outbox (next_attempt_at NULLS FIRST, recorded_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

-- ---------------------------------------------------------------------------
-- What may never change
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION module_quotes.refuse_term_change()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'quote % cannot be deleted: a buyer may have already read this offer, and a market that can erase offers is one where the offer you accepted is not the offer you saw',
      OLD.quote_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.quote_id            IS DISTINCT FROM OLD.quote_id
     OR NEW.rfq_id              IS DISTINCT FROM OLD.rfq_id
     OR NEW.supplier_account_id IS DISTINCT FROM OLD.supplier_account_id
     OR NEW.kind                IS DISTINCT FROM OLD.kind
     OR NEW.quantity            IS DISTINCT FROM OLD.quantity
     OR NEW.unit_price_minor    IS DISTINCT FROM OLD.unit_price_minor
     OR NEW.total_minor         IS DISTINCT FROM OLD.total_minor
     OR NEW.currency            IS DISTINCT FROM OLD.currency
     OR NEW.lead_time_days      IS DISTINCT FROM OLD.lead_time_days
     OR NEW.delivery_terms      IS DISTINCT FROM OLD.delivery_terms
     OR NEW.valid_until         IS DISTINCT FROM OLD.valid_until
     OR NEW.substitution_note   IS DISTINCT FROM OLD.substitution_note
     OR NEW.evidence_references IS DISTINCT FROM OLD.evidence_references
     OR NEW.submitted_at        IS DISTINCT FROM OLD.submitted_at
  THEN
    RAISE EXCEPTION
      'the terms of quote % cannot be changed after submission: withdraw it and offer again, so both stay on the record and the buyer can see that the price moved',
      OLD.quote_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- An ended offer has ended. Reopening one would let a supplier take back a rejection.
  IF OLD.status <> 'submitted' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION
      'quote % is already %, and an offer that has ended cannot be moved to %',
      OLD.quote_id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$body$;

COMMENT ON FUNCTION module_quotes.refuse_term_change() IS
  'An offer binds. Only the status and its closure may change after submission, and only away from submitted.';

CREATE TRIGGER quote_terms_are_immutable
  BEFORE UPDATE OR DELETE ON module_quotes.quote
  FOR EACH ROW EXECUTE FUNCTION module_quotes.refuse_term_change();

COMMIT;
