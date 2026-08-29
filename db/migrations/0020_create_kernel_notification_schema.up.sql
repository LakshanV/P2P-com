-- migration: 0020_create_kernel_notification_schema
-- direction: up
-- owner: kernel_notifications
--
-- K-14 Notifications' own namespace and its four tables.
--
-- Owned data:
--   * `channel`            — a channel vocabulary mapped to a provider and configuration.
--   * `notification`       — a templated notification to one account, with lifecycle status.
--   * `delivery_attempt`   — one attempt to deliver a notification through a provider.
--   * `outbox`             — the module's transactional outbox for K-08 events and K-09 audit records.
--
-- Channels and delivery attempts are append-only: there is no UPDATE or DELETE path. Notifications
-- are created once, but `status` and `sent_at` may be updated by a delivery attempt; that is the only
-- mutation a notification row ever sees.
--
-- `is_opaque_identifier` is K-14's own copy of the rule set used by K-01, K-02, K-03, K-04, K-06,
-- K-07, K-10, K-11, K-12 and K-13, in K-14's schema, for the same ownership reason: a CHECK calling
-- another schema's function would make the two components one object. The copies are required to be
-- character-for-character identical by `tests/migrations.test.ts`.
--
-- This migration touches no other unit's schema. There are no foreign keys out of `kernel_notifications`.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_notifications;

COMMENT ON SCHEMA kernel_notifications IS
  'K-14 Notifications. Channel configurations, notifications, delivery attempts and the module outbox.';

-- Character-for-character identical to the copies in kernel_identity, kernel_authentication,
-- kernel_accounts, kernel_permissions, kernel_policy_engine, kernel_feature_flags,
-- kernel_commerce_unit_registry, kernel_ledger_foundation, kernel_conversation_foundation and
-- kernel_ai_gateway, and required to stay so by test.
CREATE OR REPLACE FUNCTION kernel_notifications.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION kernel_notifications.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- ---------------------------------------------------------------------------
-- Channel: a channel vocabulary mapped to a provider and configuration
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_notifications.channel (
  channel_id        text        NOT NULL,
  channel           text        NOT NULL,
  provider          text        NOT NULL,
  enabled           boolean     NOT NULL,
  configuration     jsonb       NOT NULL,
  created_at        timestamptz NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT channel_pkey PRIMARY KEY (channel_id),
  CONSTRAINT channel_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT channel_channel_provider_unique UNIQUE (channel, provider),

  CONSTRAINT channel_id_opaque
    CHECK (kernel_notifications.is_opaque_identifier(channel_id)),
  CONSTRAINT channel_channel_known
    CHECK (channel IN ('in_app', 'email', 'sms', 'push', 'whatsapp')),
  CONSTRAINT channel_provider_non_empty
    CHECK (provider <> ''),
  CONSTRAINT channel_idempotency_key_opaque
    CHECK (kernel_notifications.is_opaque_identifier(idempotency_key)),
  CONSTRAINT channel_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT channel_configuration_object
    CHECK (jsonb_typeof(configuration) = 'object')
);

COMMENT ON TABLE kernel_notifications.channel IS
  'A channel configuration. Append-only: no UPDATE or DELETE.';

CREATE INDEX IF NOT EXISTS channel_channel_idx
  ON kernel_notifications.channel (channel);

-- ---------------------------------------------------------------------------
-- Notification: a rendered message to one account
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_notifications.notification (
  notification_id   text        NOT NULL,
  account_id        text        NOT NULL,
  channel           text        NOT NULL,
  template_id       text        NOT NULL,
  subject           text        NOT NULL,
  body              text        NOT NULL,
  payload           jsonb       NOT NULL,
  priority          text        NOT NULL,
  status            text        NOT NULL,
  scheduled_at      timestamptz NULL,
  sent_at           timestamptz NULL,
  created_at        timestamptz NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT notification_pkey PRIMARY KEY (notification_id),
  CONSTRAINT notification_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT notification_id_opaque
    CHECK (kernel_notifications.is_opaque_identifier(notification_id)),
  CONSTRAINT notification_account_id_opaque
    CHECK (kernel_notifications.is_opaque_identifier(account_id)),
  CONSTRAINT notification_channel_known
    CHECK (channel IN ('in_app', 'email', 'sms', 'push', 'whatsapp')),
  CONSTRAINT notification_template_id_non_empty
    CHECK (template_id <> ''),
  CONSTRAINT notification_priority_known
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT notification_status_known
    CHECK (status IN ('pending', 'sent', 'failed', 'scheduled')),
  CONSTRAINT notification_idempotency_key_opaque
    CHECK (kernel_notifications.is_opaque_identifier(idempotency_key)),
  CONSTRAINT notification_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT notification_scheduled_at_finite
    CHECK (scheduled_at IS NULL OR (scheduled_at > '-infinity'::timestamptz AND scheduled_at < 'infinity'::timestamptz)),
  CONSTRAINT notification_sent_at_finite
    CHECK (sent_at IS NULL OR (sent_at > '-infinity'::timestamptz AND sent_at < 'infinity'::timestamptz)),
  CONSTRAINT notification_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE kernel_notifications.notification IS
  'A notification. Created once; status and sent_at may be updated by delivery attempts.';

CREATE INDEX IF NOT EXISTS notification_account_idx
  ON kernel_notifications.notification (account_id);

CREATE INDEX IF NOT EXISTS notification_status_idx
  ON kernel_notifications.notification (status);

-- ---------------------------------------------------------------------------
-- Delivery attempt: one attempt to deliver a notification
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_notifications.delivery_attempt (
  attempt_id        text        NOT NULL,
  notification_id   text        NOT NULL,
  channel           text        NOT NULL,
  provider          text        NOT NULL,
  status            text        NOT NULL,
  error_code        text        NULL,
  attempted_at      timestamptz NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT delivery_attempt_pkey PRIMARY KEY (attempt_id),
  CONSTRAINT delivery_attempt_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT delivery_attempt_id_opaque
    CHECK (kernel_notifications.is_opaque_identifier(attempt_id)),
  CONSTRAINT delivery_attempt_notification_id_opaque
    CHECK (kernel_notifications.is_opaque_identifier(notification_id)),
  CONSTRAINT delivery_attempt_channel_known
    CHECK (channel IN ('in_app', 'email', 'sms', 'push', 'whatsapp')),
  CONSTRAINT delivery_attempt_status_known
    CHECK (status IN ('success', 'failure')),
  CONSTRAINT delivery_attempt_idempotency_key_opaque
    CHECK (kernel_notifications.is_opaque_identifier(idempotency_key)),
  CONSTRAINT delivery_attempt_attempted_at_finite
    CHECK (attempted_at > '-infinity'::timestamptz AND attempted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_notifications.delivery_attempt IS
  'A delivery attempt. Append-only: no UPDATE or DELETE.';

CREATE INDEX IF NOT EXISTS delivery_attempt_notification_idx
  ON kernel_notifications.delivery_attempt (notification_id);

-- ---------------------------------------------------------------------------
-- Outbox: the module's transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_notifications.outbox (
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

COMMENT ON TABLE kernel_notifications.outbox IS
  'Transactional outbox for notification events and audit records, dispatched by a relay.';

CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON kernel_notifications.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database for channel and delivery_attempt
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION kernel_notifications.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'Notification records are append-only: % on % is refused',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_notifications.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against an append-only business table in this schema.';

CREATE TRIGGER channel_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_notifications.channel
  FOR EACH ROW EXECUTE FUNCTION kernel_notifications.refuse_mutation();

CREATE TRIGGER delivery_attempt_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_notifications.delivery_attempt
  FOR EACH ROW EXECUTE FUNCTION kernel_notifications.refuse_mutation();

COMMIT;
