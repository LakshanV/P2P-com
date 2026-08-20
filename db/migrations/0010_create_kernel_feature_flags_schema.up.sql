-- migration: 0010_create_kernel_feature_flags_schema
-- direction: up
-- owner: kernel_feature_flags
--
-- K-07 Feature Flags' own namespace and its three tables (FND-004e).
--
-- **Everything in this schema is append-only.** There is no UPDATE path and no DELETE path for a
-- flag version, an activation or a lifecycle event. Three triggers refuse both operations outright.
--
-- The reason is what somebody asks after an incident. Not "what is this flag set to" — that is
-- answerable from anything — but "what was it doing at 14:05, who changed it, and when did the
-- change take effect". A definition edited in place answers the first and destroys the second, and
-- the flags v3 §36 exists for are the ones on autonomous purchasing, AI negotiation and referral
-- payouts, where that second question is the entire investigation.
--
-- Three tables:
--
--   * `feature_flag_version` — an immutable numbered definition of one flag: its state, the scope
--     levels it may be evaluated at, its targeting rules, its rollout percentage and salt, and its
--     bounded activation window. A change is a new version with a higher number.
--   * `feature_flag_activation` — which version is current, as an append-only **chain**: each row
--     names the version it supersedes. The current version is the row nothing else supersedes, and
--     two partial unique indexes make "two versions took effect at once" impossible rather than
--     merely unlikely.
--   * `feature_flag_lifecycle` — the two terminal facts, `kill` and `retire`, at most one of each
--     per flag key. A kill is the emergency stop of v3 §36 and outranks every version; a second
--     one would rewrite when the feature actually stopped.
--
-- There is deliberately **no evaluation table**. A permission decision is rare and consequential,
-- so K-04 records every one; a flag is evaluated on every request through every guarded path, and
-- a row per evaluation would be a write-amplification defect wearing a compliance costume. What
-- makes an evaluation accountable is that it is pure and reproducible from the rows here.
--
-- `flag_key`, scope ids and subject keys carry no foreign key into any other schema, for the
-- reason set out in migration 0007: a cross-schema key makes two components one object that cannot
-- be migrated or rolled back independently. K-07 references nothing else at all — no subject, no
-- account, no policy version — which is what keeps a deployment control from becoming a party
-- record.
--
-- `is_opaque_identifier` is K-07's own copy of the rule set K-01, K-02, K-03 and K-04 also carry,
-- in K-07's schema, for the same ownership reason. All five bodies are required to be
-- character-for-character identical by `tests/feature-flags-repository.test.ts`.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_feature_flags;

COMMENT ON SCHEMA kernel_feature_flags IS
  'K-07 Feature Flags. Append-only flag versions, activations and kill/retire events. A flag says whether code is running; never whether something is permitted, owed, priced or assigned.';

-- Character-for-character identical to kernel_identity.is_opaque_identifier,
-- kernel_authentication.is_opaque_identifier, kernel_accounts.is_opaque_identifier and
-- kernel_permissions.is_opaque_identifier, and required to stay so by test.
CREATE OR REPLACE FUNCTION kernel_feature_flags.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION kernel_feature_flags.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- A flag key is a dotted namespace, not an opaque handle: an operator reading a list of flags has
-- to be able to tell which part of the platform each one stops.
CREATE OR REPLACE FUNCTION kernel_feature_flags.is_flag_key(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $keys$
  SELECT
        value ~ '^[a-z][a-z0-9-]{1,30}(\.[a-z][a-z0-9-]{1,30}){1,3}$'
    -- A flag is a deployment control. These fragments name decisions other components own, and a
    -- flag wired to one of them would be an authorisation, a price or an entitlement with no
    -- version, no audit trail and no way to revoke it. The service refuses these keys; so does the
    -- column, because the statement that matters is the one written around the service.
    AND value !~* '(permission|authoris|authoriz|rbac|abac|grant|role)'
    AND value !~* '(entitlement|entitled|subscription|plan|tier)'
    AND value !~* '(price|pricing|fee|commission|payout|ledger|refund|settlement|tax)'
    AND value !~* '(experiment|ab-test|abtest|variant|holdout)'
    AND value !~* '(ai-authority|agent-authority|autonomy-level|ai-approval)'
$keys$;

COMMENT ON FUNCTION kernel_feature_flags.is_flag_key(text) IS
  'True when the value is a well-formed flag key that does not name authority, money, entitlement, an experiment or AI autonomy.';

-- ---------------------------------------------------------------------------
-- Versions: immutable, numbered per flag, and the only place a definition lives
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_feature_flags.feature_flag_version (
  flag_version_id     text        NOT NULL,
  flag_key            text        NOT NULL,
  version             integer     NOT NULL,
  state               text        NOT NULL,
  supported_scopes    jsonb       NOT NULL,
  rules               jsonb       NOT NULL,
  percentage          integer     NOT NULL,
  rollout_salt        text        NOT NULL,
  not_before          timestamptz,
  not_after           timestamptz,
  published_at        timestamptz NOT NULL,
  published_by_kind   text        NOT NULL,
  published_by_id     text        NOT NULL,
  idempotency_key     text        NOT NULL,
  request_fingerprint text        NOT NULL,

  CONSTRAINT feature_flag_version_pkey PRIMARY KEY (flag_version_id),

  -- One row per version number within a flag. Two rows claiming version 7 of the same flag would
  -- make "the definition of the day" ambiguous for every evaluation replayed against it.
  CONSTRAINT feature_flag_version_number_unique UNIQUE (flag_key, version),
  CONSTRAINT feature_flag_version_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT feature_flag_version_number_positive CHECK (version >= 1),
  CONSTRAINT feature_flag_version_key_shape
    CHECK (kernel_feature_flags.is_flag_key(flag_key)),
  CONSTRAINT feature_flag_version_state_known
    CHECK (state IN ('off', 'internal-only', 'targeted', 'percentage', 'on')),
  -- No AI author. A flag turns code paths on and off across the whole deployment, and v3 §38 keeps
  -- that behind a human decision.
  CONSTRAINT feature_flag_version_origin_known
    CHECK (published_by_kind IN ('human', 'system')),
  CONSTRAINT feature_flag_version_percentage_range
    CHECK (percentage >= 0 AND percentage <= 100),
  -- A state carries only the fields it uses. Rules on a percentage flag, or a percentage on an off
  -- one, are settings somebody believes are in force and nothing reads.
  CONSTRAINT feature_flag_version_percentage_only_when_rolling
    CHECK (state = 'percentage' OR percentage = 0),
  CONSTRAINT feature_flag_version_rules_only_when_targeted
    CHECK (
      CASE WHEN state = 'targeted'
        THEN jsonb_array_length(rules) >= 1
        ELSE jsonb_array_length(rules) = 0
      END
    ),
  CONSTRAINT feature_flag_version_scopes_shape
    CHECK (jsonb_typeof(supported_scopes) = 'array' AND jsonb_array_length(supported_scopes) >= 1),
  CONSTRAINT feature_flag_version_rules_shape
    CHECK (jsonb_typeof(rules) = 'array'),
  -- A window that contains no instant is a permanently-off flag whose definition says it is
  -- scheduled, which is the most misleading state this table could hold.
  CONSTRAINT feature_flag_version_window_ordered
    CHECK (not_before IS NULL OR not_after IS NULL OR not_after > not_before),
  CONSTRAINT feature_flag_version_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT feature_flag_version_id_opaque
    CHECK (kernel_feature_flags.is_opaque_identifier(flag_version_id)),
  CONSTRAINT feature_flag_version_salt_opaque
    CHECK (kernel_feature_flags.is_opaque_identifier(rollout_salt)),
  CONSTRAINT feature_flag_version_publisher_opaque
    CHECK (kernel_feature_flags.is_opaque_identifier(published_by_id)),
  CONSTRAINT feature_flag_version_idempotency_opaque
    CHECK (kernel_feature_flags.is_opaque_identifier(idempotency_key)),
  CONSTRAINT feature_flag_version_published_at_finite
    CHECK (published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz),
  CONSTRAINT feature_flag_version_not_before_finite
    CHECK (not_before IS NULL OR (not_before > '-infinity'::timestamptz AND not_before < 'infinity'::timestamptz)),
  CONSTRAINT feature_flag_version_not_after_finite
    CHECK (not_after IS NULL OR (not_after > '-infinity'::timestamptz AND not_after < 'infinity'::timestamptz))
);

COMMENT ON TABLE kernel_feature_flags.feature_flag_version IS
  'Immutable numbered flag definitions. A change is a new version, never an edit, so an evaluation can be replayed as it stood.';

COMMENT ON COLUMN kernel_feature_flags.feature_flag_version.rollout_salt IS
  'Hashed with the flag key and the subject key to pick a bucket, so two flags at 10% do not select the same tenth of the population.';

-- ---------------------------------------------------------------------------
-- Activations: an append-only chain, so two versions can never both be current
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_feature_flags.feature_flag_activation (
  activation_id         text        NOT NULL,
  flag_key              text        NOT NULL,
  flag_version_id       text        NOT NULL,
  supersedes_version_id text,
  activated_at          timestamptz NOT NULL,
  activated_by_kind     text        NOT NULL,
  activated_by_id       text        NOT NULL,
  idempotency_key       text        NOT NULL,
  request_fingerprint   text        NOT NULL,

  CONSTRAINT feature_flag_activation_pkey PRIMARY KEY (activation_id),
  CONSTRAINT feature_flag_activation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT feature_flag_activation_key_shape
    CHECK (kernel_feature_flags.is_flag_key(flag_key)),
  CONSTRAINT feature_flag_activation_origin_known
    CHECK (activated_by_kind IN ('human', 'system')),
  -- An activation that supersedes itself records no transition at all.
  CONSTRAINT feature_flag_activation_moves
    CHECK (supersedes_version_id IS NULL OR supersedes_version_id <> flag_version_id),
  CONSTRAINT feature_flag_activation_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT feature_flag_activation_id_opaque
    CHECK (kernel_feature_flags.is_opaque_identifier(activation_id)),
  CONSTRAINT feature_flag_activation_version_opaque
    CHECK (kernel_feature_flags.is_opaque_identifier(flag_version_id)),
  CONSTRAINT feature_flag_activation_supersedes_opaque
    CHECK (supersedes_version_id IS NULL OR kernel_feature_flags.is_opaque_identifier(supersedes_version_id)),
  CONSTRAINT feature_flag_activation_actor_opaque
    CHECK (kernel_feature_flags.is_opaque_identifier(activated_by_id)),
  CONSTRAINT feature_flag_activation_idempotency_opaque
    CHECK (kernel_feature_flags.is_opaque_identifier(idempotency_key)),
  CONSTRAINT feature_flag_activation_activated_at_finite
    CHECK (activated_at > '-infinity'::timestamptz AND activated_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_feature_flags.feature_flag_activation IS
  'Which version is current, as an append-only chain. The current version is the one nothing supersedes; ordering is the chain, never the clock.';

-- The guard, in the database rather than only in the service. Two operators reacting to the same
-- incident read the same current version and both activate; without this the flag's history says
-- two versions took effect at once, with no way to tell which one served traffic.
CREATE UNIQUE INDEX IF NOT EXISTS feature_flag_activation_supersedes_unique
  ON kernel_feature_flags.feature_flag_activation (flag_key, supersedes_version_id)
  WHERE supersedes_version_id IS NOT NULL;

-- And the same rule for the first activation, which supersedes nothing. A partial index is needed
-- because NULLs do not conflict in a plain unique constraint, so two "first" activations would
-- both be accepted.
CREATE UNIQUE INDEX IF NOT EXISTS feature_flag_activation_first_unique
  ON kernel_feature_flags.feature_flag_activation (flag_key)
  WHERE supersedes_version_id IS NULL;

-- ---------------------------------------------------------------------------
-- Lifecycle: the emergency stop, and the orderly end
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_feature_flags.feature_flag_lifecycle (
  event_id            text        NOT NULL,
  flag_key            text        NOT NULL,
  kind                text        NOT NULL,
  reason              text        NOT NULL,
  recorded_at         timestamptz NOT NULL,
  recorded_by_kind    text        NOT NULL,
  recorded_by_id      text        NOT NULL,
  idempotency_key     text        NOT NULL,
  request_fingerprint text        NOT NULL,

  CONSTRAINT feature_flag_lifecycle_pkey PRIMARY KEY (event_id),

  -- One lifecycle event per flag, for good — not one per kind. A second would rewrite when the
  -- feature actually stopped, which is the question an incident review asks first, and a flag
  -- carrying both a kill and a retirement is a history with two answers to it. The service refuses
  -- the second sequentially; this is what refuses it when two operators overlap.
  CONSTRAINT feature_flag_lifecycle_flag_unique UNIQUE (flag_key),
  CONSTRAINT feature_flag_lifecycle_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT feature_flag_lifecycle_key_shape
    CHECK (kernel_feature_flags.is_flag_key(flag_key)),
  CONSTRAINT feature_flag_lifecycle_kind_known CHECK (kind IN ('kill', 'retire')),
  CONSTRAINT feature_flag_lifecycle_origin_known
    CHECK (recorded_by_kind IN ('human', 'system')),
  -- Stopping a feature without recording why leaves the next operator guessing whether it is safe
  -- to turn back on, which during an incident is the most expensive kind of missing sentence.
  CONSTRAINT feature_flag_lifecycle_reason_present
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 500),
  CONSTRAINT feature_flag_lifecycle_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT feature_flag_lifecycle_id_opaque
    CHECK (kernel_feature_flags.is_opaque_identifier(event_id)),
  CONSTRAINT feature_flag_lifecycle_actor_opaque
    CHECK (kernel_feature_flags.is_opaque_identifier(recorded_by_id)),
  CONSTRAINT feature_flag_lifecycle_idempotency_opaque
    CHECK (kernel_feature_flags.is_opaque_identifier(idempotency_key)),
  CONSTRAINT feature_flag_lifecycle_recorded_at_finite
    CHECK (recorded_at > '-infinity'::timestamptz AND recorded_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_feature_flags.feature_flag_lifecycle IS
  'Kill and retire events. A kill is the emergency stop of v3 §36 and outranks every published version; neither is reversible here.';

-- Evaluation reads every version for a key, then the current activation, then the lifecycle rows.
CREATE INDEX IF NOT EXISTS feature_flag_version_key_idx
  ON kernel_feature_flags.feature_flag_version (flag_key, version DESC);

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a rollout, and the DELETE that removes the evidence a flag was ever killed.
CREATE OR REPLACE FUNCTION kernel_feature_flags.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'feature flag history is append-only: % on % is refused. Change a flag by publishing a new version and activating it',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_feature_flags.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER feature_flag_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_feature_flags.feature_flag_version
  FOR EACH ROW EXECUTE FUNCTION kernel_feature_flags.refuse_mutation();

CREATE TRIGGER feature_flag_activation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_feature_flags.feature_flag_activation
  FOR EACH ROW EXECUTE FUNCTION kernel_feature_flags.refuse_mutation();

CREATE TRIGGER feature_flag_lifecycle_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_feature_flags.feature_flag_lifecycle
  FOR EACH ROW EXECUTE FUNCTION kernel_feature_flags.refuse_mutation();

COMMIT;
