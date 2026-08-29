-- migration: 0021_create_kernel_search_foundation_schema
-- direction: up
-- owner: kernel_search_foundation
--
-- K-15 Search Foundation's own namespace and its three tables.
--
-- Owned data:
--   * `document`   — a searchable document: text, facets, optional vectors and ranking signals.
--   * `query_log`  — one row per executed query. Append-only.
--   * `outbox`     — the module's transactional outbox for K-08 events and K-09 audit records.
--
-- Documents are replaced whole by `documentId` on re-index. Query logs are append-only. The text
-- search surface uses a generated `tsv` tsvector column backed by a GIN index.
--
-- `is_opaque_identifier` is K-15's own copy of the rule set used by K-01, K-02, K-03, K-04, K-06,
-- K-07, K-10, K-11, K-12, K-13 and K-14, in K-15's schema, for the same ownership reason: a CHECK
-- calling another schema's function would make the two components one object. The copies are
-- required to be character-for-character identical by `tests/migrations.test.ts`.
--
-- This migration touches no other unit's schema. There are no foreign keys out of
-- `kernel_search_foundation`.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_search_foundation;

COMMENT ON SCHEMA kernel_search_foundation IS
  'K-15 Search Foundation. Search documents, query logs and the module outbox.';

-- Character-for-character identical to the copies in kernel_identity, kernel_authentication,
-- kernel_accounts, kernel_permissions, kernel_policy_engine, kernel_feature_flags,
-- kernel_commerce_unit_registry, kernel_ledger_foundation, kernel_conversation_foundation,
-- kernel_ai_gateway and kernel_notifications, and required to stay so by test.
CREATE OR REPLACE FUNCTION kernel_search_foundation.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION kernel_search_foundation.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- Immutable helper for the generated tsv column. `array_to_string` is marked STABLE in the
-- PostgreSQL catalog because it handles arrays of any element type, but for `text[]` with a
-- space separator it is effectively immutable. A generated column requires an immutable
-- expression, so this wrapper declares the immutability the tsv expression depends on.
CREATE OR REPLACE FUNCTION kernel_search_foundation.keywords_to_text(keywords text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $rules$
  SELECT array_to_string(keywords, ' ');
$rules$;

COMMENT ON FUNCTION kernel_search_foundation.keywords_to_text(text[]) IS
  'Joins text[] keywords with a single space. Immutable so the generated document.tsv column can use it.';

-- ---------------------------------------------------------------------------
-- Document: a searchable document
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_search_foundation.document (
  document_id       text        NOT NULL,
  owner_type        text        NOT NULL,
  owner_id          text        NOT NULL,
  scope             text        NOT NULL,
  language          text        NOT NULL,
  title             text        NOT NULL,
  description       text        NOT NULL,
  keywords          text[]      NOT NULL,
  attributes        jsonb       NOT NULL,
  vectors           jsonb       NOT NULL,
  ranking           jsonb       NOT NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  idempotency_key   text        NOT NULL,

  -- Generated full-text search vector over title, description and keywords.
  tsv               tsvector    GENERATED ALWAYS AS (
    to_tsvector(
      'english'::regconfig,
      title || ' ' || description || ' ' || coalesce(kernel_search_foundation.keywords_to_text(keywords), '')
    )
  ) STORED,

  CONSTRAINT document_pkey PRIMARY KEY (document_id),
  CONSTRAINT document_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT document_id_opaque
    CHECK (kernel_search_foundation.is_opaque_identifier(document_id)),
  CONSTRAINT document_owner_id_opaque
    CHECK (kernel_search_foundation.is_opaque_identifier(owner_id)),
  CONSTRAINT document_title_present
    CHECK (length(btrim(title)) > 0),
  CONSTRAINT document_description_present
    CHECK (length(btrim(description)) > 0),
  CONSTRAINT document_idempotency_key_opaque
    CHECK (kernel_search_foundation.is_opaque_identifier(idempotency_key)),
  CONSTRAINT document_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT document_updated_at_finite
    CHECK (updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz),
  CONSTRAINT document_attributes_object
    CHECK (jsonb_typeof(attributes) = 'object'),
  CONSTRAINT document_vectors_object
    CHECK (jsonb_typeof(vectors) = 'object'),
  CONSTRAINT document_ranking_object
    CHECK (jsonb_typeof(ranking) = 'object')
);

COMMENT ON TABLE kernel_search_foundation.document IS
  'A searchable document. Replaced whole by document_id on re-index.';

CREATE INDEX IF NOT EXISTS document_owner_type_idx
  ON kernel_search_foundation.document (owner_type);

CREATE INDEX IF NOT EXISTS document_owner_id_idx
  ON kernel_search_foundation.document (owner_id);

CREATE INDEX IF NOT EXISTS document_scope_idx
  ON kernel_search_foundation.document (scope);

CREATE INDEX IF NOT EXISTS document_language_idx
  ON kernel_search_foundation.document (language);

CREATE INDEX IF NOT EXISTS document_tsv_idx
  ON kernel_search_foundation.document USING GIN (tsv);

-- ---------------------------------------------------------------------------
-- Query log: one row per executed query
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_search_foundation.query_log (
  query_id          text        NOT NULL,
  query_text        text        NOT NULL,
  filters           jsonb       NOT NULL,
  result_count      integer     NOT NULL,
  executed_at       timestamptz NOT NULL,
  correlation_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT query_log_pkey PRIMARY KEY (query_id),
  CONSTRAINT query_log_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT query_log_id_opaque
    CHECK (kernel_search_foundation.is_opaque_identifier(query_id)),
  CONSTRAINT query_log_correlation_id_opaque
    CHECK (kernel_search_foundation.is_opaque_identifier(correlation_id)),
  CONSTRAINT query_log_idempotency_key_opaque
    CHECK (kernel_search_foundation.is_opaque_identifier(idempotency_key)),
  CONSTRAINT query_log_executed_at_finite
    CHECK (executed_at > '-infinity'::timestamptz AND executed_at < 'infinity'::timestamptz),
  CONSTRAINT query_log_result_count_non_negative
    CHECK (result_count >= 0),
  CONSTRAINT query_log_filters_object
    CHECK (jsonb_typeof(filters) = 'object')
);

COMMENT ON TABLE kernel_search_foundation.query_log IS
  'A recorded query. Append-only: no UPDATE or DELETE.';

CREATE INDEX IF NOT EXISTS query_log_executed_idx
  ON kernel_search_foundation.query_log (executed_at);

-- ---------------------------------------------------------------------------
-- Outbox: the module's transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_search_foundation.outbox (
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

COMMENT ON TABLE kernel_search_foundation.outbox IS
  'Transactional outbox for search events and audit records, dispatched by a relay.';

CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON kernel_search_foundation.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database for query_log
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION kernel_search_foundation.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'Search foundation records are append-only: % on % is refused',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_search_foundation.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against an append-only table in this schema.';

CREATE TRIGGER query_log_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_search_foundation.query_log
  FOR EACH ROW EXECUTE FUNCTION kernel_search_foundation.refuse_mutation();

COMMIT;
