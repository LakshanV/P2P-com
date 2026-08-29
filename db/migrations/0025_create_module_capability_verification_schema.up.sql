-- migration: 0025_create_module_capability_verification_schema
-- direction: up
-- owner: module_capability_verification
--
-- M-02 Capability & Verification's own namespace and its four tables. M-01 owns which roles an
-- account may act in; M-02 owns how far anybody has actually checked, and on what evidence.
--
-- Owned data:
--   * `verification_case` — one verification effort for one account and one purpose, with the
--     level it is trying to reach and the level it has reached.
--   * `evidence`          — one submitted piece of evidence. Append-only.
--   * `level_record`      — the append-only log of level changes behind `achieved_level`.
--   * `outbox`            — the module's transactional outbox for K-08 events and K-09 audit
--     records.
--
-- **This schema holds no document and no document number.** `evidence.reference` is an opaque
-- handle to an artefact another system stores, and it is subject to the same
-- `is_opaque_identifier` rule set as every identifier here — which is what refuses an email, a
-- passport-shaped string, a long digit run, an IBAN shape, a URL and anything credential-shaped.
-- A verification record outlives the thing it verifies, so a document number written into one is
-- disclosed for as long as the platform exists.
--
-- `account_id` is an opaque K-03 account id and is deliberately NOT a foreign key, for the reason
-- MODULE_MAP.md §10.4 gives: a join across a unit boundary is the coupling that makes later
-- extraction to a service impossible. M-02 also holds no foreign key to M-01 — they are the same
-- layer and communicate by event, never by reference.
--
-- `is_opaque_identifier` is M-02's own copy of the rule set used by K-01, K-02, K-03, K-04, K-06,
-- K-07, K-10, K-11, K-12, K-13, K-14, K-15 and M-01, in M-02's schema, for the same ownership
-- reason: a CHECK calling another schema's function would make the two units one object. The
-- copies are required to be character-for-character identical by `tests/migrations.test.ts`.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_capability_verification;

COMMENT ON SCHEMA module_capability_verification IS
  'M-02 Capability & Verification. Verification cases, evidence references, the level log and the module outbox.';

-- Character-for-character identical to the copies in every other unit's schema, and required to
-- stay so by test.
CREATE OR REPLACE FUNCTION module_capability_verification.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION module_capability_verification.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- ---------------------------------------------------------------------------
-- Verification case: one verification effort, for one account, for one purpose
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_capability_verification.verification_case (
  case_id           text        NOT NULL,
  account_id        text        NOT NULL,
  purpose           text        NOT NULL,
  status            text        NOT NULL,
  requested_level   text        NOT NULL,
  achieved_level    text        NOT NULL,
  opened_at         timestamptz NOT NULL,
  decided_at        timestamptz NULL,
  attributes        jsonb       NOT NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  correlation_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT verification_case_pkey PRIMARY KEY (case_id),
  CONSTRAINT verification_case_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT verification_case_id_opaque
    CHECK (module_capability_verification.is_opaque_identifier(case_id)),
  CONSTRAINT verification_case_account_id_opaque
    CHECK (module_capability_verification.is_opaque_identifier(account_id)),
  CONSTRAINT verification_case_correlation_id_opaque
    CHECK (module_capability_verification.is_opaque_identifier(correlation_id)),
  CONSTRAINT verification_case_idempotency_key_opaque
    CHECK (module_capability_verification.is_opaque_identifier(idempotency_key)),
  -- A purpose is a vocabulary word this module groups cases by, not free prose and not a sentence
  -- somebody's name could end up in.
  CONSTRAINT verification_case_purpose_well_formed
    CHECK (purpose ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT verification_case_status_known
    CHECK (status IN
      ('open', 'evidence-required', 'under-review', 'approved', 'rejected', 'withdrawn')),
  CONSTRAINT verification_case_requested_level_known
    CHECK (requested_level IN ('none', 'basic', 'standard', 'enhanced', 'full')),
  CONSTRAINT verification_case_achieved_level_known
    CHECK (achieved_level IN ('none', 'basic', 'standard', 'enhanced', 'full')),
  CONSTRAINT verification_case_opened_at_finite
    CHECK (opened_at > '-infinity'::timestamptz AND opened_at < 'infinity'::timestamptz),
  CONSTRAINT verification_case_decided_at_finite
    CHECK (decided_at IS NULL
      OR (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)),
  CONSTRAINT verification_case_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT verification_case_updated_at_finite
    CHECK (updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz),
  -- A decided case carries the instant it was decided, and only a decided one does. Without this
  -- the status column and the timestamp can disagree about the same fact.
  CONSTRAINT verification_case_decided_at_matches_status
    CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT verification_case_attributes_object
    CHECK (jsonb_typeof(attributes) = 'object')
);

COMMENT ON TABLE module_capability_verification.verification_case IS
  'One verification effort for one account and one purpose. account_id is an opaque K-03 id, not a foreign key.';

-- One *open* case per (account, purpose). A partial index rather than a plain UNIQUE, because a
-- case that has been decided or withdrawn must not block the next attempt: an account that failed
-- seller onboarding in March has to be able to try again in June.
CREATE UNIQUE INDEX IF NOT EXISTS verification_case_one_open_per_purpose_idx
  ON module_capability_verification.verification_case (account_id, purpose)
  WHERE status NOT IN ('approved', 'rejected', 'withdrawn');

CREATE INDEX IF NOT EXISTS verification_case_account_idx
  ON module_capability_verification.verification_case (account_id);

CREATE INDEX IF NOT EXISTS verification_case_status_idx
  ON module_capability_verification.verification_case (status);

CREATE INDEX IF NOT EXISTS verification_case_achieved_level_idx
  ON module_capability_verification.verification_case (achieved_level);

-- ---------------------------------------------------------------------------
-- Evidence: an opaque reference to an artefact somebody else stores
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_capability_verification.evidence (
  evidence_id       text        NOT NULL,
  case_id           text        NOT NULL,
  account_id        text        NOT NULL,
  kind              text        NOT NULL,
  status            text        NOT NULL,
  reference         text        NOT NULL,
  note              text        NOT NULL,
  submitted_at      timestamptz NOT NULL,
  correlation_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT evidence_pkey PRIMARY KEY (evidence_id),
  CONSTRAINT evidence_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT evidence_id_opaque
    CHECK (module_capability_verification.is_opaque_identifier(evidence_id)),
  CONSTRAINT evidence_case_id_opaque
    CHECK (module_capability_verification.is_opaque_identifier(case_id)),
  CONSTRAINT evidence_account_id_opaque
    CHECK (module_capability_verification.is_opaque_identifier(account_id)),
  CONSTRAINT evidence_correlation_id_opaque
    CHECK (module_capability_verification.is_opaque_identifier(correlation_id)),
  CONSTRAINT evidence_idempotency_key_opaque
    CHECK (module_capability_verification.is_opaque_identifier(idempotency_key)),
  -- The reference runs through the same rule set as every identifier. This is the constraint that
  -- keeps a passport number, a tax number, an IBAN, an email or a document URL out of the row: this
  -- module stores a handle to an artefact, never the artefact and never its natural key.
  CONSTRAINT evidence_reference_opaque
    CHECK (module_capability_verification.is_opaque_identifier(reference)),
  CONSTRAINT evidence_kind_known
    CHECK (kind IN ('identity-document', 'address-proof', 'business-registration',
                    'tax-identifier', 'bank-account', 'selfie', 'reference')),
  CONSTRAINT evidence_status_known
    CHECK (status IN ('submitted', 'accepted', 'rejected')),
  CONSTRAINT evidence_note_present
    CHECK (length(btrim(note)) > 0 AND length(note) <= 500),
  CONSTRAINT evidence_submitted_at_finite
    CHECK (submitted_at > '-infinity'::timestamptz AND submitted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_capability_verification.evidence IS
  'One submitted piece of evidence, as an opaque reference to an artefact stored elsewhere. Append-only.';

CREATE INDEX IF NOT EXISTS evidence_case_idx
  ON module_capability_verification.evidence (case_id, submitted_at, evidence_id);

CREATE INDEX IF NOT EXISTS evidence_account_idx
  ON module_capability_verification.evidence (account_id);

-- ---------------------------------------------------------------------------
-- Level record: the append-only log behind achieved_level
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_capability_verification.level_record (
  record_id         text        NOT NULL,
  case_id           text        NOT NULL,
  account_id        text        NOT NULL,
  from_level        text        NULL,
  to_level          text        NOT NULL,
  reason            text        NOT NULL,
  occurred_at       timestamptz NOT NULL,
  correlation_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT level_record_pkey PRIMARY KEY (record_id),
  CONSTRAINT level_record_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT level_record_id_opaque
    CHECK (module_capability_verification.is_opaque_identifier(record_id)),
  CONSTRAINT level_record_case_id_opaque
    CHECK (module_capability_verification.is_opaque_identifier(case_id)),
  CONSTRAINT level_record_account_id_opaque
    CHECK (module_capability_verification.is_opaque_identifier(account_id)),
  CONSTRAINT level_record_correlation_id_opaque
    CHECK (module_capability_verification.is_opaque_identifier(correlation_id)),
  CONSTRAINT level_record_idempotency_key_opaque
    CHECK (module_capability_verification.is_opaque_identifier(idempotency_key)),
  CONSTRAINT level_record_from_level_known
    CHECK (from_level IS NULL
      OR from_level IN ('none', 'basic', 'standard', 'enhanced', 'full')),
  CONSTRAINT level_record_to_level_known
    CHECK (to_level IN ('none', 'basic', 'standard', 'enhanced', 'full')),
  -- A record that does not change the level is not a level change.
  CONSTRAINT level_record_changes_level
    CHECK (from_level IS NULL OR from_level <> to_level),
  CONSTRAINT level_record_reason_present
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  CONSTRAINT level_record_occurred_at_finite
    CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_capability_verification.level_record IS
  'One verification-level change. Append-only: no UPDATE or DELETE.';

CREATE INDEX IF NOT EXISTS level_record_case_idx
  ON module_capability_verification.level_record (case_id, occurred_at, record_id);

CREATE INDEX IF NOT EXISTS level_record_account_idx
  ON module_capability_verification.level_record (account_id);

-- ---------------------------------------------------------------------------
-- Outbox: the module's transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_capability_verification.outbox (
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

COMMENT ON TABLE module_capability_verification.outbox IS
  'Transactional outbox for verification events and audit records, dispatched by a relay.';

CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON module_capability_verification.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database for evidence and level_record
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION module_capability_verification.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'Verification evidence and level records are append-only: % on % is refused',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION module_capability_verification.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against an append-only table in this schema.';

CREATE TRIGGER evidence_is_append_only
  BEFORE UPDATE OR DELETE ON module_capability_verification.evidence
  FOR EACH ROW EXECUTE FUNCTION module_capability_verification.refuse_mutation();

CREATE TRIGGER level_record_is_append_only
  BEFORE UPDATE OR DELETE ON module_capability_verification.level_record
  FOR EACH ROW EXECUTE FUNCTION module_capability_verification.refuse_mutation();

COMMIT;
