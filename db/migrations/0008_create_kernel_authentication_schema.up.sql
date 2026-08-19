-- migration: 0008_create_kernel_authentication_schema
-- direction: up
-- owner: kernel_authentication
--
-- K-02 Authentication's own namespace and its three tables (FND-004c).
--
-- **What is not here is the most important thing about this schema.** There is no password column,
-- no password hash, no key material, no recovery code and no proof of any kind. K-02 does not
-- verify proofs — an injected verifier does — so there is nothing for this schema to hold. A
-- database dump of `kernel_authentication` yields no credential belonging to anybody.
--
-- The one secret-adjacent column is `authentication_session.token_hash`, and it is a SHA-256 of a
-- 32-byte random session secret that this schema has never seen. A read of the table yields no
-- usable session.
--
-- Three tables, and their permissions differ:
--
--   * `authentication_binding` — write-once. Repointing a binding would transfer every session ever
--     issued under it to a different party, silently.
--   * `authentication_evidence` — write-once. Evidence that can be edited is not evidence. The
--     unique `(provider, assertion_id)` is what makes replay detectable: a verifier assertion
--     authenticates exactly once, and a constraint enforces that where a read could not.
--   * `authentication_session` — the only table with a lifecycle, and it is two columns wide. The
--     trigger permits an UPDATE **only** when it rotates the secret or records a revocation, and
--     refuses every DELETE. Everything else about a session — who it authenticates, when it was
--     issued, when it hard-stops — is immutable, so a session cannot be granted a longer life or
--     re-pointed at another subject by an UPDATE nobody reviewed.
--
-- `subject_id` carries no foreign key into `kernel_identity`, for the reason set out in migration
-- 0007: a cross-schema key makes two components one object that cannot be migrated or rolled back
-- independently. Referential validity is checked through K-01's public contract before a write.
--
-- `is_opaque_identifier` is K-02's own copy of the rule set K-01 and K-03 also carry, in K-02's
-- schema, for the same ownership reason — a CHECK reaching into another unit's schema would be
-- exactly the coupling refused above. All three bodies are required to be character-for-character
-- identical by `tests/authentication-repository.test.ts`.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_authentication;

COMMENT ON SCHEMA kernel_authentication IS
  'K-02 Authentication. Opaque bindings, write-once evidence, hashed-token sessions. No credential of any kind is stored here.';

-- Character-for-character identical to kernel_identity.is_opaque_identifier and
-- kernel_accounts.is_opaque_identifier, and required to stay so by test.
CREATE OR REPLACE FUNCTION kernel_authentication.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION kernel_authentication.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- ---------------------------------------------------------------------------
-- Bindings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_authentication.authentication_binding (
  binding_id          text        NOT NULL,
  subject_id          text        NOT NULL,
  provider            text        NOT NULL,
  provider_reference  text        NOT NULL,
  created_at          timestamptz NOT NULL,
  idempotency_key     text        NOT NULL,
  CONSTRAINT authentication_binding_pkey PRIMARY KEY (binding_id),
  -- One reference authenticates one subject. Without this, two parties could share a login and
  -- every session issued afterwards would be attributable to either of them.
  CONSTRAINT authentication_binding_reference_unique UNIQUE (provider, provider_reference),
  CONSTRAINT authentication_binding_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT authentication_binding_provider_format
    CHECK (provider ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  -- The provider reference in particular: whatever handle a provider issues must be opaque before
  -- it reaches this table, or this becomes a table of email addresses nobody declared.
  CONSTRAINT authentication_binding_id_opaque
    CHECK (kernel_authentication.is_opaque_identifier(binding_id)),
  CONSTRAINT authentication_binding_subject_opaque
    CHECK (kernel_authentication.is_opaque_identifier(subject_id)),
  CONSTRAINT authentication_binding_reference_opaque
    CHECK (kernel_authentication.is_opaque_identifier(provider_reference)),
  CONSTRAINT authentication_binding_idempotency_opaque
    CHECK (kernel_authentication.is_opaque_identifier(idempotency_key)),
  CONSTRAINT authentication_binding_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_authentication.authentication_binding IS
  'Write-once. Holds no secret: the link between a K-01 subject and the opaque handle a verifier knows it by.';

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_authentication.authentication_evidence (
  evidence_id      text        NOT NULL,
  binding_id       text        NOT NULL,
  subject_id       text        NOT NULL,
  provider         text        NOT NULL,
  assertion_id     text        NOT NULL,
  factors          text[]      NOT NULL,
  assurance        text        NOT NULL,
  verified_at      timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL,
  idempotency_key  text        NOT NULL,
  CONSTRAINT authentication_evidence_pkey PRIMARY KEY (evidence_id),
  -- Replay protection, as a constraint rather than a check. Two replays of one assertion can both
  -- pass a read; only a unique index can decide between them.
  CONSTRAINT authentication_evidence_assertion_unique UNIQUE (provider, assertion_id),
  CONSTRAINT authentication_evidence_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT authentication_evidence_assurance_known
    CHECK (assurance IN ('single-factor', 'multi-factor', 'hardware-backed')),
  -- Non-empty, and every entry a known category. An authentication that confirmed nothing is not
  -- an authentication, and an unknown category is a row this component did not write.
  CONSTRAINT authentication_evidence_factors_present
    CHECK (array_length(factors, 1) >= 1),
  CONSTRAINT authentication_evidence_factors_known
    CHECK (factors <@ ARRAY['knowledge', 'possession', 'inherence']::text[]),
  CONSTRAINT authentication_evidence_id_opaque
    CHECK (kernel_authentication.is_opaque_identifier(evidence_id)),
  CONSTRAINT authentication_evidence_binding_opaque
    CHECK (kernel_authentication.is_opaque_identifier(binding_id)),
  CONSTRAINT authentication_evidence_subject_opaque
    CHECK (kernel_authentication.is_opaque_identifier(subject_id)),
  CONSTRAINT authentication_evidence_assertion_opaque
    CHECK (kernel_authentication.is_opaque_identifier(assertion_id)),
  CONSTRAINT authentication_evidence_idempotency_opaque
    CHECK (kernel_authentication.is_opaque_identifier(idempotency_key)),
  CONSTRAINT authentication_evidence_instants_finite
    CHECK (verified_at > '-infinity'::timestamptz AND recorded_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_authentication.authentication_evidence IS
  'Write-once. One row per successful authentication; the unique (provider, assertion_id) is what makes replay detectable.';

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_authentication.authentication_session (
  session_id           text        NOT NULL,
  binding_id           text        NOT NULL,
  subject_id           text        NOT NULL,
  evidence_id          text        NOT NULL,
  assurance            text        NOT NULL,
  factors              text[]      NOT NULL,
  token_hash           text        NOT NULL,
  issued_at            timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  idle_expires_at      timestamptz NOT NULL,
  rotation_count       integer     NOT NULL DEFAULT 0,
  revoked_at           timestamptz NULL,
  revocation_reason    text        NULL,
  idempotency_key      text        NOT NULL,
  CONSTRAINT authentication_session_pkey PRIMARY KEY (session_id),
  -- A repeated hash means a repeated secret, which means two parties holding one session. Refusing
  -- the second is how a degraded entropy source becomes visible instead of catastrophic.
  CONSTRAINT authentication_session_token_unique UNIQUE (token_hash),
  CONSTRAINT authentication_session_idempotency_unique UNIQUE (idempotency_key),
  -- A SHA-256 in lower-case hex, and nothing else. A column that accepted arbitrary text would
  -- accept a raw secret, which is exactly the mistake this table exists to make impossible.
  CONSTRAINT authentication_session_token_is_hash
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT authentication_session_assurance_known
    CHECK (assurance IN ('single-factor', 'multi-factor', 'hardware-backed')),
  CONSTRAINT authentication_session_factors_present
    CHECK (array_length(factors, 1) >= 1),
  CONSTRAINT authentication_session_factors_known
    CHECK (factors <@ ARRAY['knowledge', 'possession', 'inherence']::text[]),
  CONSTRAINT authentication_session_expiry_ordered
    CHECK (absolute_expires_at > issued_at AND idle_expires_at <= absolute_expires_at),
  CONSTRAINT authentication_session_rotation_count_sane
    CHECK (rotation_count >= 0),
  -- Half a revocation is worse than none: a reader could not tell which half was true.
  CONSTRAINT authentication_session_revocation_complete
    CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)),
  CONSTRAINT authentication_session_revocation_reason_known
    CHECK (revocation_reason IS NULL OR revocation_reason IN
      ('signed-out', 'rotated-out', 'operator-revoked', 'security-event')),
  CONSTRAINT authentication_session_id_opaque
    CHECK (kernel_authentication.is_opaque_identifier(session_id)),
  CONSTRAINT authentication_session_binding_opaque
    CHECK (kernel_authentication.is_opaque_identifier(binding_id)),
  CONSTRAINT authentication_session_subject_opaque
    CHECK (kernel_authentication.is_opaque_identifier(subject_id)),
  CONSTRAINT authentication_session_evidence_opaque
    CHECK (kernel_authentication.is_opaque_identifier(evidence_id)),
  CONSTRAINT authentication_session_idempotency_opaque
    CHECK (kernel_authentication.is_opaque_identifier(idempotency_key))
);

COMMENT ON TABLE kernel_authentication.authentication_session IS
  'Rotation and revocation only, enforced by trigger. token_hash is a SHA-256 of a secret this schema has never seen.';

COMMENT ON COLUMN kernel_authentication.authentication_session.token_hash IS
  'SHA-256 of the session secret. The secret is presented to the caller once and never stored.';

COMMENT ON COLUMN kernel_authentication.authentication_session.absolute_expires_at IS
  'The hard stop. Rotation never moves it, so a session cannot live for ever by being used.';

-- ---------------------------------------------------------------------------
-- What may change, and what may not
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION kernel_authentication.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS 'BEGIN RAISE EXCEPTION ''authentication records are write-once: % on % is refused'', TG_OP, TG_TABLE_NAME USING ERRCODE = ''restrict_violation''; END;';

COMMENT ON FUNCTION kernel_authentication.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against the binding and evidence tables.';

CREATE TRIGGER authentication_binding_is_write_once
  BEFORE UPDATE OR DELETE ON kernel_authentication.authentication_binding
  FOR EACH ROW EXECUTE FUNCTION kernel_authentication.refuse_mutation();

CREATE TRIGGER authentication_evidence_is_write_once
  BEFORE UPDATE OR DELETE ON kernel_authentication.authentication_evidence
  FOR EACH ROW EXECUTE FUNCTION kernel_authentication.refuse_mutation();

-- Sessions accept exactly two changes and no others. Written as a trigger rather than as column
-- privileges because no roles exist yet: this holds for every connection, including the one an
-- operator opens by hand. What it stops is the UPDATE that quietly lengthens a session's life or
-- points it at a different subject — neither of which any code here can issue, and both of which a
-- hand-written statement could.
CREATE OR REPLACE FUNCTION kernel_authentication.refuse_session_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sessions are never deleted: revoke instead, so the record survives'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.evidence_id IS DISTINCT FROM OLD.evidence_id
     OR NEW.assurance IS DISTINCT FROM OLD.assurance
     OR NEW.factors IS DISTINCT FROM OLD.factors
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.absolute_expires_at IS DISTINCT FROM OLD.absolute_expires_at
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
    RAISE EXCEPTION 'a session UPDATE may only rotate the secret or record a revocation; % is immutable',
      TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.revoked_at IS NOT NULL AND NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    RAISE EXCEPTION 'a revoked session cannot be rotated back into use'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revocation is final; the first one is the one that counts'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.rotation_count < OLD.rotation_count THEN
    RAISE EXCEPTION 'rotation_count may not go backwards'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$guard$;

COMMENT ON FUNCTION kernel_authentication.refuse_session_rewrite() IS
  'Permits only secret rotation and revocation on a session. Everything else about it is immutable.';

CREATE TRIGGER authentication_session_changes_are_bounded
  BEFORE UPDATE OR DELETE ON kernel_authentication.authentication_session
  FOR EACH ROW EXECUTE FUNCTION kernel_authentication.refuse_session_rewrite();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- "Which bindings does this subject authenticate through" — the question an account-security
-- screen asks, and the one a revoke-everything operation would need.
CREATE INDEX IF NOT EXISTS authentication_binding_subject_idx
  ON kernel_authentication.authentication_binding (subject_id, created_at, binding_id);

CREATE INDEX IF NOT EXISTS authentication_evidence_subject_idx
  ON kernel_authentication.authentication_evidence (subject_id, recorded_at, evidence_id);

CREATE INDEX IF NOT EXISTS authentication_session_subject_idx
  ON kernel_authentication.authentication_session (subject_id, issued_at, session_id);

-- Expiry sweeps read this. Partial, because a revoked session is already finished.
CREATE INDEX IF NOT EXISTS authentication_session_live_idx
  ON kernel_authentication.authentication_session (absolute_expires_at)
  WHERE revoked_at IS NULL;

COMMIT;
