-- migration: 0024_create_module_universal_account_schema
-- direction: up
-- owner: module_universal_account
--
-- M-01 Universal Account's own namespace and its three tables. This is the first business module
-- to own data; every table above L1 will reference an account capability by id, never by join.
--
-- Owned data:
--   * `account_capability` — one row per (account, capability). The current state of a role an
--     account may act in: buyer, seller, host, provider, introducer, driver, business purchaser.
--   * `capability_state`   — the append-only transition log behind that current state.
--   * `outbox`             — the module's transactional outbox for K-08 events and K-09 audit
--     records.
--
-- `account_id` is an opaque K-03 account id and is deliberately NOT a foreign key. MODULE_MAP.md
-- §10.4 forbids one unit reading or joining to another unit's tables; the account is read through
-- K-03's public API or not at all. The same rule is why the identifier rule set below is a copy.
--
-- `is_opaque_identifier` is M-01's own copy of the rule set used by K-01, K-02, K-03, K-04, K-06,
-- K-07, K-10, K-11, K-12, K-13, K-14 and K-15, in M-01's schema, for the same ownership reason: a
-- CHECK calling another schema's function would make the two units one object. The copies are
-- required to be character-for-character identical by `tests/migrations.test.ts`.
--
-- This migration touches no other unit's schema. There are no foreign keys out of
-- `module_universal_account`.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_universal_account;

COMMENT ON SCHEMA module_universal_account IS
  'M-01 Universal Account. Account capabilities, their transition log and the module outbox.';

-- Character-for-character identical to the copies in kernel_identity, kernel_authentication,
-- kernel_accounts, kernel_permissions, kernel_policy_engine, kernel_feature_flags,
-- kernel_commerce_unit_registry, kernel_ledger_foundation, kernel_conversation_foundation,
-- kernel_ai_gateway, kernel_notifications and kernel_search_foundation, and required to stay so
-- by test.
CREATE OR REPLACE FUNCTION module_universal_account.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION module_universal_account.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- ---------------------------------------------------------------------------
-- Account capability: the current state of one role held by one account
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_universal_account.account_capability (
  capability_id     text        NOT NULL,
  account_id        text        NOT NULL,
  capability        text        NOT NULL,
  status            text        NOT NULL,
  activated_at      timestamptz NOT NULL,
  deactivated_at    timestamptz NULL,
  attributes        jsonb       NOT NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  correlation_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT account_capability_pkey PRIMARY KEY (capability_id),
  CONSTRAINT account_capability_idempotency_unique UNIQUE (idempotency_key),
  -- One row per (account, capability): an account either holds a role or it does not. The history
  -- of how it came to hold it lives in capability_state, not in duplicate current-state rows.
  CONSTRAINT account_capability_account_capability_unique UNIQUE (account_id, capability),

  CONSTRAINT account_capability_id_opaque
    CHECK (module_universal_account.is_opaque_identifier(capability_id)),
  CONSTRAINT account_capability_account_id_opaque
    CHECK (module_universal_account.is_opaque_identifier(account_id)),
  CONSTRAINT account_capability_correlation_id_opaque
    CHECK (module_universal_account.is_opaque_identifier(correlation_id)),
  CONSTRAINT account_capability_idempotency_key_opaque
    CHECK (module_universal_account.is_opaque_identifier(idempotency_key)),
  CONSTRAINT account_capability_capability_known
    CHECK (capability IN
      ('buyer', 'seller', 'host', 'provider', 'introducer', 'driver', 'business-purchaser')),
  CONSTRAINT account_capability_status_known
    CHECK (status IN ('active', 'suspended', 'deactivated')),
  CONSTRAINT account_capability_activated_at_finite
    CHECK (activated_at > '-infinity'::timestamptz AND activated_at < 'infinity'::timestamptz),
  CONSTRAINT account_capability_deactivated_at_finite
    CHECK (deactivated_at IS NULL
      OR (deactivated_at > '-infinity'::timestamptz AND deactivated_at < 'infinity'::timestamptz)),
  CONSTRAINT account_capability_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT account_capability_updated_at_finite
    CHECK (updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz),
  -- A deactivated capability carries the instant it was deactivated, and only a deactivated one
  -- does. Without this the status column and the timestamp can disagree about the same fact.
  CONSTRAINT account_capability_deactivated_at_matches_status
    CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL)),
  CONSTRAINT account_capability_attributes_object
    CHECK (jsonb_typeof(attributes) = 'object')
);

COMMENT ON TABLE module_universal_account.account_capability IS
  'One role held by one account, with its current status. account_id is an opaque K-03 id, not a foreign key.';

CREATE INDEX IF NOT EXISTS account_capability_account_idx
  ON module_universal_account.account_capability (account_id);

CREATE INDEX IF NOT EXISTS account_capability_capability_idx
  ON module_universal_account.account_capability (capability);

CREATE INDEX IF NOT EXISTS account_capability_status_idx
  ON module_universal_account.account_capability (status);

-- ---------------------------------------------------------------------------
-- Capability state: the append-only transition log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_universal_account.capability_state (
  state_id          text        NOT NULL,
  capability_id     text        NOT NULL,
  account_id        text        NOT NULL,
  from_status       text        NULL,
  to_status         text        NOT NULL,
  reason            text        NOT NULL,
  occurred_at       timestamptz NOT NULL,
  correlation_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT capability_state_pkey PRIMARY KEY (state_id),
  CONSTRAINT capability_state_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT capability_state_id_opaque
    CHECK (module_universal_account.is_opaque_identifier(state_id)),
  CONSTRAINT capability_state_capability_id_opaque
    CHECK (module_universal_account.is_opaque_identifier(capability_id)),
  CONSTRAINT capability_state_account_id_opaque
    CHECK (module_universal_account.is_opaque_identifier(account_id)),
  CONSTRAINT capability_state_correlation_id_opaque
    CHECK (module_universal_account.is_opaque_identifier(correlation_id)),
  CONSTRAINT capability_state_idempotency_key_opaque
    CHECK (module_universal_account.is_opaque_identifier(idempotency_key)),
  CONSTRAINT capability_state_from_status_known
    CHECK (from_status IS NULL OR from_status IN ('active', 'suspended', 'deactivated')),
  CONSTRAINT capability_state_to_status_known
    CHECK (to_status IN ('active', 'suspended', 'deactivated')),
  -- A transition that does not change the status is not a transition.
  CONSTRAINT capability_state_transition_changes_status
    CHECK (from_status IS NULL OR from_status <> to_status),
  CONSTRAINT capability_state_reason_present
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  CONSTRAINT capability_state_occurred_at_finite
    CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_universal_account.capability_state IS
  'One status transition of one capability. Append-only: no UPDATE or DELETE.';

CREATE INDEX IF NOT EXISTS capability_state_capability_idx
  ON module_universal_account.capability_state (capability_id, occurred_at, state_id);

CREATE INDEX IF NOT EXISTS capability_state_account_idx
  ON module_universal_account.capability_state (account_id);

-- ---------------------------------------------------------------------------
-- Outbox: the module's transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_universal_account.outbox (
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

COMMENT ON TABLE module_universal_account.outbox IS
  'Transactional outbox for capability events and audit records, dispatched by a relay.';

CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON module_universal_account.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database for capability_state
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION module_universal_account.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'Universal account transition records are append-only: % on % is refused',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION module_universal_account.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against an append-only table in this schema.';

CREATE TRIGGER capability_state_is_append_only
  BEFORE UPDATE OR DELETE ON module_universal_account.capability_state
  FOR EACH ROW EXECUTE FUNCTION module_universal_account.refuse_mutation();

COMMIT;
