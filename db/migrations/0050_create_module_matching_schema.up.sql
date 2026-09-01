-- migration: 0050_create_module_matching_schema
-- direction: up
-- owner: module_matching
--
-- M-07 Matching: the sourcing ladder, and the record of what it tried.
--
-- The differentiated middle of the product. A customer says what they need; the platform tries to
-- solve it, cheapest rung first, and only asks the market when nothing else answered.
--
-- **Every rung's outcome is stored, including the ones that found nothing.** That is the point of
-- `rung_attempt`: "we checked the catalogue and there was none, and the two suppliers who stock it
-- are out until Thursday" is what a customer is owed when their Need becomes an RFQ. A schema that
-- recorded only the winning rung would make every escalation unexplained, and an unexplained
-- escalation is indistinguishable from laziness.
--
-- **Scores are integer per-mille, 0..1000.** No floating-point column exists anywhere in this
-- repository. A score stored as a double compares unequal to itself across a round trip, and a
-- sufficiency threshold built on one drifts without anybody editing it.
--
-- **All three tables are append-only.** Re-running the ladder creates a new run rather than
-- replacing the old one, because comparing two runs is how anybody answers "why did this find
-- nothing on Tuesday and something on Thursday". A run that could be edited would make that
-- comparison meaningless.
--
-- **Nothing here holds the Need's words or its structured reading.** M-03 owns both. A run names the
-- Need by id and the interpretation by id, so this schema can be read, exported or shown to an
-- operator without carrying a sentence a customer wrote.
--
-- `request_id`, `account_id`, `listing_id` and `version_id` carry no foreign keys out of this
-- schema, for the reason set out in migration 0007.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_matching;

COMMENT ON SCHEMA module_matching IS
  'M-07 Matching. The sourcing ladder, what each rung found, and why the ladder stopped where it did.';

-- Character-for-character identical to every other schema's copy, and required to stay so by test.
CREATE OR REPLACE FUNCTION module_matching.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION module_matching.is_opaque_identifier(text) IS
  'M-07''s copy of the platform identifier rule. Byte-identical to every other schema''s, and checked by test.';

-- ---------------------------------------------------------------------------
-- One climb of the ladder
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_matching.match_run (
  run_id                text        NOT NULL,
  request_id            text        NOT NULL,
  account_id            text        NOT NULL,
  interpretation_id     text        NULL,
  outcome               text        NOT NULL,
  satisfied_by          text        NULL,
  sufficiency_per_mille integer     NOT NULL,
  started_at            timestamptz NOT NULL,
  completed_at          timestamptz NOT NULL,
  correlation_id        text        NOT NULL,
  idempotency_key       text        NOT NULL,

  CONSTRAINT match_run_pkey PRIMARY KEY (run_id),
  CONSTRAINT match_run_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT match_run_id_opaque
    CHECK (module_matching.is_opaque_identifier(run_id)),
  CONSTRAINT match_run_request_id_opaque
    CHECK (module_matching.is_opaque_identifier(request_id)),
  CONSTRAINT match_run_account_id_opaque
    CHECK (module_matching.is_opaque_identifier(account_id)),
  CONSTRAINT match_run_interpretation_opaque
    CHECK (interpretation_id IS NULL OR module_matching.is_opaque_identifier(interpretation_id)),
  CONSTRAINT match_run_correlation_id_opaque
    CHECK (module_matching.is_opaque_identifier(correlation_id)),
  CONSTRAINT match_run_idempotency_key_opaque
    CHECK (module_matching.is_opaque_identifier(idempotency_key)),

  CONSTRAINT match_run_outcome_known
    CHECK (outcome IN ('matched', 'escalate-to-rfq', 'exhausted')),
  CONSTRAINT match_run_rung_known
    CHECK (satisfied_by IS NULL
           OR satisfied_by IN ('catalogue', 'known', 'verified', 'external', 'rfq')),
  -- A match is satisfied by exactly one rung and an escalation by none. Either without the other is
  -- a row that cannot say how the ladder finished, which is the only thing a run is for.
  CONSTRAINT match_run_outcome_agrees_with_rung
    CHECK ((outcome = 'matched') = (satisfied_by IS NOT NULL)),
  CONSTRAINT match_run_sufficiency_in_range
    CHECK (sufficiency_per_mille BETWEEN 0 AND 1000),
  CONSTRAINT match_run_completed_after_started
    CHECK (completed_at >= started_at),
  CONSTRAINT match_run_started_at_finite
    CHECK (started_at > '-infinity'::timestamptz AND started_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_matching.match_run IS
  'One climb of the sourcing ladder against one Need. Append-only: re-running creates a new run, and comparing two is how anybody explains a change in what the platform could find.';

CREATE INDEX IF NOT EXISTS match_run_request_idx
  ON module_matching.match_run (request_id, started_at);

-- The escalations are what M-09 acts on, and what an operator looks at when suppliers complain that
-- they are being asked about things the platform should have found on a shelf.
CREATE INDEX IF NOT EXISTS match_run_escalation_idx
  ON module_matching.match_run (completed_at)
  WHERE outcome = 'escalate-to-rfq';

-- ---------------------------------------------------------------------------
-- What each rung did
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_matching.rung_attempt (
  attempt_id           text        NOT NULL,
  run_id               text        NOT NULL,
  rung                 text        NOT NULL,
  position             integer     NOT NULL,
  outcome              text        NOT NULL,
  candidates_found     integer     NOT NULL,
  best_score_per_mille integer     NULL,
  reason               text        NOT NULL,
  attempted_at         timestamptz NOT NULL,
  correlation_id       text        NOT NULL,
  idempotency_key      text        NOT NULL,

  CONSTRAINT rung_attempt_pkey PRIMARY KEY (attempt_id),
  CONSTRAINT rung_attempt_run_rung_unique UNIQUE (run_id, rung),

  CONSTRAINT rung_attempt_id_opaque
    CHECK (module_matching.is_opaque_identifier(attempt_id)),
  CONSTRAINT rung_attempt_run_id_opaque
    CHECK (module_matching.is_opaque_identifier(run_id)),
  CONSTRAINT rung_attempt_correlation_id_opaque
    CHECK (module_matching.is_opaque_identifier(correlation_id)),
  CONSTRAINT rung_attempt_idempotency_key_opaque
    CHECK (module_matching.is_opaque_identifier(idempotency_key)),

  CONSTRAINT rung_attempt_rung_known
    CHECK (rung IN ('catalogue', 'known', 'verified', 'external', 'rfq')),
  CONSTRAINT rung_attempt_outcome_known
    CHECK (outcome IN ('satisfied', 'insufficient', 'empty', 'unavailable', 'skipped')),
  -- The position is the rung's place in the ladder, not a free number. The ladder order is the
  -- product decision, so a row that disagrees with it is not a record of this ladder.
  CONSTRAINT rung_attempt_position_matches_rung
    CHECK (position = CASE rung
                        WHEN 'catalogue' THEN 1
                        WHEN 'known'     THEN 2
                        WHEN 'verified'  THEN 3
                        WHEN 'external'  THEN 4
                        WHEN 'rfq'       THEN 5
                      END),
  CONSTRAINT rung_attempt_candidates_non_negative CHECK (candidates_found >= 0),
  CONSTRAINT rung_attempt_score_in_range
    CHECK (best_score_per_mille IS NULL OR best_score_per_mille BETWEEN 0 AND 1000),
  -- A rung that found candidates has a best score and one that found none has no best. The pair is
  -- the evidence behind the outcome, so an inconsistent pair is worse than no record at all.
  CONSTRAINT rung_attempt_score_agrees_with_count
    CHECK ((candidates_found > 0) = (best_score_per_mille IS NOT NULL)),
  -- "empty" is not a reason. A customer whose Need became an RFQ is owed a sentence.
  CONSTRAINT rung_attempt_reason_present
    CHECK (length(btrim(reason)) >= 12 AND length(reason) <= 1000),
  CONSTRAINT rung_attempt_attempted_at_finite
    CHECK (attempted_at > '-infinity'::timestamptz AND attempted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_matching.rung_attempt IS
  'What each rung of the ladder did, including the rungs that found nothing and the ones that were skipped. This table is why an escalation to RFQ can be explained.';

CREATE INDEX IF NOT EXISTS rung_attempt_run_idx
  ON module_matching.rung_attempt (run_id, position);

-- ---------------------------------------------------------------------------
-- What was found
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_matching.match_candidate (
  candidate_id        text        NOT NULL,
  run_id              text        NOT NULL,
  rung                text        NOT NULL,
  kind                text        NOT NULL,
  listing_id          text        NULL,
  version_id          text        NULL,
  supplier_account_id text        NOT NULL,
  score_per_mille     integer     NOT NULL,
  explanation         text        NOT NULL,
  evidence            jsonb       NOT NULL,
  found_at            timestamptz NOT NULL,
  correlation_id      text        NOT NULL,
  idempotency_key     text        NOT NULL,

  CONSTRAINT match_candidate_pkey PRIMARY KEY (candidate_id),
  CONSTRAINT match_candidate_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT match_candidate_id_opaque
    CHECK (module_matching.is_opaque_identifier(candidate_id)),
  CONSTRAINT match_candidate_run_id_opaque
    CHECK (module_matching.is_opaque_identifier(run_id)),
  CONSTRAINT match_candidate_listing_id_opaque
    CHECK (listing_id IS NULL OR module_matching.is_opaque_identifier(listing_id)),
  CONSTRAINT match_candidate_version_id_opaque
    CHECK (version_id IS NULL OR module_matching.is_opaque_identifier(version_id)),
  CONSTRAINT match_candidate_supplier_opaque
    CHECK (module_matching.is_opaque_identifier(supplier_account_id)),
  CONSTRAINT match_candidate_correlation_id_opaque
    CHECK (module_matching.is_opaque_identifier(correlation_id)),
  CONSTRAINT match_candidate_idempotency_key_opaque
    CHECK (module_matching.is_opaque_identifier(idempotency_key)),

  CONSTRAINT match_candidate_rung_known
    CHECK (rung IN ('catalogue', 'known', 'verified', 'external', 'rfq')),
  CONSTRAINT match_candidate_kind_known CHECK (kind IN ('listing', 'supplier')),
  -- A listing candidate is orderable and an order pins a version, so naming one without the other
  -- produces a candidate nobody can act on. A supplier candidate names neither: nobody has offered
  -- anything yet, which is exactly what distinguishes the two kinds.
  CONSTRAINT match_candidate_shape_matches_kind
    CHECK (((kind = 'listing') = (listing_id IS NOT NULL))
           AND ((kind = 'listing') = (version_id IS NOT NULL))),
  CONSTRAINT match_candidate_score_in_range
    CHECK (score_per_mille BETWEEN 0 AND 1000),
  -- "score: 0.82" explains nothing to the person deciding whether to spend money.
  CONSTRAINT match_candidate_explanation_present
    CHECK (length(btrim(explanation)) >= 12 AND length(explanation) <= 2000),
  CONSTRAINT match_candidate_evidence_object
    CHECK (jsonb_typeof(evidence) = 'object'),
  CONSTRAINT match_candidate_found_at_finite
    CHECK (found_at > '-infinity'::timestamptz AND found_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_matching.match_candidate IS
  'Something the ladder found. Not an offer: nobody has committed, and a supplier candidate has not even been asked yet.';

CREATE INDEX IF NOT EXISTS match_candidate_run_idx
  ON module_matching.match_candidate (run_id, score_per_mille DESC);

-- ---------------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_matching.outbox (
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

COMMENT ON TABLE module_matching.outbox IS
  'M-07''s transactional outbox. A run and its publication share one transaction, so the two cannot disagree.';

CREATE INDEX IF NOT EXISTS outbox_claimable_idx
  ON module_matching.outbox (next_attempt_at NULLS FIRST, recorded_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

-- ---------------------------------------------------------------------------
-- Nothing here is editable
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION module_matching.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  RAISE EXCEPTION
    'table %.% is append-only: a sourcing run is evidence of what the platform could find at one moment, and editing it would make two runs incomparable',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$body$;

CREATE TRIGGER match_run_is_append_only
  BEFORE UPDATE OR DELETE ON module_matching.match_run
  FOR EACH ROW EXECUTE FUNCTION module_matching.refuse_mutation();

CREATE TRIGGER rung_attempt_is_append_only
  BEFORE UPDATE OR DELETE ON module_matching.rung_attempt
  FOR EACH ROW EXECUTE FUNCTION module_matching.refuse_mutation();

CREATE TRIGGER match_candidate_is_append_only
  BEFORE UPDATE OR DELETE ON module_matching.match_candidate
  FOR EACH ROW EXECUTE FUNCTION module_matching.refuse_mutation();

COMMIT;
