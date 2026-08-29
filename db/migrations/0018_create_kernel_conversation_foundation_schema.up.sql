-- migration: 0018_create_kernel_conversation_foundation_schema
-- direction: up
-- owner: kernel_conversation_foundation
--
-- K-12 Conversation Foundation's own namespace and its four tables.
--
-- Owned data:
--   * `conversation` — a container with a context, title and creation instant.
--   * `participant` — one account in one conversation, with a role.
--   * `message` — one line in a conversation, with content, type and sent-at instant.
--   * `outbox` — the module's transactional outbox for K-08 events and K-09 audit records.
--
-- All business tables are append-only: there is no UPDATE or DELETE path. Editing a message or a
-- conversation after the fact would rewrite the history that every downstream consumer has already
-- observed.
--
-- `is_opaque_identifier` is K-12's own copy of the rule set used by K-01, K-02, K-03, K-04, K-06,
-- K-07, K-10 and K-11, in K-12's schema, for the same ownership reason: a CHECK calling another
-- schema's function would make the two components one object. The copies are required to be
-- character-for-character identical by `tests/migrations.test.ts`.
--
-- This migration touches no other unit's schema. There are no foreign keys out of
-- `kernel_conversation_foundation`.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_conversation_foundation;

COMMENT ON SCHEMA kernel_conversation_foundation IS
  'K-12 Conversation Foundation. Conversations, participants, messages and the module outbox.';

-- Character-for-character identical to the copies in kernel_identity, kernel_authentication,
-- kernel_accounts, kernel_permissions, kernel_policy_engine, kernel_feature_flags,
-- kernel_commerce_unit_registry and kernel_ledger_foundation, and required to stay so by test.
CREATE OR REPLACE FUNCTION kernel_conversation_foundation.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION kernel_conversation_foundation.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- ---------------------------------------------------------------------------
-- Conversation: a container for participants and messages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_conversation_foundation.conversation (
  conversation_id   text        NOT NULL,
  title             text        NULL,
  context           text        NOT NULL,
  created_at        timestamptz NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT conversation_pkey PRIMARY KEY (conversation_id),
  CONSTRAINT conversation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT conversation_id_opaque
    CHECK (kernel_conversation_foundation.is_opaque_identifier(conversation_id)),
  CONSTRAINT conversation_context_known
    CHECK (context IN ('direct', 'transaction', 'support', 'ai')),
  CONSTRAINT conversation_idempotency_key_opaque
    CHECK (kernel_conversation_foundation.is_opaque_identifier(idempotency_key)),
  CONSTRAINT conversation_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_conversation_foundation.conversation IS
  'A conversation container. Append-only: no UPDATE or DELETE.';

-- ---------------------------------------------------------------------------
-- Participant: one account in one conversation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_conversation_foundation.participant (
  participant_id    text        NOT NULL,
  conversation_id   text        NOT NULL,
  account_id        text        NOT NULL,
  role              text        NOT NULL,
  joined_at         timestamptz NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT participant_pkey PRIMARY KEY (participant_id),
  CONSTRAINT participant_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT participant_conversation_account_unique UNIQUE (conversation_id, account_id),

  CONSTRAINT participant_id_opaque
    CHECK (kernel_conversation_foundation.is_opaque_identifier(participant_id)),
  CONSTRAINT participant_conversation_id_opaque
    CHECK (kernel_conversation_foundation.is_opaque_identifier(conversation_id)),
  CONSTRAINT participant_account_id_opaque
    CHECK (kernel_conversation_foundation.is_opaque_identifier(account_id)),
  CONSTRAINT participant_role_known
    CHECK (role IN ('owner', 'member', 'ai', 'system')),
  CONSTRAINT participant_idempotency_key_opaque
    CHECK (kernel_conversation_foundation.is_opaque_identifier(idempotency_key)),
  CONSTRAINT participant_joined_at_finite
    CHECK (joined_at > '-infinity'::timestamptz AND joined_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_conversation_foundation.participant IS
  'A participant in a conversation. One account per conversation. Append-only.';

CREATE INDEX IF NOT EXISTS participant_conversation_idx
  ON kernel_conversation_foundation.participant (conversation_id);

-- ---------------------------------------------------------------------------
-- Message: one line in a conversation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_conversation_foundation.message (
  message_id        text        NOT NULL,
  conversation_id   text        NOT NULL,
  participant_id    text        NOT NULL,
  content           text        NOT NULL,
  message_type      text        NOT NULL,
  sent_at           timestamptz NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT message_pkey PRIMARY KEY (message_id),
  CONSTRAINT message_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT message_id_opaque
    CHECK (kernel_conversation_foundation.is_opaque_identifier(message_id)),
  CONSTRAINT message_conversation_id_opaque
    CHECK (kernel_conversation_foundation.is_opaque_identifier(conversation_id)),
  CONSTRAINT message_participant_id_opaque
    CHECK (kernel_conversation_foundation.is_opaque_identifier(participant_id)),
  CONSTRAINT message_content_present
    CHECK (length(btrim(content)) > 0),
  CONSTRAINT message_type_known
    CHECK (message_type IN ('text', 'system')),
  CONSTRAINT message_idempotency_key_opaque
    CHECK (kernel_conversation_foundation.is_opaque_identifier(idempotency_key)),
  CONSTRAINT message_sent_at_finite
    CHECK (sent_at > '-infinity'::timestamptz AND sent_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_conversation_foundation.message IS
  'A message in a conversation. Append-only.';

CREATE INDEX IF NOT EXISTS message_conversation_idx
  ON kernel_conversation_foundation.message (conversation_id);

CREATE INDEX IF NOT EXISTS message_conversation_sent_idx
  ON kernel_conversation_foundation.message (conversation_id, sent_at DESC, message_id DESC);

-- ---------------------------------------------------------------------------
-- Outbox: the module's transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_conversation_foundation.outbox (
  outbox_id           text        NOT NULL,
  idempotency_key     text        NOT NULL,
  kind                text        NOT NULL,
  payload             jsonb       NOT NULL,
  recorded_at         timestamptz NOT NULL,
  producer            text        NOT NULL,
  correlation_id      text        NOT NULL,
  processed_at        timestamptz NULL,
  retry_count         integer     NOT NULL DEFAULT 0,
  last_error          text        NULL,

  CONSTRAINT outbox_pkey PRIMARY KEY (outbox_id),
  CONSTRAINT outbox_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT outbox_kind_known CHECK (kind IN ('event', 'audit')),
  CONSTRAINT outbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_retry_non_negative CHECK (retry_count >= 0)
);

COMMENT ON TABLE kernel_conversation_foundation.outbox IS
  'Transactional outbox for conversation events and audit records, dispatched by a relay.';

CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON kernel_conversation_foundation.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION kernel_conversation_foundation.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'conversation records are append-only: % on % is refused',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_conversation_foundation.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against a business table in this schema.';

CREATE TRIGGER conversation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_conversation_foundation.conversation
  FOR EACH ROW EXECUTE FUNCTION kernel_conversation_foundation.refuse_mutation();

CREATE TRIGGER participant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_conversation_foundation.participant
  FOR EACH ROW EXECUTE FUNCTION kernel_conversation_foundation.refuse_mutation();

CREATE TRIGGER message_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_conversation_foundation.message
  FOR EACH ROW EXECUTE FUNCTION kernel_conversation_foundation.refuse_mutation();

COMMIT;
