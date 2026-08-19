-- migration: 0007_create_kernel_accounts_schema
-- direction: up
-- owner: kernel_accounts
--
-- K-03 Accounts' own namespace and its single table (FND-004b).
--
-- One row per universal account: one party, one account, written once and never touched again.
-- Orders, payments, ledger entries and audit records will all name these account ids, so the table
-- is write-once at the database as well as in the service — an account whose subject could change
-- would silently reattribute every one of them, and one that could vanish would leave them all
-- pointing at nothing.
--
-- **`subject_id` carries no foreign key into `kernel_identity`, and that is deliberate.** K-03
-- depends on K-01, and it does so through an injected lookup asked before the account transaction
-- opens. A cross-schema foreign key would make the two components one object: `kernel_identity`
-- could not be migrated, rolled back or moved to another database without this schema's
-- permission, and K-01's rollback uses RESTRICT precisely so that it fails loudly rather than
-- taking something else with it. The schema-ownership rule (MODULE_MAP §10) exists for this.
--
-- What is given up is stated rather than glossed: **there is no database-level guarantee that
-- `subject_id` names a real subject.** A row inserted around this component can name anything the
-- opacity rules accept. The cost is small today because K-01 subjects are write-once — nothing
-- deletes one, so a link checked at creation stays valid — and it is recorded in the contract.
--
-- `is_opaque_identifier` is K-03's own copy of K-01's rule set, in K-03's schema, for the same
-- ownership reason: a CHECK calling `kernel_identity.is_opaque_identifier` would be exactly the
-- cross-schema dependency the paragraph above refuses. The two bodies are required to be
-- **character-for-character identical** by `tests/accounts-repository.test.ts`, which extracts both
-- and compares them — an unavoidable duplication converted into a guarded one.
--
-- There is deliberately no `status`, no `closed_at`, no `capabilities`, no `verification_level`, no
-- `balance` and no profile column. Each belongs to a component that does not exist yet, and a
-- column added here in anticipation is a column every consumer starts depending on before its
-- meaning has been decided — and the point at which "one account per party" starts to bend.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_accounts;

COMMENT ON SCHEMA kernel_accounts IS
  'K-03 Accounts. One universal account per K-01 subject. No credentials, capabilities, profiles or balances.';

-- Character-for-character identical to kernel_identity.is_opaque_identifier, and required to stay
-- so by test. Duplicated rather than referenced because a CHECK reaching into another unit's schema
-- would couple the two migrations permanently.
CREATE OR REPLACE FUNCTION kernel_accounts.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION kernel_accounts.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

CREATE TABLE IF NOT EXISTS kernel_accounts.universal_account (
  account_id       text        NOT NULL,
  subject_id       text        NOT NULL,
  created_at       timestamptz NOT NULL,
  origin_kind      text        NOT NULL,
  origin_id        text        NOT NULL,
  idempotency_key  text        NOT NULL,
  CONSTRAINT universal_account_pkey PRIMARY KEY (account_id),
  -- The invariant the whole component exists to hold: one party, one universal account. A second
  -- would split the same person across two histories that can never be reconciled, and it is what
  -- the guide's §4 forbids. Enforced here as well as in the service because the service's
  -- read-then-refuse cannot see a concurrent opening; this can.
  CONSTRAINT universal_account_subject_unique UNIQUE (subject_id),
  CONSTRAINT universal_account_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT universal_account_origin_kind_known
    CHECK (origin_kind IN ('human', 'system', 'ai')),
  -- An account is the party every order, payment and settlement is with. One AI decided should
  -- exist is a counterparty nobody agreed to, and the financial modules bar AI from authority
  -- outright (MODULE_MAP §11). The service refuses it and so does this.
  CONSTRAINT universal_account_origin_not_ai CHECK (origin_kind <> 'ai'),
  -- All four identifier columns are held to one rule set. subject_id in particular: an account
  -- naming a natural key would republish it even though K-01 refused it at the source.
  CONSTRAINT universal_account_id_opaque
    CHECK (kernel_accounts.is_opaque_identifier(account_id)),
  CONSTRAINT universal_account_subject_id_opaque
    CHECK (kernel_accounts.is_opaque_identifier(subject_id)),
  CONSTRAINT universal_account_origin_id_opaque
    CHECK (kernel_accounts.is_opaque_identifier(origin_id)),
  CONSTRAINT universal_account_idempotency_key_opaque
    CHECK (kernel_accounts.is_opaque_identifier(idempotency_key)),
  CONSTRAINT universal_account_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_accounts.universal_account IS
  'Write-once. Refused by trigger against UPDATE and DELETE: every downstream row references these ids.';

COMMENT ON COLUMN kernel_accounts.universal_account.subject_id IS
  'The K-01 subject this account belongs to. No foreign key by design; existence is checked through K-01 before creation.';

COMMENT ON COLUMN kernel_accounts.universal_account.origin_kind IS
  'Who caused the creation. Not authenticated — K-02 does not exist and nothing has verified anybody.';

-- Immutability, enforced by the database rather than by convention. A trigger rather than a
-- permission grant because no roles exist yet: this holds for every connection, including the one
-- an operator opens by hand at three in the morning.
CREATE OR REPLACE FUNCTION kernel_accounts.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS 'BEGIN RAISE EXCEPTION ''universal accounts are write-once: % on kernel_accounts.universal_account is refused'', TG_OP USING ERRCODE = ''restrict_violation''; END;';

COMMENT ON FUNCTION kernel_accounts.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against the account table. Dropped only by the 0007 rollback.';

CREATE TRIGGER universal_account_is_write_once
  BEFORE UPDATE OR DELETE ON kernel_accounts.universal_account
  FOR EACH ROW EXECUTE FUNCTION kernel_accounts.refuse_mutation();

-- Creation order, with the id breaking ties so a paginated walk is stable when two accounts share
-- an instant. K-03 exposes no listing today; the index is here because adding one to a table that
-- has grown is a different operation from creating it empty.
CREATE INDEX IF NOT EXISTS universal_account_chronological_idx
  ON kernel_accounts.universal_account (created_at, account_id);

-- "Which accounts did this creator open" is the question asked when a creator turns out to have
-- been wrong about something.
CREATE INDEX IF NOT EXISTS universal_account_origin_idx
  ON kernel_accounts.universal_account (origin_kind, origin_id, created_at);

COMMIT;
