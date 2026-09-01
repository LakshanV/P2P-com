-- migration: 0049_create_module_commerce_request_schema
-- direction: up
-- owner: module_commerce_request
--
-- M-03 Commerce Request: the Need, and every reading of it.
--
-- The front door of the platform. Everything downstream — search, matching, the sourcing ladder,
-- RFQ, an order — begins with somebody saying what they want.
--
-- **The most important thing in this schema is that `request.raw_text` is never updated.** A trigger
-- refuses any UPDATE that would change it. What somebody asked for is evidence, and a dispute six
-- months from now is judged against what they actually said rather than against what the platform
-- decided it meant. An interpretation is a **separate append-only row** pointing at the request, so
-- correcting a wrong reading adds one rather than editing the words.
--
-- **`raw_text` is deliberately not subject to `is_opaque_identifier`, and that is a considered
-- decision with a cost.** The opacity rule exists to stop a person's telephone number becoming a
-- primary key. This column is a sentence somebody wrote — "call me on 0771234567 about the cement"
-- is a Need, not a leak, and refusing it would make the platform unable to accept the thing it
-- exists to accept. The consequence is that this column may contain personal data, and three things
-- follow from that and are enforced elsewhere:
--
--   * M-03 publishes the **length** of the text in its events, never the text. An event is fanned
--     out to every subscriber and kept indefinitely.
--   * Every audit evidence field M-03 declares is `internal` rather than `personal`, which is only
--     honest because the words are not among them.
--   * A deletion request (§AB-09) must reach this column. It is the one place in the platform where
--     free personal text is stored on purpose.
--
-- **Confidence is an integer per-mille, not a float.** There is no floating-point column anywhere in
-- this repository: a confidence stored as a double compares unequal to itself across a round trip,
-- and a sourcing threshold built on one drifts without anybody editing it. 0..1000 is finer than
-- anybody can justify and exact.
--
-- `account_id` and `conversation_id` carry no foreign key into `kernel_accounts` or
-- `kernel_conversation_foundation`, for the reason set out in migration 0007: a cross-schema key
-- makes two components one object that cannot be migrated or rolled back independently.
--
-- `is_opaque_identifier` is M-03's own copy of the rule set the other schemas carry, in M-03's
-- schema, for that same ownership reason. All bodies are required to be character-for-character
-- identical by `tests/migrations.test.ts`.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_commerce_request;

COMMENT ON SCHEMA module_commerce_request IS
  'M-03 Commerce Request. The Need as it was said, and every separate reading of what it meant.';

-- Character-for-character identical to the other schemas' copies, and required to stay so by test.
CREATE OR REPLACE FUNCTION module_commerce_request.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION module_commerce_request.is_opaque_identifier(text) IS
  'M-03''s copy of the platform identifier rule. Byte-identical to every other schema''s, and checked by test. Deliberately NOT applied to request.raw_text, which is what a person wrote.';

-- ---------------------------------------------------------------------------
-- The Need, as it was said
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_commerce_request.request (
  request_id                text        NOT NULL,
  account_id                text        NOT NULL,
  channel                   text        NOT NULL,
  -- Never updated. See the trigger below, and the note at the head of this file.
  raw_text                  text        NOT NULL,
  conversation_id           text        NULL,
  status                    text        NOT NULL,
  current_interpretation_id text        NULL,
  captured_at               timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  needed_by                 timestamptz NULL,
  closed_at                 timestamptz NULL,
  closure_reason            text        NULL,
  correlation_id            text        NOT NULL,
  idempotency_key           text        NOT NULL,

  CONSTRAINT request_pkey PRIMARY KEY (request_id),
  CONSTRAINT request_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT request_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(request_id)),
  CONSTRAINT request_account_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(account_id)),
  CONSTRAINT request_conversation_id_opaque
    CHECK (conversation_id IS NULL
           OR module_commerce_request.is_opaque_identifier(conversation_id)),
  CONSTRAINT request_current_interpretation_opaque
    CHECK (current_interpretation_id IS NULL
           OR module_commerce_request.is_opaque_identifier(current_interpretation_id)),
  CONSTRAINT request_correlation_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(correlation_id)),
  CONSTRAINT request_idempotency_key_opaque
    CHECK (module_commerce_request.is_opaque_identifier(idempotency_key)),

  CONSTRAINT request_channel_known
    CHECK (channel IN ('text', 'voice', 'image', 'document', 'barcode', 'link', 'conversation')),
  CONSTRAINT request_status_known
    CHECK (status IN ('captured', 'interpreted', 'ready', 'sourcing', 'fulfilled', 'cancelled',
                      'expired')),
  -- A Need with nothing in it is not a Need. The upper bound exists because an unbounded text
  -- column is a way to fill the database, not because anybody has needed more than 20,000.
  CONSTRAINT request_raw_text_present
    CHECK (length(btrim(raw_text)) > 0 AND length(raw_text) <= 20000),
  CONSTRAINT request_closure_reason_present
    CHECK (closure_reason IS NULL
           OR (length(btrim(closure_reason)) > 0 AND length(closure_reason) <= 500)),
  -- A terminal status and a closure are the same fact. One without the other is a row that cannot
  -- say when or why the Need ended.
  CONSTRAINT request_closure_agrees_with_status
    CHECK ((status IN ('fulfilled', 'cancelled', 'expired'))
           = (closed_at IS NOT NULL AND closure_reason IS NOT NULL)),
  CONSTRAINT request_captured_at_finite
    CHECK (captured_at > '-infinity'::timestamptz AND captured_at < 'infinity'::timestamptz),
  CONSTRAINT request_updated_after_captured
    CHECK (updated_at >= captured_at)
);

COMMENT ON TABLE module_commerce_request.request IS
  'What somebody asked for, in their words. raw_text is written once and never updated: it is the evidence a dispute is judged against.';

COMMENT ON COLUMN module_commerce_request.request.raw_text IS
  'Exactly what the person said, byte for byte. Deliberately outside is_opaque_identifier: this is a sentence, not a key. It may contain personal data, which is why M-03 publishes its length and never its content.';

CREATE INDEX IF NOT EXISTS request_account_idx
  ON module_commerce_request.request (account_id, captured_at DESC);

-- The sourcing ladder asks for Needs that are ready and not yet being worked. A partial index keeps
-- that answer the size of the live queue rather than the size of history.
CREATE INDEX IF NOT EXISTS request_live_idx
  ON module_commerce_request.request (status, captured_at)
  WHERE status IN ('captured', 'interpreted', 'ready', 'sourcing');

-- ---------------------------------------------------------------------------
-- What the platform made of it
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_commerce_request.request_interpretation (
  interpretation_id            text        NOT NULL,
  request_id                   text        NOT NULL,
  version                      integer     NOT NULL,
  origin                       text        NOT NULL,
  confidence_per_mille         integer     NOT NULL,
  structured                   jsonb       NOT NULL,
  ai_run_id                    text        NULL,
  rationale                    text        NOT NULL,
  supersedes_interpretation_id text        NULL,
  interpreted_at               timestamptz NOT NULL,
  correlation_id               text        NOT NULL,
  idempotency_key              text        NOT NULL,

  CONSTRAINT request_interpretation_pkey PRIMARY KEY (interpretation_id),
  CONSTRAINT request_interpretation_idempotency_unique UNIQUE (idempotency_key),
  -- Versions are how the history is ordered. Two readings claiming the same one would make the
  -- sequence unreadable, which is the only thing the sequence is for.
  CONSTRAINT request_interpretation_version_unique UNIQUE (request_id, version),

  CONSTRAINT request_interpretation_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(interpretation_id)),
  CONSTRAINT request_interpretation_request_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(request_id)),
  CONSTRAINT request_interpretation_ai_run_opaque
    CHECK (ai_run_id IS NULL OR module_commerce_request.is_opaque_identifier(ai_run_id)),
  CONSTRAINT request_interpretation_supersedes_opaque
    CHECK (supersedes_interpretation_id IS NULL
           OR module_commerce_request.is_opaque_identifier(supersedes_interpretation_id)),
  CONSTRAINT request_interpretation_correlation_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(correlation_id)),
  CONSTRAINT request_interpretation_idempotency_key_opaque
    CHECK (module_commerce_request.is_opaque_identifier(idempotency_key)),

  CONSTRAINT request_interpretation_version_positive CHECK (version >= 1),
  CONSTRAINT request_interpretation_origin_known
    CHECK (origin IN ('model', 'rule', 'human')),
  -- An integer per-mille, so a threshold built on it cannot drift. There is no floating-point
  -- column anywhere in this repository and this is not going to be the first.
  CONSTRAINT request_interpretation_confidence_in_range
    CHECK (confidence_per_mille BETWEEN 0 AND 1000),
  CONSTRAINT request_interpretation_structured_object
    CHECK (jsonb_typeof(structured) = 'object'),
  -- An interpretation without a reason is one nobody can argue with later, and the person who most
  -- needs to argue with it is whoever is looking at a wrong answer months from now.
  CONSTRAINT request_interpretation_rationale_present
    CHECK (length(btrim(rationale)) >= 8 AND length(rationale) <= 2000),
  -- A model reading must name the K-13 run behind it, or a wrong one cannot be traced to the model
  -- and prompt that produced it. A human or rule reading naming one would credit a model for work
  -- it did not do.
  CONSTRAINT request_interpretation_ai_run_matches_origin
    CHECK ((origin = 'model') = (ai_run_id IS NOT NULL)),
  CONSTRAINT request_interpretation_interpreted_at_finite
    CHECK (interpreted_at > '-infinity'::timestamptz
           AND interpreted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_commerce_request.request_interpretation IS
  'One reading of what a Need meant. Append-only: a better reading is a new row, so the sequence records how the understanding changed and who changed it.';

CREATE INDEX IF NOT EXISTS request_interpretation_request_idx
  ON module_commerce_request.request_interpretation (request_id, version DESC);

-- ---------------------------------------------------------------------------
-- Attachments, by reference only
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_commerce_request.request_media (
  media_id        text        NOT NULL,
  request_id      text        NOT NULL,
  kind            text        NOT NULL,
  -- An opaque handle to an artefact held elsewhere. Never a URL, never a filename, never the bytes.
  reference       text        NOT NULL,
  position        integer     NOT NULL,
  caption         text        NOT NULL,
  added_at        timestamptz NOT NULL,
  correlation_id  text        NOT NULL,
  idempotency_key text        NOT NULL,

  CONSTRAINT request_media_pkey PRIMARY KEY (media_id),
  CONSTRAINT request_media_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT request_media_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(media_id)),
  CONSTRAINT request_media_request_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(request_id)),
  -- The same rule M-02 applies to evidence and M-04 to listing media, for the same reason: a
  -- photograph's filename is a natural key and a URL is somebody else's address space.
  CONSTRAINT request_media_reference_opaque
    CHECK (module_commerce_request.is_opaque_identifier(reference)),
  CONSTRAINT request_media_correlation_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(correlation_id)),
  CONSTRAINT request_media_idempotency_key_opaque
    CHECK (module_commerce_request.is_opaque_identifier(idempotency_key)),

  CONSTRAINT request_media_kind_known
    CHECK (kind IN ('image', 'video', 'audio', 'document')),
  CONSTRAINT request_media_position_non_negative CHECK (position >= 0),
  CONSTRAINT request_media_caption_bounded CHECK (length(caption) <= 500),
  CONSTRAINT request_media_added_at_finite
    CHECK (added_at > '-infinity'::timestamptz AND added_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_commerce_request.request_media IS
  'Attachments to a Need, by opaque reference. M-03 never stores the artefact itself.';

CREATE INDEX IF NOT EXISTS request_media_request_idx
  ON module_commerce_request.request_media (request_id, position);

-- ---------------------------------------------------------------------------
-- How it got where it is
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_commerce_request.request_event (
  event_id        text        NOT NULL,
  request_id      text        NOT NULL,
  from_status     text        NULL,
  to_status       text        NOT NULL,
  reason          text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  correlation_id  text        NOT NULL,
  idempotency_key text        NOT NULL,

  CONSTRAINT request_event_pkey PRIMARY KEY (event_id),

  CONSTRAINT request_event_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(event_id)),
  CONSTRAINT request_event_request_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(request_id)),
  CONSTRAINT request_event_correlation_id_opaque
    CHECK (module_commerce_request.is_opaque_identifier(correlation_id)),
  CONSTRAINT request_event_idempotency_key_opaque
    CHECK (module_commerce_request.is_opaque_identifier(idempotency_key)),

  CONSTRAINT request_event_from_status_known
    CHECK (from_status IS NULL
           OR from_status IN ('captured', 'interpreted', 'ready', 'sourcing', 'fulfilled',
                              'cancelled', 'expired')),
  CONSTRAINT request_event_to_status_known
    CHECK (to_status IN ('captured', 'interpreted', 'ready', 'sourcing', 'fulfilled', 'cancelled',
                         'expired')),
  CONSTRAINT request_event_reason_present
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  CONSTRAINT request_event_occurred_at_finite
    CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_commerce_request.request_event IS
  'One row per status change. Append-only: how a Need reached its state is not editable.';

CREATE INDEX IF NOT EXISTS request_event_request_idx
  ON module_commerce_request.request_event (request_id, occurred_at);

-- ---------------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_commerce_request.outbox (
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
  -- A dead letter and its reason are the same fact.
  CONSTRAINT outbox_dead_letter_agrees
    CHECK ((dead_lettered_at IS NULL) = (dead_letter_reason IS NULL)),
  -- A dead-lettered row was never dispatched. Marking it processed would tell every reader the
  -- opposite of what happened.
  CONSTRAINT outbox_dead_letter_not_processed
    CHECK (dead_lettered_at IS NULL OR processed_at IS NULL)
);

COMMENT ON TABLE module_commerce_request.outbox IS
  'M-03''s transactional outbox. Written in the same transaction as the business change, so a fact and its publication cannot disagree.';

-- Only what is still to do, so the index stays the size of the backlog rather than of history.
CREATE INDEX IF NOT EXISTS outbox_claimable_idx
  ON module_commerce_request.outbox (next_attempt_at NULLS FIRST, recorded_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

-- ---------------------------------------------------------------------------
-- What may never change
-- ---------------------------------------------------------------------------

/*
 * The request row has a lifecycle, so it may be updated — but four of its columns may not.
 *
 * `raw_text` above all: it is the evidence of what was asked for, and a system that can edit its own
 * evidence has none. The other three are identity, and repointing a Need at a different account or
 * changing when it was captured would rewrite whose it is and when.
 */
CREATE OR REPLACE FUNCTION module_commerce_request.request_immutable_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  IF NEW.raw_text IS DISTINCT FROM OLD.raw_text THEN
    RAISE EXCEPTION
      'raw_text is what the customer actually said and is never edited. A correction is a new row '
      'in request_interpretation, so the original survives every reinterpretation'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.captured_at IS DISTINCT FROM OLD.captured_at THEN
    RAISE EXCEPTION
      'request_id, account_id and captured_at are the identity of a Need and are never changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$body$;

CREATE TRIGGER request_raw_text_is_write_once
  BEFORE UPDATE ON module_commerce_request.request
  FOR EACH ROW EXECUTE FUNCTION module_commerce_request.request_immutable_columns();

CREATE OR REPLACE FUNCTION module_commerce_request.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  RAISE EXCEPTION
    'table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$body$;

CREATE TRIGGER request_interpretation_is_append_only
  BEFORE UPDATE OR DELETE ON module_commerce_request.request_interpretation
  FOR EACH ROW EXECUTE FUNCTION module_commerce_request.refuse_mutation();

CREATE TRIGGER request_media_is_append_only
  BEFORE UPDATE OR DELETE ON module_commerce_request.request_media
  FOR EACH ROW EXECUTE FUNCTION module_commerce_request.refuse_mutation();

CREATE TRIGGER request_event_is_append_only
  BEFORE UPDATE OR DELETE ON module_commerce_request.request_event
  FOR EACH ROW EXECUTE FUNCTION module_commerce_request.refuse_mutation();

COMMIT;
