-- migration: 0052_create_module_rfq_schema
-- direction: up
-- owner: module_rfq
--
-- M-09 RFQ: asking the market, once every other way has been tried.
--
-- **The most important thing about this schema is what is not in it.** There is no column for the
-- customer's words, and no free-text column wide enough to hide them in. A Need is a sentence
-- somebody wrote — deliberately exempt from the identifier rules, possibly holding a telephone
-- number, an address or a hint about what they will pay — and a tender goes to strangers. What a
-- supplier receives is a specification: the structured facts they need in order to quote.
--
-- `item_description` is capped at 500 characters for exactly that reason. A field long enough to
-- hold a customer message is a field that will eventually hold one, pasted there by somebody who
-- thought it easier than filling in the attributes.
--
-- **An award names exactly one winner.** A CHECK ties `status = awarded` to `awarded_quote_id`
-- being present, in both directions: an awarded tender with no winner cannot say who was chosen,
-- and a winner on an unawarded tender claims a decision nobody made.
--
-- **One invitation per supplier per tender.** `UNIQUE (rfq_id, supplier_account_id)` — inviting
-- somebody twice is not a second invitation, it is a duplicate email, and a platform that sends
-- those is one people filter out.
--
-- `rfq_invitation.reason` has a minimum length, because a supplier receiving an irrelevant tender is
-- entitled to know why they were asked, and "matched" is not an answer.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_rfq;

COMMENT ON SCHEMA module_rfq IS
  'M-09 RFQ. Tenders opened when the sourcing ladder could not solve a Need, and the suppliers invited to quote.';

-- Character-for-character identical to every other schema's copy, and required to stay so by test.
CREATE OR REPLACE FUNCTION module_rfq.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION module_rfq.is_opaque_identifier(text) IS
  'M-09''s copy of the platform identifier rule. Byte-identical to every other schema''s, and checked by test.';

-- ---------------------------------------------------------------------------
-- The tender
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_rfq.rfq (
  rfq_id                text        NOT NULL,
  request_id            text        NOT NULL,
  account_id            text        NOT NULL,
  match_run_id          text        NULL,
  status                text        NOT NULL,
  visibility            text        NOT NULL,
  category              text        NOT NULL,
  item_description      text        NOT NULL,
  quantity              bigint      NOT NULL,
  unit                  text        NOT NULL,
  attributes            jsonb       NOT NULL,
  delivery_district     text        NULL,
  required_by           timestamptz NULL,
  condition             text        NULL,
  quality_requirements  jsonb       NOT NULL,
  substitution_policy   text        NOT NULL,
  attachment_references jsonb       NOT NULL,
  closes_at             timestamptz NOT NULL,
  opened_at             timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  closed_at             timestamptz NULL,
  awarded_quote_id      text        NULL,
  closure_reason        text        NULL,
  correlation_id        text        NOT NULL,
  idempotency_key       text        NOT NULL,

  CONSTRAINT rfq_pkey PRIMARY KEY (rfq_id),
  CONSTRAINT rfq_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT rfq_id_opaque CHECK (module_rfq.is_opaque_identifier(rfq_id)),
  CONSTRAINT rfq_request_id_opaque CHECK (module_rfq.is_opaque_identifier(request_id)),
  CONSTRAINT rfq_account_id_opaque CHECK (module_rfq.is_opaque_identifier(account_id)),
  CONSTRAINT rfq_match_run_opaque
    CHECK (match_run_id IS NULL OR module_rfq.is_opaque_identifier(match_run_id)),
  CONSTRAINT rfq_awarded_quote_opaque
    CHECK (awarded_quote_id IS NULL OR module_rfq.is_opaque_identifier(awarded_quote_id)),
  CONSTRAINT rfq_correlation_id_opaque CHECK (module_rfq.is_opaque_identifier(correlation_id)),
  CONSTRAINT rfq_idempotency_key_opaque CHECK (module_rfq.is_opaque_identifier(idempotency_key)),

  CONSTRAINT rfq_status_known CHECK (status IN ('open', 'closed', 'awarded', 'cancelled')),
  CONSTRAINT rfq_visibility_known CHECK (visibility IN ('private', 'network')),
  CONSTRAINT rfq_substitution_policy_known
    CHECK (substitution_policy IN ('none', 'equivalent-with-disclosure', 'open')),
  -- An award is exactly one chosen offer, in both directions.
  CONSTRAINT rfq_award_names_winner
    CHECK ((status = 'awarded') = (awarded_quote_id IS NOT NULL)),
  -- Short on purpose: a field long enough to hold a customer message will eventually hold one.
  CONSTRAINT rfq_item_description_bounded
    CHECK (length(btrim(item_description)) > 0 AND length(item_description) <= 500),
  CONSTRAINT rfq_quantity_positive CHECK (quantity > 0),
  CONSTRAINT rfq_attributes_object CHECK (jsonb_typeof(attributes) = 'object'),
  CONSTRAINT rfq_quality_requirements_array CHECK (jsonb_typeof(quality_requirements) = 'array'),
  CONSTRAINT rfq_attachments_array CHECK (jsonb_typeof(attachment_references) = 'array'),
  -- A window nobody could quote in is worse than no tender: suppliers see it and learn the platform
  -- wastes their time.
  CONSTRAINT rfq_closes_after_opening CHECK (closes_at > opened_at),
  CONSTRAINT rfq_opened_at_finite
    CHECK (opened_at > '-infinity'::timestamptz AND opened_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_rfq.rfq IS
  'One tender. Holds a supplier-facing specification and never the words a customer wrote: those stay in M-03, where the person who wrote them can see who has read them.';

COMMENT ON COLUMN module_rfq.rfq.item_description IS
  'A short, supplier-facing description written for a supplier. Capped at 500 characters because a field long enough to hold a customer message is one that will eventually hold one.';

CREATE INDEX IF NOT EXISTS rfq_account_idx ON module_rfq.rfq (account_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS rfq_request_idx ON module_rfq.rfq (request_id, opened_at);
CREATE INDEX IF NOT EXISTS rfq_open_idx
  ON module_rfq.rfq (category, closes_at)
  WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Who was asked, and why
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_rfq.rfq_invitation (
  invitation_id       text        NOT NULL,
  rfq_id              text        NOT NULL,
  supplier_account_id text        NOT NULL,
  source_rung         text        NULL,
  reason              text        NOT NULL,
  score_per_mille     integer     NULL,
  invited_at          timestamptz NOT NULL,
  correlation_id      text        NOT NULL,
  idempotency_key     text        NOT NULL,

  CONSTRAINT rfq_invitation_pkey PRIMARY KEY (invitation_id),
  -- Inviting somebody twice is not a second invitation, it is a duplicate email.
  CONSTRAINT rfq_invitation_once_per_supplier UNIQUE (rfq_id, supplier_account_id),

  CONSTRAINT rfq_invitation_id_opaque CHECK (module_rfq.is_opaque_identifier(invitation_id)),
  CONSTRAINT rfq_invitation_rfq_id_opaque CHECK (module_rfq.is_opaque_identifier(rfq_id)),
  CONSTRAINT rfq_invitation_supplier_opaque
    CHECK (module_rfq.is_opaque_identifier(supplier_account_id)),
  CONSTRAINT rfq_invitation_correlation_opaque
    CHECK (module_rfq.is_opaque_identifier(correlation_id)),
  CONSTRAINT rfq_invitation_idempotency_opaque
    CHECK (module_rfq.is_opaque_identifier(idempotency_key)),

  CONSTRAINT rfq_invitation_rung_known
    CHECK (source_rung IS NULL
           OR source_rung IN ('catalogue', 'known', 'verified', 'external', 'rfq')),
  CONSTRAINT rfq_invitation_score_in_range
    CHECK (score_per_mille IS NULL OR score_per_mille BETWEEN 0 AND 1000),
  -- A supplier receiving an irrelevant tender is entitled to know why they were asked, and
  -- "matched" is not an answer.
  CONSTRAINT rfq_invitation_reason_present
    CHECK (length(btrim(reason)) >= 12 AND length(reason) <= 1000),
  CONSTRAINT rfq_invitation_invited_at_finite
    CHECK (invited_at > '-infinity'::timestamptz AND invited_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_rfq.rfq_invitation IS
  'One supplier asked to quote, and why. Append-only: they have already seen it, and pretending otherwise would make the record disagree with what happened.';

CREATE INDEX IF NOT EXISTS rfq_invitation_rfq_idx
  ON module_rfq.rfq_invitation (rfq_id, score_per_mille DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS rfq_invitation_supplier_idx
  ON module_rfq.rfq_invitation (supplier_account_id, invited_at DESC);

-- ---------------------------------------------------------------------------
-- How it got where it is
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_rfq.rfq_event (
  event_id        text        NOT NULL,
  rfq_id          text        NOT NULL,
  from_status     text        NULL,
  to_status       text        NOT NULL,
  reason          text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  correlation_id  text        NOT NULL,
  idempotency_key text        NOT NULL,

  CONSTRAINT rfq_event_pkey PRIMARY KEY (event_id),
  CONSTRAINT rfq_event_id_opaque CHECK (module_rfq.is_opaque_identifier(event_id)),
  CONSTRAINT rfq_event_rfq_id_opaque CHECK (module_rfq.is_opaque_identifier(rfq_id)),
  CONSTRAINT rfq_event_correlation_opaque CHECK (module_rfq.is_opaque_identifier(correlation_id)),
  CONSTRAINT rfq_event_idempotency_opaque CHECK (module_rfq.is_opaque_identifier(idempotency_key)),
  CONSTRAINT rfq_event_from_known
    CHECK (from_status IS NULL OR from_status IN ('open', 'closed', 'awarded', 'cancelled')),
  CONSTRAINT rfq_event_to_known CHECK (to_status IN ('open', 'closed', 'awarded', 'cancelled')),
  CONSTRAINT rfq_event_reason_present
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 1000),
  CONSTRAINT rfq_event_occurred_at_finite
    CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_rfq.rfq_event IS
  'One row per status change. Append-only: suppliers have been told what happened, and rewriting it would make that a lie.';

CREATE INDEX IF NOT EXISTS rfq_event_rfq_idx ON module_rfq.rfq_event (rfq_id, occurred_at);

-- ---------------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_rfq.outbox (
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

COMMENT ON TABLE module_rfq.outbox IS
  'M-09''s transactional outbox. No specification travels in an event: a private tender whose contents are in a shared log is not private.';

CREATE INDEX IF NOT EXISTS outbox_claimable_idx
  ON module_rfq.outbox (next_attempt_at NULLS FIRST, recorded_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

-- ---------------------------------------------------------------------------
-- What may never change
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION module_rfq.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  RAISE EXCEPTION
    'table %.% is append-only: suppliers have already been told what it says, and rewriting it would make that a lie',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$body$;

CREATE TRIGGER rfq_invitation_is_append_only
  BEFORE UPDATE OR DELETE ON module_rfq.rfq_invitation
  FOR EACH ROW EXECUTE FUNCTION module_rfq.refuse_mutation();

CREATE TRIGGER rfq_event_is_append_only
  BEFORE UPDATE OR DELETE ON module_rfq.rfq_event
  FOR EACH ROW EXECUTE FUNCTION module_rfq.refuse_mutation();

COMMIT;
