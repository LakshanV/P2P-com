-- migration: 0019_create_kernel_ai_gateway_schema
-- direction: up
-- owner: kernel_ai_gateway
--
-- K-13 AI Gateway's own namespace and its five tables.
--
-- Owned data:
--   * `task_definition` — a capability-shaped unit of work identified by a dotted-lowercase name.
--   * `model_binding` — a provider, model, capabilities, cost and routing priority.
--   * `ai_run` — one execution of one task through one binding, with cost capture.
--   * `ai_decision` — an AI-influenced decision with policy level and approval status.
--   * `outbox` — the module's transactional outbox for K-08 events and K-09 audit records.
--
-- All business tables are append-only: there is no UPDATE or DELETE path.
--
-- `is_opaque_identifier` is K-13's own copy of the rule set used by K-01, K-02, K-03, K-04, K-06,
-- K-07, K-10, K-11 and K-12, in K-13's schema, for the same ownership reason: a CHECK calling another
-- schema's function would make the two components one object. The copies are required to be
-- character-for-character identical by `tests/migrations.test.ts`.
--
-- This migration touches no other unit's schema. There are no foreign keys out of `kernel_ai_gateway`.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_ai_gateway;

COMMENT ON SCHEMA kernel_ai_gateway IS
  'K-13 AI Gateway. Task definitions, model bindings, AI runs, AI decisions and the module outbox.';

-- Character-for-character identical to the copies in kernel_identity, kernel_authentication,
-- kernel_accounts, kernel_permissions, kernel_policy_engine, kernel_feature_flags,
-- kernel_commerce_unit_registry, kernel_ledger_foundation and kernel_conversation_foundation, and
-- required to stay so by test.
CREATE OR REPLACE FUNCTION kernel_ai_gateway.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION kernel_ai_gateway.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- ---------------------------------------------------------------------------
-- Task definition: a capability-shaped unit of work
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_ai_gateway.task_definition (
  task_id            text        NOT NULL,
  task_name          text        NOT NULL,
  description        text        NOT NULL,
  input_schema       jsonb       NOT NULL,
  output_schema      jsonb       NOT NULL,
  capability         text        NOT NULL,
  created_at         timestamptz NOT NULL,
  idempotency_key    text        NOT NULL,

  CONSTRAINT task_definition_pkey PRIMARY KEY (task_id),
  CONSTRAINT task_definition_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT task_id_dotted_lowercase
    CHECK (task_id ~ '^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT task_capability_known
    CHECK (capability IN ('text', 'vision', 'speech', 'structured', 'reasoning')),
  CONSTRAINT task_idempotency_key_opaque
    CHECK (kernel_ai_gateway.is_opaque_identifier(idempotency_key)),
  CONSTRAINT task_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT task_input_schema_object CHECK (jsonb_typeof(input_schema) = 'object'),
  CONSTRAINT task_output_schema_object CHECK (jsonb_typeof(output_schema) = 'object')
);

COMMENT ON TABLE kernel_ai_gateway.task_definition IS
  'A task definition. Append-only: no UPDATE or DELETE.';

-- ---------------------------------------------------------------------------
-- Model binding: a provider, model, capabilities, cost and priority
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_ai_gateway.model_binding (
  binding_id          text        NOT NULL,
  provider            text        NOT NULL,
  model_id            text        NOT NULL,
  capabilities        text[]      NOT NULL,
  cost_per_1k_input   bigint      NOT NULL,
  cost_per_1k_output  bigint      NOT NULL,
  cost_asset_type_id  text        NOT NULL,
  priority            integer     NOT NULL,
  enabled             boolean     NOT NULL,
  created_at          timestamptz NOT NULL,
  idempotency_key     text        NOT NULL,

  CONSTRAINT model_binding_pkey PRIMARY KEY (binding_id),
  CONSTRAINT model_binding_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT model_binding_id_opaque
    CHECK (kernel_ai_gateway.is_opaque_identifier(binding_id)),
  CONSTRAINT model_binding_provider_known
    CHECK (provider IN ('mock', 'openai', 'anthropic', 'kimi', 'deepseek', 'local')),
  CONSTRAINT model_binding_capability_known
    CHECK (capabilities <@ ARRAY['text', 'vision', 'speech', 'structured', 'reasoning']),
  CONSTRAINT model_binding_cost_non_negative
    CHECK (cost_per_1k_input >= 0 AND cost_per_1k_output >= 0),
  CONSTRAINT model_binding_idempotency_key_opaque
    CHECK (kernel_ai_gateway.is_opaque_identifier(idempotency_key)),
  CONSTRAINT model_binding_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_ai_gateway.model_binding IS
  'A model binding. Append-only.';

CREATE INDEX IF NOT EXISTS model_binding_capabilities_idx
  ON kernel_ai_gateway.model_binding USING GIN (capabilities)
  WHERE enabled = true;

-- ---------------------------------------------------------------------------
-- AI run: one execution of one task through one binding
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_ai_gateway.ai_run (
  run_id              text        NOT NULL,
  task_id             text        NOT NULL,
  binding_id          text        NOT NULL,
  input               jsonb       NOT NULL,
  output              jsonb       NOT NULL,
  status              text        NOT NULL,
  error_code          text        NULL,
  input_tokens        integer     NOT NULL,
  output_tokens       integer     NOT NULL,
  input_cost          bigint      NOT NULL,
  output_cost         bigint      NOT NULL,
  total_cost          bigint      NOT NULL,
  cost_asset_type_id  text        NOT NULL,
  started_at          timestamptz NOT NULL,
  finished_at         timestamptz NOT NULL,
  correlation_id      text        NOT NULL,
  idempotency_key     text        NOT NULL,

  CONSTRAINT ai_run_pkey PRIMARY KEY (run_id),
  CONSTRAINT ai_run_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT ai_run_id_opaque
    CHECK (kernel_ai_gateway.is_opaque_identifier(run_id)),
  CONSTRAINT ai_run_status_known
    CHECK (status IN ('success', 'failure')),
  CONSTRAINT ai_run_cost_non_negative
    CHECK (input_cost >= 0 AND output_cost >= 0 AND total_cost >= 0),
  CONSTRAINT ai_run_tokens_non_negative
    CHECK (input_tokens >= 0 AND output_tokens >= 0),
  CONSTRAINT ai_run_idempotency_key_opaque
    CHECK (kernel_ai_gateway.is_opaque_identifier(idempotency_key)),
  CONSTRAINT ai_run_correlation_id_opaque
    CHECK (kernel_ai_gateway.is_opaque_identifier(correlation_id)),
  CONSTRAINT ai_run_started_at_finite
    CHECK (started_at > '-infinity'::timestamptz AND started_at < 'infinity'::timestamptz),
  CONSTRAINT ai_run_finished_at_finite
    CHECK (finished_at > '-infinity'::timestamptz AND finished_at < 'infinity'::timestamptz),
  CONSTRAINT ai_run_input_object CHECK (jsonb_typeof(input) = 'object'),
  CONSTRAINT ai_run_output_object CHECK (jsonb_typeof(output) = 'object')
);

COMMENT ON TABLE kernel_ai_gateway.ai_run IS
  'An AI run. Append-only.';

CREATE INDEX IF NOT EXISTS ai_run_task_idx
  ON kernel_ai_gateway.ai_run (task_id);

CREATE INDEX IF NOT EXISTS ai_run_binding_idx
  ON kernel_ai_gateway.ai_run (binding_id);

-- ---------------------------------------------------------------------------
-- AI decision: an AI-influenced decision with policy level and approval status
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_ai_gateway.ai_decision (
  decision_id         text        NOT NULL,
  task_id             text        NOT NULL,
  run_id              text        NULL,
  policy_level        integer     NOT NULL,
  approved            boolean     NOT NULL,
  explanation         text        NOT NULL,
  recorded_at         timestamptz NOT NULL,
  idempotency_key     text        NOT NULL,

  CONSTRAINT ai_decision_pkey PRIMARY KEY (decision_id),
  CONSTRAINT ai_decision_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT ai_decision_id_opaque
    CHECK (kernel_ai_gateway.is_opaque_identifier(decision_id)),
  CONSTRAINT ai_decision_policy_level_range
    CHECK (policy_level BETWEEN 0 AND 4),
  CONSTRAINT ai_decision_idempotency_key_opaque
    CHECK (kernel_ai_gateway.is_opaque_identifier(idempotency_key)),
  CONSTRAINT ai_decision_recorded_at_finite
    CHECK (recorded_at > '-infinity'::timestamptz AND recorded_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_ai_gateway.ai_decision IS
  'An AI decision. Append-only.';

CREATE INDEX IF NOT EXISTS ai_decision_task_idx
  ON kernel_ai_gateway.ai_decision (task_id);

-- ---------------------------------------------------------------------------
-- Outbox: the module's transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_ai_gateway.outbox (
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

COMMENT ON TABLE kernel_ai_gateway.outbox IS
  'Transactional outbox for AI gateway events and audit records, dispatched by a relay.';

CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON kernel_ai_gateway.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION kernel_ai_gateway.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'AI gateway records are append-only: % on % is refused',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_ai_gateway.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against a business table in this schema.';

CREATE TRIGGER task_definition_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_ai_gateway.task_definition
  FOR EACH ROW EXECUTE FUNCTION kernel_ai_gateway.refuse_mutation();

CREATE TRIGGER model_binding_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_ai_gateway.model_binding
  FOR EACH ROW EXECUTE FUNCTION kernel_ai_gateway.refuse_mutation();

CREATE TRIGGER ai_run_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_ai_gateway.ai_run
  FOR EACH ROW EXECUTE FUNCTION kernel_ai_gateway.refuse_mutation();

CREATE TRIGGER ai_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_ai_gateway.ai_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_ai_gateway.refuse_mutation();

COMMIT;
