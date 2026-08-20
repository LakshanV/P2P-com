-- migration: 0009_create_kernel_permissions_schema
-- direction: up
-- owner: kernel_permissions
--
-- K-04 Permissions' own namespace and its four tables (FND-004d).
--
-- **Everything in this schema is append-only, and that is stronger than write-once.** There is no
-- UPDATE path and no DELETE path for any of the four tables: not for a policy version, not for a
-- grant, not for a revocation, not for a decision. Four triggers refuse both operations outright.
--
-- The reason is what an auditor actually asks. Not "who may do this" — that is answerable from a
-- mutable table — but "who *could* have done this, in March, and who said so". An edited grant
-- answers the first and destroys the second. Withdrawal is therefore an appended revocation, which
-- is a fact with a time and a reason, rather than a removed row, which is the absence of a fact.
--
-- Four tables:
--
--   * `permission_policy_version` — an immutable numbered snapshot of what each role may do. A
--     change is a new version with a higher number; `version` is unique so history cannot fork.
--   * `permission_grant` — one explicit allow or deny, scoped to an account, a resource and an
--     action, optionally conditioned and optionally purpose-limited. A grant records the policy
--     version it was made under, so a decision can be replayed against the policy of the day.
--   * `permission_revocation` — one per grant, enforced by a unique constraint. A second
--     revocation would rewrite when authority actually ended.
--   * `permission_decision` — what was decided and **why**. The explanation is a column, not a log
--     line, because a denial nobody can explain is one nobody can appeal.
--
-- `subject_id` and `account_id` carry no foreign key into `kernel_identity` or `kernel_accounts`,
-- for the reason set out in migration 0007: a cross-schema key makes two components one object
-- that cannot be migrated or rolled back independently. Referential validity is checked through
-- K-01's and K-03's public contracts before a write, and the cost — no database-level guarantee —
-- is stated in K-04's contract rather than glossed.
--
-- `is_opaque_identifier` is K-04's own copy of the rule set K-01, K-02 and K-03 also carry, in
-- K-04's schema, for the same ownership reason. All four bodies are required to be
-- character-for-character identical by `tests/permissions-repository.test.ts`.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS kernel_permissions;

COMMENT ON SCHEMA kernel_permissions IS
  'K-04 Permissions. Append-only policy versions, grants, revocations and decision records. Deny by default; no row here is ever updated or deleted.';

-- Character-for-character identical to kernel_identity.is_opaque_identifier,
-- kernel_authentication.is_opaque_identifier and kernel_accounts.is_opaque_identifier, and
-- required to stay so by test.
CREATE OR REPLACE FUNCTION kernel_permissions.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION kernel_permissions.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- ---------------------------------------------------------------------------
-- Policy versions: immutable, numbered, and the only place a role means anything
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_policy_version (
  policy_version_id  text        NOT NULL,
  version            integer     NOT NULL,
  roles              jsonb       NOT NULL,
  published_at       timestamptz NOT NULL,
  published_by_kind  text        NOT NULL,
  published_by_id    text        NOT NULL,
  bootstrap          boolean     NOT NULL,
  idempotency_key    text        NOT NULL,
  request_fingerprint text       NOT NULL,

  CONSTRAINT permission_policy_version_pkey PRIMARY KEY (policy_version_id),

  -- One row per version number. Two rows claiming version 7 would make "the policy of the day"
  -- ambiguous for every decision recorded under it.
  CONSTRAINT permission_policy_version_number_unique UNIQUE (version),
  CONSTRAINT permission_policy_version_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_policy_version_number_positive CHECK (version >= 1),
  -- AI may not author authority. The service refuses it and so does the column, because the
  -- statement that matters is the one written around the service.
  CONSTRAINT permission_policy_version_origin_known
    CHECK (published_by_kind IN ('human', 'system')),
  -- A bootstrap version has no authenticated administrator, so its author is the bootstrap
  -- authority. A row claiming both that nobody was authenticated and that a human published it
  -- would be claiming two contradictory things about who installed the platform's first policy.
  CONSTRAINT permission_policy_version_bootstrap_is_system
    CHECK (NOT bootstrap OR published_by_kind = 'system'),
  CONSTRAINT permission_policy_version_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}
  CONSTRAINT permission_policy_version_roles_shape
    CHECK (jsonb_typeof(roles) = 'array' AND jsonb_array_length(roles) >= 1),
  CONSTRAINT permission_policy_version_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_policy_version_publisher_opaque
    CHECK (kernel_permissions.is_opaque_identifier(published_by_id)),
  CONSTRAINT permission_policy_version_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_policy_version_published_at_finite
    CHECK (published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_policy_version IS
  'Immutable numbered policy. A change is a new version, never an edit, so authority can be replayed as it stood.';

-- ---------------------------------------------------------------------------
-- Grants: explicit, scoped, and never rewritten
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_grant (
  grant_id           text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  role               text        NOT NULL,
  effect             text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  purpose            text,
  condition          jsonb,
  policy_version_id  text        NOT NULL,
  granted_at         timestamptz NOT NULL,
  not_before         timestamptz,
  expires_at         timestamptz,
  granted_by_kind    text        NOT NULL,
  granted_by_id      text        NOT NULL,
  idempotency_key    text        NOT NULL,
  request_fingerprint text       NOT NULL,

  CONSTRAINT permission_grant_pkey PRIMARY KEY (grant_id),
  CONSTRAINT permission_grant_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_grant_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_grant_role_known
    CHECK (role IN ('CUSTOMER', 'SUPPLIER', 'SERVICE_PROVIDER', 'DRIVER', 'STAFF', 'OPERATIONS',
                    'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN', 'AI_AGENT')),
  CONSTRAINT permission_grant_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  -- Purpose limitation, in the database. A staff role with no purpose is exactly the unpurposed
  -- staff access v3 5.3 forbids, and a non-staff role with one records a control that is not
  -- being enforced.
  CONSTRAINT permission_grant_staff_purpose
    CHECK (
      (role IN ('STAFF', 'OPERATIONS', 'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'))
      = (purpose IS NOT NULL)
    ),
  -- AI holds tool capabilities and nothing else, however the row was written.
  CONSTRAINT permission_grant_ai_tool_only
    CHECK (role <> 'AI_AGENT' OR (action = 'invoke-tool' AND resource_type = 'tool')),
  CONSTRAINT permission_grant_window_ordered
    CHECK (not_before IS NULL OR expires_at IS NULL OR expires_at > not_before),
  CONSTRAINT permission_grant_origin_known CHECK (granted_by_kind IN ('human', 'system')),
  -- The fingerprint over the administrator, session and account behind the grant, so a retry by
  -- somebody else is a different statement rather than a convergence.
  CONSTRAINT permission_grant_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}
  CONSTRAINT permission_grant_condition_shape
    CHECK (condition IS NULL OR jsonb_typeof(condition) = 'object'),
  CONSTRAINT permission_grant_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_grant_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_grant_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_grant_resource_opaque
    CHECK (resource_id IS NULL OR kernel_permissions.is_opaque_identifier(resource_id)),
  CONSTRAINT permission_grant_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_grant_grantor_opaque
    CHECK (kernel_permissions.is_opaque_identifier(granted_by_id)),
  CONSTRAINT permission_grant_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_grant_granted_at_finite
    CHECK (granted_at > '-infinity'::timestamptz AND granted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_grant IS
  'One explicit allow or deny, scoped to an account, a resource and an action. Never updated; withdrawn by an appended revocation.';

COMMENT ON COLUMN kernel_permissions.permission_grant.resource_id IS
  'One resource, or NULL for every resource of that type inside this account. There is no grant shape covering every account.';

-- At most one bootstrap policy version, ever. The service refuses a second because bootstrap is
-- only reachable when no policy exists; this is the same rule written where a hand-written INSERT
-- also meets it.
CREATE UNIQUE INDEX IF NOT EXISTS permission_policy_version_single_bootstrap_idx
  ON kernel_permissions.permission_policy_version ((true)) WHERE bootstrap;

COMMENT ON COLUMN kernel_permissions.permission_policy_version.bootstrap IS
  'True for the one policy version installed with no authenticated administrator. Append-only evidence that the first policy came from an operator, not a caller.';

CREATE INDEX IF NOT EXISTS permission_grant_subject_account_idx
  ON kernel_permissions.permission_grant (subject_id, account_id);

-- ---------------------------------------------------------------------------
-- Revocations: one per grant, and final
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_revocation (
  revocation_id    text        NOT NULL,
  grant_id         text        NOT NULL,
  revoked_at       timestamptz NOT NULL,
  reason           text        NOT NULL,
  revoked_by_kind  text        NOT NULL,
  revoked_by_id    text        NOT NULL,
  idempotency_key  text        NOT NULL,
  request_fingerprint text     NOT NULL,

  CONSTRAINT permission_revocation_pkey PRIMARY KEY (revocation_id),

  -- One revocation per grant. A second is not a stronger withdrawal; it is a rewrite of when
  -- authority ended, which is the fact the row exists to record.
  CONSTRAINT permission_revocation_grant_unique UNIQUE (grant_id),
  CONSTRAINT permission_revocation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_revocation_reason_known
    CHECK (reason IN ('granted-in-error', 'role-changed', 'access-no-longer-needed',
                      'security-event', 'policy-superseded')),
  CONSTRAINT permission_revocation_origin_known CHECK (revoked_by_kind IN ('human', 'system')),
  CONSTRAINT permission_revocation_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}
  CONSTRAINT permission_revocation_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revocation_id)),
  CONSTRAINT permission_revocation_grant_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_revocation_revoker_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revoked_by_id)),
  CONSTRAINT permission_revocation_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_revocation_revoked_at_finite
    CHECK (revoked_at > '-infinity'::timestamptz AND revoked_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_revocation IS
  'Withdrawal of a grant, as an appended fact with a time and a reason. One per grant, and final.';

-- ---------------------------------------------------------------------------
-- Decisions: what was decided, and why
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_decision (
  decision_id        text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  session_id         text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  effect             text        NOT NULL,
  reason             text        NOT NULL,
  explanation        text        NOT NULL,
  deciding_grant_id  text,
  policy_version_id  text        NOT NULL,
  purpose            text,
  decided_at         timestamptz NOT NULL,
  idempotency_key    text        NOT NULL,
  request_fingerprint text       NOT NULL,

  CONSTRAINT permission_decision_pkey PRIMARY KEY (decision_id),
  CONSTRAINT permission_decision_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_decision_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_decision_reason_known
    CHECK (reason IN ('no-matching-grant', 'explicit-deny', 'explicit-allow',
                      'condition-unsatisfied', 'outside-validity-window', 'grant-revoked',
                      'purpose-not-satisfied', 'not-permitted-by-policy')),
  -- An allow always names the grant that allowed it. An allow with no deciding grant would be an
  -- authorisation nobody can trace to a decision anybody made.
  CONSTRAINT permission_decision_allow_is_traceable
    CHECK (effect <> 'allow' OR deciding_grant_id IS NOT NULL),
  CONSTRAINT permission_decision_explained CHECK (length(btrim(explanation)) >= 10),
  -- The fingerprint over every input the decision depended on, including the session it was
  -- computed for and the ABAC context that satisfied it. A retry is answered from this row only
  -- when the fingerprint matches, so a stolen idempotency key buys nothing.
  CONSTRAINT permission_decision_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

COMMENT ON COLUMN kernel_permissions.permission_decision.request_fingerprint IS
  'SHA-256 over every decision-authoritative input, including the session and the ABAC context. A retry is answered from this row only when it matches.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_policy_version_roles_shape
    CHECK (jsonb_typeof(roles) = 'array' AND jsonb_array_length(roles) >= 1),
  CONSTRAINT permission_policy_version_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_policy_version_publisher_opaque
    CHECK (kernel_permissions.is_opaque_identifier(published_by_id)),
  CONSTRAINT permission_policy_version_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_policy_version_published_at_finite
    CHECK (published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_policy_version IS
  'Immutable numbered policy. A change is a new version, never an edit, so authority can be replayed as it stood.';

-- ---------------------------------------------------------------------------
-- Grants: explicit, scoped, and never rewritten
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_grant (
  grant_id           text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  role               text        NOT NULL,
  effect             text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  purpose            text,
  condition          jsonb,
  policy_version_id  text        NOT NULL,
  granted_at         timestamptz NOT NULL,
  not_before         timestamptz,
  expires_at         timestamptz,
  granted_by_kind    text        NOT NULL,
  granted_by_id      text        NOT NULL,
  idempotency_key    text        NOT NULL,

  CONSTRAINT permission_grant_pkey PRIMARY KEY (grant_id),
  CONSTRAINT permission_grant_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_grant_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_grant_role_known
    CHECK (role IN ('CUSTOMER', 'SUPPLIER', 'SERVICE_PROVIDER', 'DRIVER', 'STAFF', 'OPERATIONS',
                    'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN', 'AI_AGENT')),
  CONSTRAINT permission_grant_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  -- Purpose limitation, in the database. A staff role with no purpose is exactly the unpurposed
  -- staff access v3 5.3 forbids, and a non-staff role with one records a control that is not
  -- being enforced.
  CONSTRAINT permission_grant_staff_purpose
    CHECK (
      (role IN ('STAFF', 'OPERATIONS', 'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'))
      = (purpose IS NOT NULL)
    ),
  -- AI holds tool capabilities and nothing else, however the row was written.
  CONSTRAINT permission_grant_ai_tool_only
    CHECK (role <> 'AI_AGENT' OR (action = 'invoke-tool' AND resource_type = 'tool')),
  CONSTRAINT permission_grant_window_ordered
    CHECK (not_before IS NULL OR expires_at IS NULL OR expires_at > not_before),
  CONSTRAINT permission_grant_origin_known CHECK (granted_by_kind IN ('human', 'system')),
  CONSTRAINT permission_grant_condition_shape
    CHECK (condition IS NULL OR jsonb_typeof(condition) = 'object'),
  CONSTRAINT permission_grant_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_grant_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_grant_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_grant_resource_opaque
    CHECK (resource_id IS NULL OR kernel_permissions.is_opaque_identifier(resource_id)),
  CONSTRAINT permission_grant_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_grant_grantor_opaque
    CHECK (kernel_permissions.is_opaque_identifier(granted_by_id)),
  CONSTRAINT permission_grant_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_grant_granted_at_finite
    CHECK (granted_at > '-infinity'::timestamptz AND granted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_grant IS
  'One explicit allow or deny, scoped to an account, a resource and an action. Never updated; withdrawn by an appended revocation.';

COMMENT ON COLUMN kernel_permissions.permission_grant.resource_id IS
  'One resource, or NULL for every resource of that type inside this account. There is no grant shape covering every account.';

CREATE INDEX IF NOT EXISTS permission_grant_subject_account_idx
  ON kernel_permissions.permission_grant (subject_id, account_id);

-- ---------------------------------------------------------------------------
-- Revocations: one per grant, and final
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_revocation (
  revocation_id    text        NOT NULL,
  grant_id         text        NOT NULL,
  revoked_at       timestamptz NOT NULL,
  reason           text        NOT NULL,
  revoked_by_kind  text        NOT NULL,
  revoked_by_id    text        NOT NULL,
  idempotency_key  text        NOT NULL,

  CONSTRAINT permission_revocation_pkey PRIMARY KEY (revocation_id),

  -- One revocation per grant. A second is not a stronger withdrawal; it is a rewrite of when
  -- authority ended, which is the fact the row exists to record.
  CONSTRAINT permission_revocation_grant_unique UNIQUE (grant_id),
  CONSTRAINT permission_revocation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_revocation_reason_known
    CHECK (reason IN ('granted-in-error', 'role-changed', 'access-no-longer-needed',
                      'security-event', 'policy-superseded')),
  CONSTRAINT permission_revocation_origin_known CHECK (revoked_by_kind IN ('human', 'system')),
  CONSTRAINT permission_revocation_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revocation_id)),
  CONSTRAINT permission_revocation_grant_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_revocation_revoker_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revoked_by_id)),
  CONSTRAINT permission_revocation_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_revocation_revoked_at_finite
    CHECK (revoked_at > '-infinity'::timestamptz AND revoked_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_revocation IS
  'Withdrawal of a grant, as an appended fact with a time and a reason. One per grant, and final.';

-- ---------------------------------------------------------------------------
-- Decisions: what was decided, and why
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_decision (
  decision_id        text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  session_id         text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  effect             text        NOT NULL,
  reason             text        NOT NULL,
  explanation        text        NOT NULL,
  deciding_grant_id  text,
  policy_version_id  text        NOT NULL,
  purpose            text,
  decided_at         timestamptz NOT NULL,
  idempotency_key    text        NOT NULL,
  request_fingerprint text       NOT NULL,

  CONSTRAINT permission_decision_pkey PRIMARY KEY (decision_id),
  CONSTRAINT permission_decision_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_decision_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_decision_reason_known
    CHECK (reason IN ('no-matching-grant', 'explicit-deny', 'explicit-allow',
                      'condition-unsatisfied', 'outside-validity-window', 'grant-revoked',
                      'purpose-not-satisfied', 'not-permitted-by-policy')),
  -- An allow always names the grant that allowed it. An allow with no deciding grant would be an
  -- authorisation nobody can trace to a decision anybody made.
  CONSTRAINT permission_decision_allow_is_traceable
    CHECK (effect <> 'allow' OR deciding_grant_id IS NOT NULL),
  CONSTRAINT permission_decision_explained CHECK (length(btrim(explanation)) >= 10),
  -- The fingerprint over every input the decision depended on, including the session it was
  -- computed for and the ABAC context that satisfied it. A retry is answered from this row only
  -- when the fingerprint matches, so a stolen idempotency key buys nothing.
  CONSTRAINT permission_decision_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

COMMENT ON COLUMN kernel_permissions.permission_decision.request_fingerprint IS
  'SHA-256 over every decision-authoritative input, including the session and the ABAC context. A retry is answered from this row only when it matches.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_grant_condition_shape
    CHECK (condition IS NULL OR jsonb_typeof(condition) = 'object'),
  CONSTRAINT permission_grant_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_grant_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_grant_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_grant_resource_opaque
    CHECK (resource_id IS NULL OR kernel_permissions.is_opaque_identifier(resource_id)),
  CONSTRAINT permission_grant_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_grant_grantor_opaque
    CHECK (kernel_permissions.is_opaque_identifier(granted_by_id)),
  CONSTRAINT permission_grant_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_grant_granted_at_finite
    CHECK (granted_at > '-infinity'::timestamptz AND granted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_grant IS
  'One explicit allow or deny, scoped to an account, a resource and an action. Never updated; withdrawn by an appended revocation.';

COMMENT ON COLUMN kernel_permissions.permission_grant.resource_id IS
  'One resource, or NULL for every resource of that type inside this account. There is no grant shape covering every account.';

CREATE INDEX IF NOT EXISTS permission_grant_subject_account_idx
  ON kernel_permissions.permission_grant (subject_id, account_id);

-- ---------------------------------------------------------------------------
-- Revocations: one per grant, and final
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_revocation (
  revocation_id    text        NOT NULL,
  grant_id         text        NOT NULL,
  revoked_at       timestamptz NOT NULL,
  reason           text        NOT NULL,
  revoked_by_kind  text        NOT NULL,
  revoked_by_id    text        NOT NULL,
  idempotency_key  text        NOT NULL,

  CONSTRAINT permission_revocation_pkey PRIMARY KEY (revocation_id),

  -- One revocation per grant. A second is not a stronger withdrawal; it is a rewrite of when
  -- authority ended, which is the fact the row exists to record.
  CONSTRAINT permission_revocation_grant_unique UNIQUE (grant_id),
  CONSTRAINT permission_revocation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_revocation_reason_known
    CHECK (reason IN ('granted-in-error', 'role-changed', 'access-no-longer-needed',
                      'security-event', 'policy-superseded')),
  CONSTRAINT permission_revocation_origin_known CHECK (revoked_by_kind IN ('human', 'system')),
  CONSTRAINT permission_revocation_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revocation_id)),
  CONSTRAINT permission_revocation_grant_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_revocation_revoker_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revoked_by_id)),
  CONSTRAINT permission_revocation_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_revocation_revoked_at_finite
    CHECK (revoked_at > '-infinity'::timestamptz AND revoked_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_revocation IS
  'Withdrawal of a grant, as an appended fact with a time and a reason. One per grant, and final.';

-- ---------------------------------------------------------------------------
-- Decisions: what was decided, and why
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_decision (
  decision_id        text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  session_id         text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  effect             text        NOT NULL,
  reason             text        NOT NULL,
  explanation        text        NOT NULL,
  deciding_grant_id  text,
  policy_version_id  text        NOT NULL,
  purpose            text,
  decided_at         timestamptz NOT NULL,
  idempotency_key    text        NOT NULL,
  request_fingerprint text       NOT NULL,

  CONSTRAINT permission_decision_pkey PRIMARY KEY (decision_id),
  CONSTRAINT permission_decision_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_decision_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_decision_reason_known
    CHECK (reason IN ('no-matching-grant', 'explicit-deny', 'explicit-allow',
                      'condition-unsatisfied', 'outside-validity-window', 'grant-revoked',
                      'purpose-not-satisfied', 'not-permitted-by-policy')),
  -- An allow always names the grant that allowed it. An allow with no deciding grant would be an
  -- authorisation nobody can trace to a decision anybody made.
  CONSTRAINT permission_decision_allow_is_traceable
    CHECK (effect <> 'allow' OR deciding_grant_id IS NOT NULL),
  CONSTRAINT permission_decision_explained CHECK (length(btrim(explanation)) >= 10),
  -- The fingerprint over every input the decision depended on, including the session it was
  -- computed for and the ABAC context that satisfied it. A retry is answered from this row only
  -- when the fingerprint matches, so a stolen idempotency key buys nothing.
  CONSTRAINT permission_decision_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

COMMENT ON COLUMN kernel_permissions.permission_decision.request_fingerprint IS
  'SHA-256 over every decision-authoritative input, including the session and the ABAC context. A retry is answered from this row only when it matches.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_policy_version_roles_shape
    CHECK (jsonb_typeof(roles) = 'array' AND jsonb_array_length(roles) >= 1),
  CONSTRAINT permission_policy_version_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_policy_version_publisher_opaque
    CHECK (kernel_permissions.is_opaque_identifier(published_by_id)),
  CONSTRAINT permission_policy_version_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_policy_version_published_at_finite
    CHECK (published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_policy_version IS
  'Immutable numbered policy. A change is a new version, never an edit, so authority can be replayed as it stood.';

-- ---------------------------------------------------------------------------
-- Grants: explicit, scoped, and never rewritten
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_grant (
  grant_id           text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  role               text        NOT NULL,
  effect             text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  purpose            text,
  condition          jsonb,
  policy_version_id  text        NOT NULL,
  granted_at         timestamptz NOT NULL,
  not_before         timestamptz,
  expires_at         timestamptz,
  granted_by_kind    text        NOT NULL,
  granted_by_id      text        NOT NULL,
  idempotency_key    text        NOT NULL,

  CONSTRAINT permission_grant_pkey PRIMARY KEY (grant_id),
  CONSTRAINT permission_grant_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_grant_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_grant_role_known
    CHECK (role IN ('CUSTOMER', 'SUPPLIER', 'SERVICE_PROVIDER', 'DRIVER', 'STAFF', 'OPERATIONS',
                    'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN', 'AI_AGENT')),
  CONSTRAINT permission_grant_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  -- Purpose limitation, in the database. A staff role with no purpose is exactly the unpurposed
  -- staff access v3 5.3 forbids, and a non-staff role with one records a control that is not
  -- being enforced.
  CONSTRAINT permission_grant_staff_purpose
    CHECK (
      (role IN ('STAFF', 'OPERATIONS', 'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'))
      = (purpose IS NOT NULL)
    ),
  -- AI holds tool capabilities and nothing else, however the row was written.
  CONSTRAINT permission_grant_ai_tool_only
    CHECK (role <> 'AI_AGENT' OR (action = 'invoke-tool' AND resource_type = 'tool')),
  CONSTRAINT permission_grant_window_ordered
    CHECK (not_before IS NULL OR expires_at IS NULL OR expires_at > not_before),
  CONSTRAINT permission_grant_origin_known CHECK (granted_by_kind IN ('human', 'system')),
  CONSTRAINT permission_grant_condition_shape
    CHECK (condition IS NULL OR jsonb_typeof(condition) = 'object'),
  CONSTRAINT permission_grant_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_grant_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_grant_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_grant_resource_opaque
    CHECK (resource_id IS NULL OR kernel_permissions.is_opaque_identifier(resource_id)),
  CONSTRAINT permission_grant_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_grant_grantor_opaque
    CHECK (kernel_permissions.is_opaque_identifier(granted_by_id)),
  CONSTRAINT permission_grant_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_grant_granted_at_finite
    CHECK (granted_at > '-infinity'::timestamptz AND granted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_grant IS
  'One explicit allow or deny, scoped to an account, a resource and an action. Never updated; withdrawn by an appended revocation.';

COMMENT ON COLUMN kernel_permissions.permission_grant.resource_id IS
  'One resource, or NULL for every resource of that type inside this account. There is no grant shape covering every account.';

CREATE INDEX IF NOT EXISTS permission_grant_subject_account_idx
  ON kernel_permissions.permission_grant (subject_id, account_id);

-- ---------------------------------------------------------------------------
-- Revocations: one per grant, and final
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_revocation (
  revocation_id    text        NOT NULL,
  grant_id         text        NOT NULL,
  revoked_at       timestamptz NOT NULL,
  reason           text        NOT NULL,
  revoked_by_kind  text        NOT NULL,
  revoked_by_id    text        NOT NULL,
  idempotency_key  text        NOT NULL,

  CONSTRAINT permission_revocation_pkey PRIMARY KEY (revocation_id),

  -- One revocation per grant. A second is not a stronger withdrawal; it is a rewrite of when
  -- authority ended, which is the fact the row exists to record.
  CONSTRAINT permission_revocation_grant_unique UNIQUE (grant_id),
  CONSTRAINT permission_revocation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_revocation_reason_known
    CHECK (reason IN ('granted-in-error', 'role-changed', 'access-no-longer-needed',
                      'security-event', 'policy-superseded')),
  CONSTRAINT permission_revocation_origin_known CHECK (revoked_by_kind IN ('human', 'system')),
  CONSTRAINT permission_revocation_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revocation_id)),
  CONSTRAINT permission_revocation_grant_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_revocation_revoker_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revoked_by_id)),
  CONSTRAINT permission_revocation_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_revocation_revoked_at_finite
    CHECK (revoked_at > '-infinity'::timestamptz AND revoked_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_revocation IS
  'Withdrawal of a grant, as an appended fact with a time and a reason. One per grant, and final.';

-- ---------------------------------------------------------------------------
-- Decisions: what was decided, and why
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_decision (
  decision_id        text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  session_id         text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  effect             text        NOT NULL,
  reason             text        NOT NULL,
  explanation        text        NOT NULL,
  deciding_grant_id  text,
  policy_version_id  text        NOT NULL,
  purpose            text,
  decided_at         timestamptz NOT NULL,
  idempotency_key    text        NOT NULL,
  request_fingerprint text       NOT NULL,

  CONSTRAINT permission_decision_pkey PRIMARY KEY (decision_id),
  CONSTRAINT permission_decision_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_decision_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_decision_reason_known
    CHECK (reason IN ('no-matching-grant', 'explicit-deny', 'explicit-allow',
                      'condition-unsatisfied', 'outside-validity-window', 'grant-revoked',
                      'purpose-not-satisfied', 'not-permitted-by-policy')),
  -- An allow always names the grant that allowed it. An allow with no deciding grant would be an
  -- authorisation nobody can trace to a decision anybody made.
  CONSTRAINT permission_decision_allow_is_traceable
    CHECK (effect <> 'allow' OR deciding_grant_id IS NOT NULL),
  CONSTRAINT permission_decision_explained CHECK (length(btrim(explanation)) >= 10),
  -- The fingerprint over every input the decision depended on, including the session it was
  -- computed for and the ABAC context that satisfied it. A retry is answered from this row only
  -- when the fingerprint matches, so a stolen idempotency key buys nothing.
  CONSTRAINT permission_decision_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

COMMENT ON COLUMN kernel_permissions.permission_decision.request_fingerprint IS
  'SHA-256 over every decision-authoritative input, including the session and the ABAC context. A retry is answered from this row only when it matches.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_revocation_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revocation_id)),
  CONSTRAINT permission_revocation_grant_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_revocation_revoker_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revoked_by_id)),
  CONSTRAINT permission_revocation_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_revocation_revoked_at_finite
    CHECK (revoked_at > '-infinity'::timestamptz AND revoked_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_revocation IS
  'Withdrawal of a grant, as an appended fact with a time and a reason. One per grant, and final.';

-- ---------------------------------------------------------------------------
-- Decisions: what was decided, and why
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_decision (
  decision_id        text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  session_id         text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  effect             text        NOT NULL,
  reason             text        NOT NULL,
  explanation        text        NOT NULL,
  deciding_grant_id  text,
  policy_version_id  text        NOT NULL,
  purpose            text,
  decided_at         timestamptz NOT NULL,
  idempotency_key    text        NOT NULL,
  request_fingerprint text       NOT NULL,

  CONSTRAINT permission_decision_pkey PRIMARY KEY (decision_id),
  CONSTRAINT permission_decision_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_decision_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_decision_reason_known
    CHECK (reason IN ('no-matching-grant', 'explicit-deny', 'explicit-allow',
                      'condition-unsatisfied', 'outside-validity-window', 'grant-revoked',
                      'purpose-not-satisfied', 'not-permitted-by-policy')),
  -- An allow always names the grant that allowed it. An allow with no deciding grant would be an
  -- authorisation nobody can trace to a decision anybody made.
  CONSTRAINT permission_decision_allow_is_traceable
    CHECK (effect <> 'allow' OR deciding_grant_id IS NOT NULL),
  CONSTRAINT permission_decision_explained CHECK (length(btrim(explanation)) >= 10),
  -- The fingerprint over every input the decision depended on, including the session it was
  -- computed for and the ABAC context that satisfied it. A retry is answered from this row only
  -- when the fingerprint matches, so a stolen idempotency key buys nothing.
  CONSTRAINT permission_decision_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

COMMENT ON COLUMN kernel_permissions.permission_decision.request_fingerprint IS
  'SHA-256 over every decision-authoritative input, including the session and the ABAC context. A retry is answered from this row only when it matches.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_policy_version_roles_shape
    CHECK (jsonb_typeof(roles) = 'array' AND jsonb_array_length(roles) >= 1),
  CONSTRAINT permission_policy_version_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_policy_version_publisher_opaque
    CHECK (kernel_permissions.is_opaque_identifier(published_by_id)),
  CONSTRAINT permission_policy_version_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_policy_version_published_at_finite
    CHECK (published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_policy_version IS
  'Immutable numbered policy. A change is a new version, never an edit, so authority can be replayed as it stood.';

-- ---------------------------------------------------------------------------
-- Grants: explicit, scoped, and never rewritten
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_grant (
  grant_id           text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  role               text        NOT NULL,
  effect             text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  purpose            text,
  condition          jsonb,
  policy_version_id  text        NOT NULL,
  granted_at         timestamptz NOT NULL,
  not_before         timestamptz,
  expires_at         timestamptz,
  granted_by_kind    text        NOT NULL,
  granted_by_id      text        NOT NULL,
  idempotency_key    text        NOT NULL,

  CONSTRAINT permission_grant_pkey PRIMARY KEY (grant_id),
  CONSTRAINT permission_grant_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_grant_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_grant_role_known
    CHECK (role IN ('CUSTOMER', 'SUPPLIER', 'SERVICE_PROVIDER', 'DRIVER', 'STAFF', 'OPERATIONS',
                    'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN', 'AI_AGENT')),
  CONSTRAINT permission_grant_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  -- Purpose limitation, in the database. A staff role with no purpose is exactly the unpurposed
  -- staff access v3 5.3 forbids, and a non-staff role with one records a control that is not
  -- being enforced.
  CONSTRAINT permission_grant_staff_purpose
    CHECK (
      (role IN ('STAFF', 'OPERATIONS', 'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'))
      = (purpose IS NOT NULL)
    ),
  -- AI holds tool capabilities and nothing else, however the row was written.
  CONSTRAINT permission_grant_ai_tool_only
    CHECK (role <> 'AI_AGENT' OR (action = 'invoke-tool' AND resource_type = 'tool')),
  CONSTRAINT permission_grant_window_ordered
    CHECK (not_before IS NULL OR expires_at IS NULL OR expires_at > not_before),
  CONSTRAINT permission_grant_origin_known CHECK (granted_by_kind IN ('human', 'system')),
  CONSTRAINT permission_grant_condition_shape
    CHECK (condition IS NULL OR jsonb_typeof(condition) = 'object'),
  CONSTRAINT permission_grant_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_grant_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_grant_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_grant_resource_opaque
    CHECK (resource_id IS NULL OR kernel_permissions.is_opaque_identifier(resource_id)),
  CONSTRAINT permission_grant_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_grant_grantor_opaque
    CHECK (kernel_permissions.is_opaque_identifier(granted_by_id)),
  CONSTRAINT permission_grant_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_grant_granted_at_finite
    CHECK (granted_at > '-infinity'::timestamptz AND granted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_grant IS
  'One explicit allow or deny, scoped to an account, a resource and an action. Never updated; withdrawn by an appended revocation.';

COMMENT ON COLUMN kernel_permissions.permission_grant.resource_id IS
  'One resource, or NULL for every resource of that type inside this account. There is no grant shape covering every account.';

CREATE INDEX IF NOT EXISTS permission_grant_subject_account_idx
  ON kernel_permissions.permission_grant (subject_id, account_id);

-- ---------------------------------------------------------------------------
-- Revocations: one per grant, and final
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_revocation (
  revocation_id    text        NOT NULL,
  grant_id         text        NOT NULL,
  revoked_at       timestamptz NOT NULL,
  reason           text        NOT NULL,
  revoked_by_kind  text        NOT NULL,
  revoked_by_id    text        NOT NULL,
  idempotency_key  text        NOT NULL,

  CONSTRAINT permission_revocation_pkey PRIMARY KEY (revocation_id),

  -- One revocation per grant. A second is not a stronger withdrawal; it is a rewrite of when
  -- authority ended, which is the fact the row exists to record.
  CONSTRAINT permission_revocation_grant_unique UNIQUE (grant_id),
  CONSTRAINT permission_revocation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_revocation_reason_known
    CHECK (reason IN ('granted-in-error', 'role-changed', 'access-no-longer-needed',
                      'security-event', 'policy-superseded')),
  CONSTRAINT permission_revocation_origin_known CHECK (revoked_by_kind IN ('human', 'system')),
  CONSTRAINT permission_revocation_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revocation_id)),
  CONSTRAINT permission_revocation_grant_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_revocation_revoker_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revoked_by_id)),
  CONSTRAINT permission_revocation_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_revocation_revoked_at_finite
    CHECK (revoked_at > '-infinity'::timestamptz AND revoked_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_revocation IS
  'Withdrawal of a grant, as an appended fact with a time and a reason. One per grant, and final.';

-- ---------------------------------------------------------------------------
-- Decisions: what was decided, and why
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_decision (
  decision_id        text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  session_id         text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  effect             text        NOT NULL,
  reason             text        NOT NULL,
  explanation        text        NOT NULL,
  deciding_grant_id  text,
  policy_version_id  text        NOT NULL,
  purpose            text,
  decided_at         timestamptz NOT NULL,
  idempotency_key    text        NOT NULL,
  request_fingerprint text       NOT NULL,

  CONSTRAINT permission_decision_pkey PRIMARY KEY (decision_id),
  CONSTRAINT permission_decision_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_decision_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_decision_reason_known
    CHECK (reason IN ('no-matching-grant', 'explicit-deny', 'explicit-allow',
                      'condition-unsatisfied', 'outside-validity-window', 'grant-revoked',
                      'purpose-not-satisfied', 'not-permitted-by-policy')),
  -- An allow always names the grant that allowed it. An allow with no deciding grant would be an
  -- authorisation nobody can trace to a decision anybody made.
  CONSTRAINT permission_decision_allow_is_traceable
    CHECK (effect <> 'allow' OR deciding_grant_id IS NOT NULL),
  CONSTRAINT permission_decision_explained CHECK (length(btrim(explanation)) >= 10),
  -- The fingerprint over every input the decision depended on, including the session it was
  -- computed for and the ABAC context that satisfied it. A retry is answered from this row only
  -- when the fingerprint matches, so a stolen idempotency key buys nothing.
  CONSTRAINT permission_decision_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

COMMENT ON COLUMN kernel_permissions.permission_decision.request_fingerprint IS
  'SHA-256 over every decision-authoritative input, including the session and the ABAC context. A retry is answered from this row only when it matches.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_grant_condition_shape
    CHECK (condition IS NULL OR jsonb_typeof(condition) = 'object'),
  CONSTRAINT permission_grant_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_grant_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_grant_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_grant_resource_opaque
    CHECK (resource_id IS NULL OR kernel_permissions.is_opaque_identifier(resource_id)),
  CONSTRAINT permission_grant_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_grant_grantor_opaque
    CHECK (kernel_permissions.is_opaque_identifier(granted_by_id)),
  CONSTRAINT permission_grant_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_grant_granted_at_finite
    CHECK (granted_at > '-infinity'::timestamptz AND granted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_grant IS
  'One explicit allow or deny, scoped to an account, a resource and an action. Never updated; withdrawn by an appended revocation.';

COMMENT ON COLUMN kernel_permissions.permission_grant.resource_id IS
  'One resource, or NULL for every resource of that type inside this account. There is no grant shape covering every account.';

CREATE INDEX IF NOT EXISTS permission_grant_subject_account_idx
  ON kernel_permissions.permission_grant (subject_id, account_id);

-- ---------------------------------------------------------------------------
-- Revocations: one per grant, and final
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_revocation (
  revocation_id    text        NOT NULL,
  grant_id         text        NOT NULL,
  revoked_at       timestamptz NOT NULL,
  reason           text        NOT NULL,
  revoked_by_kind  text        NOT NULL,
  revoked_by_id    text        NOT NULL,
  idempotency_key  text        NOT NULL,

  CONSTRAINT permission_revocation_pkey PRIMARY KEY (revocation_id),

  -- One revocation per grant. A second is not a stronger withdrawal; it is a rewrite of when
  -- authority ended, which is the fact the row exists to record.
  CONSTRAINT permission_revocation_grant_unique UNIQUE (grant_id),
  CONSTRAINT permission_revocation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_revocation_reason_known
    CHECK (reason IN ('granted-in-error', 'role-changed', 'access-no-longer-needed',
                      'security-event', 'policy-superseded')),
  CONSTRAINT permission_revocation_origin_known CHECK (revoked_by_kind IN ('human', 'system')),
  CONSTRAINT permission_revocation_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revocation_id)),
  CONSTRAINT permission_revocation_grant_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_revocation_revoker_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revoked_by_id)),
  CONSTRAINT permission_revocation_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_revocation_revoked_at_finite
    CHECK (revoked_at > '-infinity'::timestamptz AND revoked_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_revocation IS
  'Withdrawal of a grant, as an appended fact with a time and a reason. One per grant, and final.';

-- ---------------------------------------------------------------------------
-- Decisions: what was decided, and why
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_decision (
  decision_id        text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  session_id         text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  effect             text        NOT NULL,
  reason             text        NOT NULL,
  explanation        text        NOT NULL,
  deciding_grant_id  text,
  policy_version_id  text        NOT NULL,
  purpose            text,
  decided_at         timestamptz NOT NULL,
  idempotency_key    text        NOT NULL,
  request_fingerprint text       NOT NULL,

  CONSTRAINT permission_decision_pkey PRIMARY KEY (decision_id),
  CONSTRAINT permission_decision_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_decision_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_decision_reason_known
    CHECK (reason IN ('no-matching-grant', 'explicit-deny', 'explicit-allow',
                      'condition-unsatisfied', 'outside-validity-window', 'grant-revoked',
                      'purpose-not-satisfied', 'not-permitted-by-policy')),
  -- An allow always names the grant that allowed it. An allow with no deciding grant would be an
  -- authorisation nobody can trace to a decision anybody made.
  CONSTRAINT permission_decision_allow_is_traceable
    CHECK (effect <> 'allow' OR deciding_grant_id IS NOT NULL),
  CONSTRAINT permission_decision_explained CHECK (length(btrim(explanation)) >= 10),
  -- The fingerprint over every input the decision depended on, including the session it was
  -- computed for and the ABAC context that satisfied it. A retry is answered from this row only
  -- when the fingerprint matches, so a stolen idempotency key buys nothing.
  CONSTRAINT permission_decision_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

COMMENT ON COLUMN kernel_permissions.permission_decision.request_fingerprint IS
  'SHA-256 over every decision-authoritative input, including the session and the ABAC context. A retry is answered from this row only when it matches.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_policy_version_roles_shape
    CHECK (jsonb_typeof(roles) = 'array' AND jsonb_array_length(roles) >= 1),
  CONSTRAINT permission_policy_version_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_policy_version_publisher_opaque
    CHECK (kernel_permissions.is_opaque_identifier(published_by_id)),
  CONSTRAINT permission_policy_version_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_policy_version_published_at_finite
    CHECK (published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_policy_version IS
  'Immutable numbered policy. A change is a new version, never an edit, so authority can be replayed as it stood.';

-- ---------------------------------------------------------------------------
-- Grants: explicit, scoped, and never rewritten
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_grant (
  grant_id           text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  role               text        NOT NULL,
  effect             text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  purpose            text,
  condition          jsonb,
  policy_version_id  text        NOT NULL,
  granted_at         timestamptz NOT NULL,
  not_before         timestamptz,
  expires_at         timestamptz,
  granted_by_kind    text        NOT NULL,
  granted_by_id      text        NOT NULL,
  idempotency_key    text        NOT NULL,

  CONSTRAINT permission_grant_pkey PRIMARY KEY (grant_id),
  CONSTRAINT permission_grant_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_grant_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_grant_role_known
    CHECK (role IN ('CUSTOMER', 'SUPPLIER', 'SERVICE_PROVIDER', 'DRIVER', 'STAFF', 'OPERATIONS',
                    'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN', 'AI_AGENT')),
  CONSTRAINT permission_grant_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  -- Purpose limitation, in the database. A staff role with no purpose is exactly the unpurposed
  -- staff access v3 5.3 forbids, and a non-staff role with one records a control that is not
  -- being enforced.
  CONSTRAINT permission_grant_staff_purpose
    CHECK (
      (role IN ('STAFF', 'OPERATIONS', 'FINANCE', 'SUPPORT', 'MANAGER', 'ADMIN', 'SUPER_ADMIN'))
      = (purpose IS NOT NULL)
    ),
  -- AI holds tool capabilities and nothing else, however the row was written.
  CONSTRAINT permission_grant_ai_tool_only
    CHECK (role <> 'AI_AGENT' OR (action = 'invoke-tool' AND resource_type = 'tool')),
  CONSTRAINT permission_grant_window_ordered
    CHECK (not_before IS NULL OR expires_at IS NULL OR expires_at > not_before),
  CONSTRAINT permission_grant_origin_known CHECK (granted_by_kind IN ('human', 'system')),
  CONSTRAINT permission_grant_condition_shape
    CHECK (condition IS NULL OR jsonb_typeof(condition) = 'object'),
  CONSTRAINT permission_grant_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_grant_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_grant_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_grant_resource_opaque
    CHECK (resource_id IS NULL OR kernel_permissions.is_opaque_identifier(resource_id)),
  CONSTRAINT permission_grant_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_grant_grantor_opaque
    CHECK (kernel_permissions.is_opaque_identifier(granted_by_id)),
  CONSTRAINT permission_grant_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_grant_granted_at_finite
    CHECK (granted_at > '-infinity'::timestamptz AND granted_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_grant IS
  'One explicit allow or deny, scoped to an account, a resource and an action. Never updated; withdrawn by an appended revocation.';

COMMENT ON COLUMN kernel_permissions.permission_grant.resource_id IS
  'One resource, or NULL for every resource of that type inside this account. There is no grant shape covering every account.';

CREATE INDEX IF NOT EXISTS permission_grant_subject_account_idx
  ON kernel_permissions.permission_grant (subject_id, account_id);

-- ---------------------------------------------------------------------------
-- Revocations: one per grant, and final
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_revocation (
  revocation_id    text        NOT NULL,
  grant_id         text        NOT NULL,
  revoked_at       timestamptz NOT NULL,
  reason           text        NOT NULL,
  revoked_by_kind  text        NOT NULL,
  revoked_by_id    text        NOT NULL,
  idempotency_key  text        NOT NULL,

  CONSTRAINT permission_revocation_pkey PRIMARY KEY (revocation_id),

  -- One revocation per grant. A second is not a stronger withdrawal; it is a rewrite of when
  -- authority ended, which is the fact the row exists to record.
  CONSTRAINT permission_revocation_grant_unique UNIQUE (grant_id),
  CONSTRAINT permission_revocation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_revocation_reason_known
    CHECK (reason IN ('granted-in-error', 'role-changed', 'access-no-longer-needed',
                      'security-event', 'policy-superseded')),
  CONSTRAINT permission_revocation_origin_known CHECK (revoked_by_kind IN ('human', 'system')),
  CONSTRAINT permission_revocation_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revocation_id)),
  CONSTRAINT permission_revocation_grant_opaque
    CHECK (kernel_permissions.is_opaque_identifier(grant_id)),
  CONSTRAINT permission_revocation_revoker_opaque
    CHECK (kernel_permissions.is_opaque_identifier(revoked_by_id)),
  CONSTRAINT permission_revocation_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_revocation_revoked_at_finite
    CHECK (revoked_at > '-infinity'::timestamptz AND revoked_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_revocation IS
  'Withdrawal of a grant, as an appended fact with a time and a reason. One per grant, and final.';

-- ---------------------------------------------------------------------------
-- Decisions: what was decided, and why
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kernel_permissions.permission_decision (
  decision_id        text        NOT NULL,
  subject_id         text        NOT NULL,
  account_id         text        NOT NULL,
  session_id         text        NOT NULL,
  action             text        NOT NULL,
  resource_type      text        NOT NULL,
  resource_id        text,
  effect             text        NOT NULL,
  reason             text        NOT NULL,
  explanation        text        NOT NULL,
  deciding_grant_id  text,
  policy_version_id  text        NOT NULL,
  purpose            text,
  decided_at         timestamptz NOT NULL,
  idempotency_key    text        NOT NULL,
  request_fingerprint text       NOT NULL,

  CONSTRAINT permission_decision_pkey PRIMARY KEY (decision_id),
  CONSTRAINT permission_decision_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT permission_decision_effect_known CHECK (effect IN ('allow', 'deny')),
  CONSTRAINT permission_decision_reason_known
    CHECK (reason IN ('no-matching-grant', 'explicit-deny', 'explicit-allow',
                      'condition-unsatisfied', 'outside-validity-window', 'grant-revoked',
                      'purpose-not-satisfied', 'not-permitted-by-policy')),
  -- An allow always names the grant that allowed it. An allow with no deciding grant would be an
  -- authorisation nobody can trace to a decision anybody made.
  CONSTRAINT permission_decision_allow_is_traceable
    CHECK (effect <> 'allow' OR deciding_grant_id IS NOT NULL),
  CONSTRAINT permission_decision_explained CHECK (length(btrim(explanation)) >= 10),
  -- The fingerprint over every input the decision depended on, including the session it was
  -- computed for and the ABAC context that satisfied it. A retry is answered from this row only
  -- when the fingerprint matches, so a stolen idempotency key buys nothing.
  CONSTRAINT permission_decision_fingerprint_shape
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

COMMENT ON COLUMN kernel_permissions.permission_decision.request_fingerprint IS
  'SHA-256 over every decision-authoritative input, including the session and the ABAC context. A retry is answered from this row only when it matches.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
),
  CONSTRAINT permission_decision_purpose_known
    CHECK (purpose IS NULL OR purpose IN ('dispute-investigation', 'fraud-investigation',
                                          'support-request', 'regulatory-request',
                                          'payment-investigation', 'safety-review',
                                          'system-maintenance')),
  CONSTRAINT permission_decision_id_opaque
    CHECK (kernel_permissions.is_opaque_identifier(decision_id)),
  CONSTRAINT permission_decision_subject_opaque
    CHECK (kernel_permissions.is_opaque_identifier(subject_id)),
  CONSTRAINT permission_decision_account_opaque
    CHECK (kernel_permissions.is_opaque_identifier(account_id)),
  CONSTRAINT permission_decision_session_opaque
    CHECK (kernel_permissions.is_opaque_identifier(session_id)),
  CONSTRAINT permission_decision_grant_opaque
    CHECK (deciding_grant_id IS NULL OR kernel_permissions.is_opaque_identifier(deciding_grant_id)),
  CONSTRAINT permission_decision_policy_opaque
    CHECK (kernel_permissions.is_opaque_identifier(policy_version_id)),
  CONSTRAINT permission_decision_idempotency_opaque
    CHECK (kernel_permissions.is_opaque_identifier(idempotency_key)),
  CONSTRAINT permission_decision_decided_at_finite
    CHECK (decided_at > '-infinity'::timestamptz AND decided_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE kernel_permissions.permission_decision IS
  'What was decided, for whom, on what, and why. The explanation is a column because a denial nobody can explain is one nobody can appeal.';

CREATE INDEX IF NOT EXISTS permission_decision_subject_idx
  ON kernel_permissions.permission_decision (subject_id, account_id, decided_at DESC);

-- ---------------------------------------------------------------------------
-- Authority history is append-only
-- ---------------------------------------------------------------------------

-- Written as a trigger rather than as column privileges because no roles exist yet: this holds for
-- every connection, including the one an operator opens by hand. What it stops is the UPDATE that
-- quietly widens a grant, and the DELETE that removes the evidence a grant ever existed.
CREATE OR REPLACE FUNCTION kernel_permissions.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'authority history is append-only: % on % is refused. Withdraw a grant by appending a revocation',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION kernel_permissions.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against any table in this schema.';

CREATE TRIGGER permission_policy_version_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_policy_version
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_grant_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_grant
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_revocation_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_revocation
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

CREATE TRIGGER permission_decision_is_append_only
  BEFORE UPDATE OR DELETE ON kernel_permissions.permission_decision
  FOR EACH ROW EXECUTE FUNCTION kernel_permissions.refuse_mutation();

COMMIT;
