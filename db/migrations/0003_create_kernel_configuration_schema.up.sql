-- migration: 0003_create_kernel_configuration_schema
-- direction: up
-- owner: kernel_configuration
--
-- K-05 Configuration's own namespace and its single table (FND-003a).
--
-- One row per version, appended and never updated in place except to stamp supersession. The
-- primary key is the caller-supplied version id, because a decision recorded elsewhere refers to
-- exactly that id and must be able to find this row for as long as the decision matters.
--
-- This migration touches no other unit's schema. The partial unique index is what makes "two
-- active versions for one key and scope" impossible at the database level rather than only in
-- application code — the service refuses it, and this refuses it again if the service is bypassed.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_configuration;

COMMENT ON SCHEMA kernel_configuration IS
  'K-05 Configuration. Registered keys, immutable version records, scoped overrides.';

CREATE TABLE IF NOT EXISTS kernel_configuration.config_version (
  version_id           text        NOT NULL,
  config_key           text        NOT NULL,
  scope_level          text        NOT NULL,
  scope_id             text        NOT NULL,
  value_kind           text        NOT NULL,
  value_text           text        NOT NULL,
  effective_from       timestamptz NOT NULL,
  status               text        NOT NULL,
  created_at           timestamptz NOT NULL,
  published_at         timestamptz NULL,
  superseded_at        timestamptz NULL,
  previous_version_id  text        NULL,
  idempotency_key      text        NOT NULL,
  origin               text        NOT NULL,
  CONSTRAINT config_version_pkey PRIMARY KEY (version_id),
  CONSTRAINT config_version_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT config_version_scope_level_known
    CHECK (scope_level IN ('global', 'region', 'tenant')),
  CONSTRAINT config_version_global_has_no_id
    CHECK ((scope_level = 'global') = (scope_id = '')),
  CONSTRAINT config_version_status_known
    CHECK (status IN ('draft', 'active', 'superseded')),
  CONSTRAINT config_version_value_kind_known
    CHECK (value_kind IN ('boolean', 'integer', 'string', 'enum', 'duration-seconds')),
  CONSTRAINT config_version_origin_permitted
    CHECK (origin IN ('human', 'system-migration')),
  CONSTRAINT config_version_superseded_has_instant
    CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  CONSTRAINT config_version_published_when_not_draft
    CHECK ((status = 'draft') = (published_at IS NULL)),
  CONSTRAINT config_version_key_format
    CHECK (config_key ~ '^[a-z][a-z0-9]*([._][a-z0-9]+)*$')
);

COMMENT ON TABLE kernel_configuration.config_version IS
  'Immutable configuration versions. Rows are appended; only supersession stamps an existing row.';

-- At most one active version per key and scope. The service refuses a second; this makes it
-- impossible even if something writes around the service.
CREATE UNIQUE INDEX IF NOT EXISTS config_version_one_active_per_scope
  ON kernel_configuration.config_version (config_key, scope_level, scope_id)
  WHERE status = 'active';

-- Resolution reads by key and scope, ordered by effective time.
CREATE INDEX IF NOT EXISTS config_version_resolution_idx
  ON kernel_configuration.config_version (config_key, scope_level, scope_id, effective_from DESC);

COMMIT;
