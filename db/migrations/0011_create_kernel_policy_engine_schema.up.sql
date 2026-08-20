-- migration: 0011_create_kernel_policy_engine_schema
-- direction: up
-- owner: kernel_policy_engine
--
-- K-06 Policy Engine's own namespace and its four tables (FND-005b).
--
-- **Everything in this schema is append-only.** There is no UPDATE path and no DELETE path for a
-- draft, a version, an activation or a retirement. Four triggers refuse both operations outright.
--
-- v3 §24 states the reason in one sentence: *changing future policy must not rewrite historical
-- economics.* Every transaction stores the policy version applied at purchase time, and that id is
-- a promise the version can still be read and still says what it said. An UPDATE on a rule row
-- breaks that promise for every decision ever pinned to it — silently, retroactively, and with no
-- reconciliation that would ever find it.
--
-- Four tables:
--
--   * `policy_draft` — a candidate nobody can evaluate. Fully validated so review happens against
--     something well-formed, and immutable so the thing published is the thing reviewed.
--   * `policy_version` — an immutable numbered version: the output schema, the rules, the declared
--     defaults, and its bounded effective window. Numbered per policy key.
--   * `policy_activation` — which version is in force, as an append-only **chain**: each row names
--     the version it supersedes. Two partial unique indexes make "two versions were authoritative
--     at once" impossible rather than merely unlikely.
--   * `policy_retirement` — the end of a policy's life, at most one per key. It stops new
--     evaluations; it does not remove the versions historic decisions are pinned to.
--
-- **Every decimal is stored inside `jsonb` in its exact `{ units, scale }` form.** There is no
-- `double precision` column in this schema and there never will be: a rate held as a float is a
-- commission that is a penny out for reasons nobody can reconstruct, and this schema's rows are
-- what a historic transaction is explained by.
--
-- There is deliberately **no decision table**. K-06 evaluates on the path of every priced
-- transaction, and a row per evaluation would be a write there. What makes a decision accountable
-- is that the caller stores the `policy_version_id` in *its own* record — the ledger entry, the
-- order — and that this version remains readable forever.
--
-- Seller, category, country and tier handles carry no foreign key into any other schema, for the
-- reason set out in migration 0007: a cross-schema key makes two components one object that cannot
-- be migrated or rolled back independently. K-06 references nothing else at all.
--
-- `is_opaque_identifier` is K-06's own copy of the rule set K-01, K-02, K-03, K-04 and K-07 also
-- carry, in K-06's schema, for the same ownership reason. All six bodies are required to be
-- character-for-character identical by `tests/policy-engine-repository.test.ts`.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_policy_engine;

COMMENT ON SCHEMA kernel_policy_engine IS
  'K-06 Policy Engine. Append-only policy drafts, versions, activations and retirements. Every evaluation returns the version id a historic transaction pins.';

-- Character-for-character identical to kernel_identity.is_opaque_identifier,
-- kernel_authentication.is_opaque_identifier, kernel_accounts.is_opaque_identifier,
-- kernel_permissions.is_opaque_identifier and kernel_feature_flags.is_opaque_identifier, and
-- required to stay so by test.
CREATE OR REPLACE FUNCTION kernel_policy_engine.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION kernel_policy_engine.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- A policy key is a dotted namespace, not an opaque handle: somebody auditing a historic decision
-- has to be able to tell which part of the business the pinned version belongs to.
CREATE OR REPLACE FUNCTION kernel_policy_engine.is_policy_key(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $keys$
  SELECT
        value ~ '^[a-z][a-z0-9-]{1,30}(\.[a-z][a-z0-9-]{1,30}){1,3}$'
    -- K-06 holds business policy: what the commission is, how long proceeds are held, what the
    -- reserve percentage is. Authority, deployment state and credentials are none of those, and a
    -- policy key naming one would be that component rebuilt with no revocation. The service
    -- refuses these keys; so does the column, because the statement that matters is the one
    -- written around the service.
    AND value !~* '(permission|authoris|authoriz|rbac|abac|grant|role)'
    AND value !~* '(feature-flag|featureflag|rollout|kill-switch|release-toggle)'
    AND value !~* '(credential|password|session|token|mfa)'
$keys$;

COMMENT ON FUNCTION kernel_policy_engine.is_policy_key(text) IS
  'True when the value is a well-formed policy key that does not name authority, deployment state or credentials.';

-- ---------------------------------------------------------------------------
-- Drafts: reviewed before they are published, and never edited after review
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_policy_engine.policy_draft (
  draft_id            text        NOT NULL,
  policy_key          text        NOT NULL,
  output_schema       jsonb       NOT NULL,
  rules               jsonb       NOT NULL,
  default_outputs     jsonb,
  notes               text        NOT NULL,
  drafted_at          timestamptz NOT NULL,
  drafted_by_kind     text        NOT NULL,
  drafted_by_id       text        NOT NULL,
  idempotency_key     text        NOT NULL,
  request_fingerprint text        NOT NULL,

  CONSTRAINT policy_draft_pkey PRIMARY KEY (draft_id),
  CONSTRAINT policy_draft_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT policy_draft_key_shape CHECK (kernel_policy_engine.is_policy_key(policy_key)),
  -- No AI author. v3 §38 says AI must never be the financial authority, and the commission rate is
  -- exactly that authority written down.
  CONSTRAINT policy_draft_origin_known CHECK (drafted_by_kind IN ('human', 'system')),
  CONSTRAINT policy_draft_rules_shape
    CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) >= 1),
  CONSTRAINT policy_draft_schema_shape CHECK (jsonb_typeof(output_schema) = 'object'),
  CONSTRAINT policy_draft_defaults_shape
    CHECK (default_outputs IS NULL OR jsonb_typeof(default_outputs) = 'object'),
  CONSTRAINT policy_draft_notes_bounded CHECK (length(notes) <= 2000),
  CONSTRAINT policy_draft_fingerprint_shape CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT policy_draft_id_opaque CHECK (kernel_policy_engine.is_opaque_identifier(draft_id)),
  CONSTRAINT policy_draft_author_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(drafted_by_id)),
  CONSTRAINT policy_draft_idempotency_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(idempotency_key)),
  CONSTRAINT policy_draft_drafted_at_finite
    CHECK (drafted_at > '-infinity'::timestamptz AND drafted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_policy_engine.policy_draft IS
  'Candidate policies. Immutable, so what is published is what was reviewed; never evaluated, so no decision is taken against something still being edited.';

-- ---------------------------------------------------------------------------
-- Versions: immutable, numbered per policy, and what a transaction pins
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_policy_engine.policy_version (
  policy_version_id   text        NOT NULL,
  policy_key          text        NOT NULL,
  version             integer     NOT NULL,
  draft_id            text        NOT NULL,
  output_schema       jsonb       NOT NULL,
  rules               jsonb       NOT NULL,
  default_outputs     jsonb,
  effective_from      timestamptz,
  effective_until     timestamptz,
  published_at        timestamptz NOT NULL,
  published_by_kind   text        NOT NULL,
  published_by_id     text        NOT NULL,
  idempotency_key     text        NOT NULL,
  request_fingerprint text        NOT NULL,

  CONSTRAINT policy_version_pkey PRIMARY KEY (policy_version_id),

  -- One row per version number within a policy. Two rows claiming version 7 would make "the policy
  -- of the day" ambiguous for every transaction that pinned it.
  CONSTRAINT policy_version_number_unique UNIQUE (policy_key, version),
  CONSTRAINT policy_version_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT policy_version_number_positive CHECK (version >= 1),
  CONSTRAINT policy_version_key_shape CHECK (kernel_policy_engine.is_policy_key(policy_key)),
  CONSTRAINT policy_version_origin_known CHECK (published_by_kind IN ('human', 'system')),
  CONSTRAINT policy_version_rules_shape
    CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) >= 1),
  CONSTRAINT policy_version_schema_shape CHECK (jsonb_typeof(output_schema) = 'object'),
  CONSTRAINT policy_version_defaults_shape
    CHECK (default_outputs IS NULL OR jsonb_typeof(default_outputs) = 'object'),
  -- A window that contains no instant is a version that can never decide anything while reading as
  -- though it were scheduled, which is the most misleading state this table could hold.
  CONSTRAINT policy_version_window_ordered
    CHECK (effective_from IS NULL OR effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT policy_version_fingerprint_shape CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT policy_version_id_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(policy_version_id)),
  CONSTRAINT policy_version_draft_opaque CHECK (kernel_policy_engine.is_opaque_identifier(draft_id)),
  CONSTRAINT policy_version_publisher_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(published_by_id)),
  CONSTRAINT policy_version_idempotency_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(idempotency_key)),
  CONSTRAINT policy_version_published_at_finite
    CHECK (published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz),
  CONSTRAINT policy_version_effective_from_finite
    CHECK (effective_from IS NULL OR (effective_from > '-infinity'::timestamptz AND effective_from < 'infinity'::timestamptz)),
  CONSTRAINT policy_version_effective_until_finite
    CHECK (effective_until IS NULL OR (effective_until > '-infinity'::timestamptz AND effective_until < 'infinity'::timestamptz))
);

COMMENT ON TABLE kernel_policy_engine.policy_version IS
  'Immutable numbered policy versions. A change is a new version, never an edit: v3 §24 requires that changing future policy not rewrite historical economics.';

COMMENT ON COLUMN kernel_policy_engine.policy_version.rules IS
  'Rules, with every rate and threshold as an exact { units, scale } decimal. No column in this schema is a float.';

-- ---------------------------------------------------------------------------
-- Activations: an append-only chain, so two versions cannot both be in force
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_policy_engine.policy_activation (
  activation_id         text        NOT NULL,
  policy_key            text        NOT NULL,
  policy_version_id     text        NOT NULL,
  supersedes_version_id text,
  activated_at          timestamptz NOT NULL,
  activated_by_kind     text        NOT NULL,
  activated_by_id       text        NOT NULL,
  idempotency_key       text        NOT NULL,
  request_fingerprint   text        NOT NULL,

  CONSTRAINT policy_activation_pkey PRIMARY KEY (activation_id),
  CONSTRAINT policy_activation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT policy_activation_key_shape CHECK (kernel_policy_engine.is_policy_key(policy_key)),
  CONSTRAINT policy_activation_origin_known CHECK (activated_by_kind IN ('human', 'system')),
  CONSTRAINT policy_activation_moves
    CHECK (supersedes_version_id IS NULL OR supersedes_version_id <> policy_version_id),
  CONSTRAINT policy_activation_fingerprint_shape CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT policy_activation_id_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(activation_id)),
  CONSTRAINT policy_activation_version_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(policy_version_id)),
  CONSTRAINT policy_activation_supersedes_opaque
    CHECK (supersedes_version_id IS NULL OR kernel_policy_engine.is_opaque_identifier(supersedes_version_id)),
  CONSTRAINT policy_activation_actor_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(activated_by_id)),
  CONSTRAINT policy_activation_idempotency_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(idempotency_key)),
  CONSTRAINT policy_activation_activated_at_finite
    CHECK (activated_at > '-infinity'::timestamptz AND activated_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_policy_engine.policy_activation IS
  'Which version is in force, as an append-only chain. The version in force is the one nothing supersedes; ordering is the chain, never the clock.';

-- The guard, in the database rather than only in the service. Two operators acting on the same
-- commercial decision read the same version in force and both activate; without this the history
-- says two versions were authoritative at once, with no way to tell which priced what.
CREATE UNIQUE INDEX IF NOT EXISTS policy_activation_supersedes_unique
  ON kernel_policy_engine.policy_activation (policy_key, supersedes_version_id)
  WHERE supersedes_version_id IS NOT NULL;

-- And the same rule for the first activation, which supersedes nothing. A partial index is needed
-- because NULLs do not conflict in a plain unique constraint, so two "first" activations would
-- both be accepted.
CREATE UNIQUE INDEX IF NOT EXISTS policy_activation_first_unique
  ON kernel_policy_engine.policy_activation (policy_key)
  WHERE supersedes_version_id IS NULL;

-- ---------------------------------------------------------------------------
-- Retirement: the end of a policy's life, without erasing its history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_policy_engine.policy_retirement (
  retirement_id       text        NOT NULL,
  policy_key          text        NOT NULL,
  reason              text        NOT NULL,
  retired_at          timestamptz NOT NULL,
  retired_by_kind     text        NOT NULL,
  retired_by_id       text        NOT NULL,
  idempotency_key     text        NOT NULL,
  request_fingerprint text        NOT NULL,

  CONSTRAINT policy_retirement_pkey PRIMARY KEY (retirement_id),

  -- One retirement per policy, for good. A second would rewrite when the policy actually stopped
  -- applying, which is what a historic decision is checked against.
  CONSTRAINT policy_retirement_policy_unique UNIQUE (policy_key),
  CONSTRAINT policy_retirement_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT policy_retirement_key_shape CHECK (kernel_policy_engine.is_policy_key(policy_key)),
  CONSTRAINT policy_retirement_origin_known CHECK (retired_by_kind IN ('human', 'system')),
  CONSTRAINT policy_retirement_reason_present
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  CONSTRAINT policy_retirement_fingerprint_shape CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT policy_retirement_id_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(retirement_id)),
  CONSTRAINT policy_retirement_actor_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(retired_by_id)),
  CONSTRAINT policy_retirement_idempotency_opaque
    CHECK (kernel_policy_engine.is_opaque_identifier(idempotency_key)),
  CONSTRAINT policy_retirement_retired_at_finite
    CHECK (retired_at > '-infinity'::timestamptz AND retired_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_policy_engine.policy_retirement IS
  'The end of a policy key. Stops new evaluations; never removes the versions historic decisions are pinned to.';

-- Publication reads the highest version for a key; evaluation reads the version in force.
CREATE INDEX IF NOT EXISTS policy_version_key_idx
  ON kernel_policy_engine.policy_version (policy_key, version DESC);

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly changes a commission rate under transactions already priced by it.
CREATE OR REPLACE FUNCTION kernel_policy_engine.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'policy history is append-only: % on % is refused. Change a policy by drafting, publishing and activating a new version',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_policy_engine.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER policy_draft_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_policy_engine.policy_draft
  FOR EACH ROW EXECUTE FUNCTION kernel_policy_engine.refuse_mutation();

CREATE TRIGGER policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_policy_engine.policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_policy_engine.refuse_mutation();

CREATE TRIGGER policy_activation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_policy_engine.policy_activation
  FOR EACH ROW EXECUTE FUNCTION kernel_policy_engine.refuse_mutation();

CREATE TRIGGER policy_retirement_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_policy_engine.policy_retirement
  FOR EACH ROW EXECUTE FUNCTION kernel_policy_engine.refuse_mutation();

COMMIT;
