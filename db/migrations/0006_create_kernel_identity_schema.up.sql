-- migration: 0006_create_kernel_identity_schema
-- direction: up
-- owner: kernel_identity
--
-- K-01 Identity's own namespace and its single table (FND-004a, constraints corrected).
--
-- One row per identity subject, written once and never touched again. Everything the platform
-- eventually builds — accounts, orders, ledger entries, audit records — will reference these ids,
-- so immutability is enforced here as well as in the service: the trigger below refuses every
-- UPDATE and DELETE against the table. An id whose meaning can change silently reattributes
-- history, and an id that can vanish leaves every referencing row pointing at nothing.
--
-- **The opacity rules live in one function.** The first revision of this migration wrote three
-- separate CHECKs whose comments claimed to prohibit natural keys, and they did not: a ten-digit
-- telephone number, a `first.last` personal name, a compact IBAN and a domain name all satisfied
-- every constraint the table declared, while the service refused all four. A constraint that claims
-- more than it enforces is worse than no constraint, because the next person reads the comment
-- rather than the predicate.
--
-- So `is_opaque_identifier` carries the whole rule set once and all three identifier columns call
-- it. That mirrors `assertOpaqueIdentifier` in kernel/identity/registry.ts clause for clause, and
-- `tests/identity-repository.test.ts` extracts the clauses from this file, translates them and runs
-- the service's own accepted and rejected identifiers through them — so the two enforcement points
-- cannot drift apart quietly.
--
-- The other constraint that matters for a write around the adapter is `origin_kind <> 'ai'`. AI may
-- not author an identity: it is the root of attribution for everything that references it, so a
-- fabricated one is indistinguishable from a real party.
--
-- There is deliberately no `status`, no `deleted_at`, no `merged_into` and no profile column.
-- Deactivation, merge and profile data belong to components that do not exist yet, and a column
-- added here in anticipation is a column every consumer starts depending on before its meaning has
-- been decided.
--
-- MODULE_MAP §3 lists K-01's core tables as `identity` and `identity_document`. This migration
-- delivers the first under the more precise name `identity_subject`; `identity_document` holds
-- verification evidence and is deferred with the verification work, which is a different component.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_identity;

COMMENT ON SCHEMA kernel_identity IS
  'K-01 Identity. Stable opaque internal handles for parties. No credentials, accounts or profiles.';

-- The single rule set, mirroring assertOpaqueIdentifier in kernel/identity/registry.ts.
--
-- Two shapes the application also refuses are absent on purpose, because the character class
-- already excludes them and a dead clause invites the reader to trust the wrong one: a `+`-prefixed
-- telephone number (no `+` in the class) and a connection string or PEM block (no `/`, `@` or
-- space). Every other rule is here.
CREATE OR REPLACE FUNCTION kernel_identity.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION kernel_identity.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

CREATE TABLE IF NOT EXISTS kernel_identity.identity_subject (
  subject_id       text        NOT NULL,
  kind             text        NOT NULL,
  created_at       timestamptz NOT NULL,
  origin_kind      text        NOT NULL,
  origin_id        text        NOT NULL,
  idempotency_key  text        NOT NULL,
  CONSTRAINT identity_subject_pkey PRIMARY KEY (subject_id),
  CONSTRAINT identity_subject_idempotency_unique UNIQUE (idempotency_key),
  -- The closed kind registry. No buyer, no seller, no host: those are capabilities of an account
  -- (K-03), and one person who both buys and sells is one subject. See guide §4.
  CONSTRAINT identity_subject_kind_known
    CHECK (kind IN ('person', 'organisation', 'system')),
  CONSTRAINT identity_subject_origin_kind_known
    CHECK (origin_kind IN ('human', 'system', 'ai')),
  -- AI may prompt a human or a deterministic system to create an identity; it may not create one.
  -- The service refuses it and so does this, because a fabricated party is indistinguishable from
  -- a real one to every module that later transacts with it.
  CONSTRAINT identity_subject_origin_not_ai CHECK (origin_kind <> 'ai'),
  -- Opacity, enforced at the database because a natural key written around the adapter is just as
  -- permanent as one written through it. All three identifier columns are held to one rule set:
  -- origin_id and idempotency_key are copied into logs and diagnostics exactly as subject_id is.
  CONSTRAINT identity_subject_id_opaque
    CHECK (kernel_identity.is_opaque_identifier(subject_id)),
  CONSTRAINT identity_subject_origin_id_opaque
    CHECK (kernel_identity.is_opaque_identifier(origin_id)),
  CONSTRAINT identity_subject_idempotency_key_opaque
    CHECK (kernel_identity.is_opaque_identifier(idempotency_key)),
  CONSTRAINT identity_subject_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_identity.identity_subject IS
  'Write-once. Refused by trigger against UPDATE and DELETE: every downstream row references these ids.';

COMMENT ON COLUMN kernel_identity.identity_subject.subject_id IS
  'Opaque internal handle supplied by the caller. Never a natural key: not an email, phone or document number.';

COMMENT ON COLUMN kernel_identity.identity_subject.kind IS
  'What the party is, never what it may do. Capabilities such as buyer or seller belong to K-03.';

COMMENT ON COLUMN kernel_identity.identity_subject.origin_kind IS
  'Who caused the creation. Not authenticated — K-02 does not exist and nothing has verified anybody.';

-- Immutability, enforced by the database rather than by convention. A trigger rather than a
-- permission grant because no roles exist yet: this holds for every connection, including the one
-- an operator opens by hand at three in the morning.
CREATE OR REPLACE FUNCTION kernel_identity.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS 'BEGIN RAISE EXCEPTION ''identity subjects are write-once: % on kernel_identity.identity_subject is refused'', TG_OP USING ERRCODE = ''restrict_violation''; END;';

COMMENT ON FUNCTION kernel_identity.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against the identity table. Dropped only by the 0006 rollback.';

CREATE TRIGGER identity_subject_is_write_once
  BEFORE UPDATE OR DELETE ON kernel_identity.identity_subject
  FOR EACH ROW EXECUTE FUNCTION kernel_identity.refuse_mutation();

-- Creation order, with the id breaking ties so a paginated walk is stable when two subjects share
-- an instant. K-01 exposes no listing today; the index is here because adding one to a table that
-- has grown is a different operation from creating it empty.
CREATE INDEX IF NOT EXISTS identity_subject_chronological_idx
  ON kernel_identity.identity_subject (created_at, subject_id);

-- "Which subjects did this creator make" is the question asked when a creator turns out to have
-- been wrong about something.
CREATE INDEX IF NOT EXISTS identity_subject_origin_idx
  ON kernel_identity.identity_subject (origin_kind, origin_id, created_at);

CREATE INDEX IF NOT EXISTS identity_subject_kind_idx
  ON kernel_identity.identity_subject (kind, created_at, subject_id);

COMMIT;
