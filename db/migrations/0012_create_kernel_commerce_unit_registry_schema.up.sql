-- migration: 0012_create_kernel_commerce_unit_registry_schema
-- direction: up
-- owner: kernel_commerce_unit_registry
--
-- K-11 Commerce Unit Registry's own namespace and its three tables (FND-005c).
--
-- **Everything in this schema is append-only.** There is no UPDATE path and no DELETE path for a
-- type version, an activation or a retirement. Three triggers refuse both operations outright.
--
-- The reason is what a type key means once anything uses it. A listing, an order line, an invoice
-- and a commission decision all copy the type they were created under; editing that type in place
-- changes what every one of those records says it is — retroactively, and with nothing in the
-- history to find. It is v3 §24's rule about policy arriving through the vocabulary instead of
-- through the rates.
--
-- Three tables:
--
--   * `commerce_unit_type_version` — an immutable numbered definition: v3 §11's kind, the owner
--     scope, the parent it extends, the v3 §12 units it may be priced in, the K-06 policy key
--     carrying its risk pack, and its bounded effective window.
--   * `commerce_unit_type_activation` — which version is in force, as an append-only **chain**:
--     each row names the version it supersedes, and carries the K-06 policy version pinned at that
--     moment. Two partial unique indexes make "two versions of one category in force at once"
--     impossible rather than merely unlikely.
--   * `commerce_unit_type_retirement` — the end of a type's life, at most one per key. It stops new
--     listings; it does not remove the versions existing listings reference.
--
-- **Ownership is two columns and a CHECK, not a convention.** `owner_kind` with `owner_tenant_id`
-- lets the database refuse a platform row that names a tenant and a tenant row that does not — the
-- isolation rule written where a statement issued around the service still meets it.
--
-- There is **no price, no currency, no conversion factor, no tax column and no display text** in
-- this schema, and there never will be. Each belongs to a component that exists or will; putting
-- one here would make the registry the place two systems disagree about money or language.
--
-- Tenant handles carry no foreign key into `kernel_accounts`, for the reason set out in migration
-- 0007: a cross-schema key makes two components one object that cannot be migrated or rolled back
-- independently. The cost — no database-level referential guarantee that a tenant exists — is
-- stated in K-11's contract rather than glossed.
--
-- `is_opaque_identifier` is K-11's own copy of the rule set K-01, K-02, K-03, K-04, K-06 and K-07
-- also carry, in K-11's schema, for the same ownership reason. All seven bodies are required to be
-- character-for-character identical by `tests/commerce-unit-registry-repository.test.ts`.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_commerce_unit_registry;

COMMENT ON SCHEMA kernel_commerce_unit_registry IS
  'K-11 Commerce Unit Registry. Append-only versioned commerce unit types, their activation chain and their retirements. The platform vocabulary; holds no price, currency or display text.';

-- Character-for-character identical to kernel_identity.is_opaque_identifier and the copies in
-- kernel_authentication, kernel_accounts, kernel_permissions, kernel_policy_engine and
-- kernel_feature_flags, and required to stay so by test.
CREATE OR REPLACE FUNCTION kernel_commerce_unit_registry.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION kernel_commerce_unit_registry.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- A type key is a dotted namespace, not an opaque handle: somebody reading a listing has to be
-- able to tell what kind of thing it describes without resolving anything.
CREATE OR REPLACE FUNCTION kernel_commerce_unit_registry.is_type_key(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $keys$
  SELECT value ~ '^[a-z][a-z0-9-]{1,30}(\.[a-z][a-z0-9-]{1,30}){0,3}$'
$keys$;

COMMENT ON FUNCTION kernel_commerce_unit_registry.is_type_key(text) IS
  'True when the value is a well-formed commerce unit type key: one to four dotted lowercase segments.';

-- ---------------------------------------------------------------------------
-- Versions: immutable, numbered per type, and what every listing refers back to
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_commerce_unit_registry.commerce_unit_type_version (
  type_version_id     text        NOT NULL,
  type_key            text        NOT NULL,
  version             integer     NOT NULL,
  kind                text        NOT NULL,
  owner_kind          text        NOT NULL,
  owner_tenant_id     text,
  parent_type_key     text,
  measures            jsonb       NOT NULL,
  risk_policy_key     text,
  effective_from      timestamptz,
  effective_until     timestamptz,
  published_at        timestamptz NOT NULL,
  published_by_kind   text        NOT NULL,
  published_by_id     text        NOT NULL,
  idempotency_key     text        NOT NULL,
  request_fingerprint text        NOT NULL,

  CONSTRAINT commerce_unit_type_version_pkey PRIMARY KEY (type_version_id),

  -- One row per version number within a type. Two rows claiming version 7 would make "the
  -- definition of the day" ambiguous for every listing created under it.
  CONSTRAINT commerce_unit_type_version_number_unique UNIQUE (type_key, version),
  CONSTRAINT commerce_unit_type_version_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT commerce_unit_type_version_number_positive CHECK (version >= 1),
  CONSTRAINT commerce_unit_type_version_key_shape
    CHECK (kernel_commerce_unit_registry.is_type_key(type_key)),
  -- v3 §11's ten kinds, and no others. A kind nobody registered is a category the platform has no
  -- adapters, no risk pack and no fulfilment rules for.
  CONSTRAINT commerce_unit_type_version_kind_known
    CHECK (kind IN ('new-product', 'used-product', 'bulk-commodity', 'vehicle', 'accommodation',
                    'service', 'rental', 'wholesale-lot', 'custom-item', 'other')),
  -- The isolation rule, where a statement written around the service still meets it: a platform
  -- row names no tenant, and a tenant row must name one.
  CONSTRAINT commerce_unit_type_version_owner_known CHECK (owner_kind IN ('platform', 'tenant')),
  CONSTRAINT commerce_unit_type_version_owner_shape
    CHECK (
      CASE WHEN owner_kind = 'platform'
        THEN owner_tenant_id IS NULL
        ELSE owner_tenant_id IS NOT NULL
             AND kernel_commerce_unit_registry.is_opaque_identifier(owner_tenant_id)
      END
    ),
  -- No AI author. The vocabulary decides which risk pack applies and which commission rule
  -- matches, which is authority over the platform's economics one indirection out (v3 §38).
  CONSTRAINT commerce_unit_type_version_origin_known
    CHECK (published_by_kind IN ('human', 'system')),
  -- A type that is its own parent is a lineage of one thing containing itself.
  CONSTRAINT commerce_unit_type_version_not_self_parent
    CHECK (parent_type_key IS NULL OR parent_type_key <> type_key),
  CONSTRAINT commerce_unit_type_version_parent_shape
    CHECK (parent_type_key IS NULL OR kernel_commerce_unit_registry.is_type_key(parent_type_key)),
  CONSTRAINT commerce_unit_type_version_measures_shape
    CHECK (jsonb_typeof(measures) = 'array' AND jsonb_array_length(measures) >= 1),
  -- A window that contains no instant is a type that can never describe anything while reading as
  -- though it were scheduled.
  CONSTRAINT commerce_unit_type_version_window_ordered
    CHECK (effective_from IS NULL OR effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT commerce_unit_type_version_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT commerce_unit_type_version_id_opaque
    CHECK (kernel_commerce_unit_registry.is_opaque_identifier(type_version_id)),
  CONSTRAINT commerce_unit_type_version_publisher_opaque
    CHECK (kernel_commerce_unit_registry.is_opaque_identifier(published_by_id)),
  CONSTRAINT commerce_unit_type_version_idempotency_opaque
    CHECK (kernel_commerce_unit_registry.is_opaque_identifier(idempotency_key)),
  CONSTRAINT commerce_unit_type_version_published_at_finite
    CHECK (published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz),
  CONSTRAINT commerce_unit_type_version_effective_from_finite
    CHECK (effective_from IS NULL OR (effective_from > '-infinity'::timestamptz AND effective_from < 'infinity'::timestamptz)),
  CONSTRAINT commerce_unit_type_version_effective_until_finite
    CHECK (effective_until IS NULL OR (effective_until > '-infinity'::timestamptz AND effective_until < 'infinity'::timestamptz))
);

COMMENT ON TABLE kernel_commerce_unit_registry.commerce_unit_type_version IS
  'Immutable numbered commerce unit type definitions. A change is a new version, never an edit: every listing created under a type refers back to it.';

COMMENT ON COLUMN kernel_commerce_unit_registry.commerce_unit_type_version.measures IS
  'The v3 §12 units this type may be priced in, each qualified by its family. Not a conversion table: arithmetic between units belongs to K-10.';

COMMENT ON COLUMN kernel_commerce_unit_registry.commerce_unit_type_version.risk_policy_key IS
  'The K-06 policy key carrying this category risk pack (v3 §16). The key only: K-11 stores no rule and decides nothing from one.';

-- ---------------------------------------------------------------------------
-- Activations: an append-only chain, carrying the pinned policy provenance
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_commerce_unit_registry.commerce_unit_type_activation (
  activation_id          text        NOT NULL,
  type_key               text        NOT NULL,
  type_version_id        text        NOT NULL,
  supersedes_version_id  text,
  risk_policy_version_id text,
  activated_at           timestamptz NOT NULL,
  activated_by_kind      text        NOT NULL,
  activated_by_id        text        NOT NULL,
  idempotency_key        text        NOT NULL,
  request_fingerprint    text        NOT NULL,

  CONSTRAINT commerce_unit_type_activation_pkey PRIMARY KEY (activation_id),
  CONSTRAINT commerce_unit_type_activation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT commerce_unit_type_activation_key_shape
    CHECK (kernel_commerce_unit_registry.is_type_key(type_key)),
  CONSTRAINT commerce_unit_type_activation_origin_known
    CHECK (activated_by_kind IN ('human', 'system')),
  CONSTRAINT commerce_unit_type_activation_moves
    CHECK (supersedes_version_id IS NULL OR supersedes_version_id <> type_version_id),
  CONSTRAINT commerce_unit_type_activation_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT commerce_unit_type_activation_id_opaque
    CHECK (kernel_commerce_unit_registry.is_opaque_identifier(activation_id)),
  CONSTRAINT commerce_unit_type_activation_version_opaque
    CHECK (kernel_commerce_unit_registry.is_opaque_identifier(type_version_id)),
  CONSTRAINT commerce_unit_type_activation_supersedes_opaque
    CHECK (supersedes_version_id IS NULL OR kernel_commerce_unit_registry.is_opaque_identifier(supersedes_version_id)),
  CONSTRAINT commerce_unit_type_activation_policy_opaque
    CHECK (risk_policy_version_id IS NULL OR kernel_commerce_unit_registry.is_opaque_identifier(risk_policy_version_id)),
  CONSTRAINT commerce_unit_type_activation_actor_opaque
    CHECK (kernel_commerce_unit_registry.is_opaque_identifier(activated_by_id)),
  CONSTRAINT commerce_unit_type_activation_idempotency_opaque
    CHECK (kernel_commerce_unit_registry.is_opaque_identifier(idempotency_key)),
  CONSTRAINT commerce_unit_type_activation_activated_at_finite
    CHECK (activated_at > '-infinity'::timestamptz AND activated_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_commerce_unit_registry.commerce_unit_type_activation IS
  'Which version is in force, as an append-only chain, with the K-06 risk policy version pinned at that moment. Ordering is the chain, never the clock.';

-- The guard, in the database rather than only in the service. Two registrars acting on the same
-- category read the same version in force and both activate; without this the history says two
-- versions described listings at once, with no way to tell which.
CREATE UNIQUE INDEX IF NOT EXISTS commerce_unit_type_activation_supersedes_unique
  ON kernel_commerce_unit_registry.commerce_unit_type_activation (type_key, supersedes_version_id)
  WHERE supersedes_version_id IS NOT NULL;

-- And the same rule for the first activation, which supersedes nothing. A partial index is needed
-- because NULLs do not conflict in a plain unique constraint, so two "first" activations would
-- both be accepted.
CREATE UNIQUE INDEX IF NOT EXISTS commerce_unit_type_activation_first_unique
  ON kernel_commerce_unit_registry.commerce_unit_type_activation (type_key)
  WHERE supersedes_version_id IS NULL;

-- ---------------------------------------------------------------------------
-- Retirement: the end of a type's life, without erasing its history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_commerce_unit_registry.commerce_unit_type_retirement (
  retirement_id       text        NOT NULL,
  type_key            text        NOT NULL,
  reason              text        NOT NULL,
  retired_at          timestamptz NOT NULL,
  retired_by_kind     text        NOT NULL,
  retired_by_id       text        NOT NULL,
  idempotency_key     text        NOT NULL,
  request_fingerprint text        NOT NULL,

  CONSTRAINT commerce_unit_type_retirement_pkey PRIMARY KEY (retirement_id),

  -- One retirement per type, for good. A second would rewrite when the category actually stopped
  -- accepting listings.
  CONSTRAINT commerce_unit_type_retirement_type_unique UNIQUE (type_key),
  CONSTRAINT commerce_unit_type_retirement_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT commerce_unit_type_retirement_key_shape
    CHECK (kernel_commerce_unit_registry.is_type_key(type_key)),
  CONSTRAINT commerce_unit_type_retirement_origin_known
    CHECK (retired_by_kind IN ('human', 'system')),
  CONSTRAINT commerce_unit_type_retirement_reason_present
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  CONSTRAINT commerce_unit_type_retirement_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT commerce_unit_type_retirement_id_opaque
    CHECK (kernel_commerce_unit_registry.is_opaque_identifier(retirement_id)),
  CONSTRAINT commerce_unit_type_retirement_actor_opaque
    CHECK (kernel_commerce_unit_registry.is_opaque_identifier(retired_by_id)),
  CONSTRAINT commerce_unit_type_retirement_idempotency_opaque
    CHECK (kernel_commerce_unit_registry.is_opaque_identifier(idempotency_key)),
  CONSTRAINT commerce_unit_type_retirement_retired_at_finite
    CHECK (retired_at > '-infinity'::timestamptz AND retired_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_commerce_unit_registry.commerce_unit_type_retirement IS
  'The end of a type key. Stops new listings; never removes the versions existing listings reference.';

-- Publication reads the highest version for a key; resolution reads the whole in-force set and
-- walks the parent chain in memory.
CREATE INDEX IF NOT EXISTS commerce_unit_type_version_key_idx
  ON kernel_commerce_unit_registry.commerce_unit_type_version (type_key, version DESC);

CREATE INDEX IF NOT EXISTS commerce_unit_type_version_parent_idx
  ON kernel_commerce_unit_registry.commerce_unit_type_version (parent_type_key)
  WHERE parent_type_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly moves a subtree under a different risk pack, and the DELETE that removes the definition
-- a live listing still refers to.
CREATE OR REPLACE FUNCTION kernel_commerce_unit_registry.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'commerce unit registry history is append-only: % on % is refused. Change a type by publishing a new version and activating it',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_commerce_unit_registry.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER commerce_unit_type_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_commerce_unit_registry.commerce_unit_type_version
  FOR EACH ROW EXECUTE FUNCTION kernel_commerce_unit_registry.refuse_mutation();

CREATE TRIGGER commerce_unit_type_activation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_commerce_unit_registry.commerce_unit_type_activation
  FOR EACH ROW EXECUTE FUNCTION kernel_commerce_unit_registry.refuse_mutation();

CREATE TRIGGER commerce_unit_type_retirement_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_commerce_unit_registry.commerce_unit_type_retirement
  FOR EACH ROW EXECUTE FUNCTION kernel_commerce_unit_registry.refuse_mutation();

COMMIT;
