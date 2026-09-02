-- migration: 0058_create_module_organisations_schema
-- direction: up
-- owner: module_organisations
--
-- M-49 Organisations: the business, and the people who act for it.
--
-- Every commercial record in this platform names an account -- a listing's, an order's, a wallet's,
-- a directory entry's -- and until now that account was always a person's. That is true of a sole
-- trader and false of every business with two people in it.
--
-- **An organisation is an account of its own.** `UNIQUE (account_id)`: one account, one business.
-- That single decision is what makes the rest cheap -- every module that owns a commercial record
-- already references an account, so a listing, an order and a wallet belong to the *business* with
-- no change to any of them, and a business that adds staff or changes owners rewrites nothing.
--
-- **A membership is scoped by construction.** `UNIQUE (organisation_id, person_subject_id)`: one
-- person, one place, per business. A FINANCE role at one company is a different row from anything
-- at another, so it confers nothing there -- not by a rule somebody has to remember, but because
-- there is nothing to read.
--
-- **The last owner is protected by the database, not only by the service.** `membership_keeps_an_
-- owner` is a DEFERRED constraint trigger, because the invariant spans rows and no CHECK can
-- express it: it fires at commit and refuses any organisation left with no active owner. Deferred
-- so that founding a business -- which writes the organisation and its owner in one transaction --
-- is not refused halfway through. A business nobody owns is one nobody can administer, and the only
-- way back would be an operator editing rows.
--
-- **Roles are a text[] and not a joined string.** "Who owns this business" is a question an operator
-- will ask, and `'OWNER' = ANY(roles)` answers it while `LIKE '%OWNER%'` would also match a role
-- with OWNER inside it.
--
-- **Both histories are append-only.** "Who removed me, and when, and why" is what somebody asks
-- after being removed from a business they worked for, and a record that could be edited is not an
-- answer.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_organisations;

COMMENT ON SCHEMA module_organisations IS
  'M-49 Organisations. The business as an account of its own, and the memberships that let people act for it. Authority itself lives in K-04: a membership is what a grant is made from.';

-- Character-for-character identical to every other schema's copy, and required to stay so by test.
CREATE OR REPLACE FUNCTION module_organisations.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION module_organisations.is_opaque_identifier(text) IS
  'M-49''s copy of the platform identifier rule. Byte-identical to every other schema''s, and checked by test.';

-- ---------------------------------------------------------------------------
-- The business
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_organisations.organisation (
  organisation_id text        NOT NULL,
  account_id      text        NOT NULL,
  kind            text        NOT NULL,
  display_name    text        NOT NULL,
  status          text        NOT NULL,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  closed_at       timestamptz NULL,
  closure_reason  text        NULL,
  correlation_id  text        NOT NULL,
  idempotency_key text        NOT NULL,

  CONSTRAINT organisation_pkey PRIMARY KEY (organisation_id),
  -- One account, one business. See the header.
  CONSTRAINT organisation_account_unique UNIQUE (account_id),
  CONSTRAINT organisation_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT organisation_id_opaque
    CHECK (module_organisations.is_opaque_identifier(organisation_id)),
  CONSTRAINT organisation_account_opaque
    CHECK (module_organisations.is_opaque_identifier(account_id)),
  CONSTRAINT organisation_correlation_opaque
    CHECK (module_organisations.is_opaque_identifier(correlation_id)),
  CONSTRAINT organisation_idempotency_opaque
    CHECK (module_organisations.is_opaque_identifier(idempotency_key)),

  CONSTRAINT organisation_kind_known
    CHECK (kind IN ('supplier', 'merchant', 'member', 'logistics', 'service', 'wholesale')),
  CONSTRAINT organisation_status_known
    CHECK (status IN ('pending', 'active', 'suspended', 'closed')),

  CONSTRAINT organisation_name_bounded
    CHECK (length(btrim(display_name)) > 0 AND length(display_name) <= 200),

  -- A closed business says when it closed and why, and an open one does not pretend to have.
  CONSTRAINT organisation_closure_agrees
    CHECK ((status = 'closed') = (closed_at IS NOT NULL)
       AND (closed_at IS NULL) = (closure_reason IS NULL)),
  CONSTRAINT organisation_reason_present
    CHECK (closure_reason IS NULL
           OR (length(btrim(closure_reason)) >= 8 AND length(closure_reason) <= 1000)),
  CONSTRAINT organisation_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT organisation_updated_not_before_created CHECK (updated_at >= created_at)
);

COMMENT ON TABLE module_organisations.organisation IS
  'A business, as a K-03 account of its own. Every commercial record already names an account, so making the business one means a listing, an order and a wallet belong to it without any of those modules changing.';

COMMENT ON COLUMN module_organisations.organisation.status IS
  'Standing with the platform. Created is pending: a business with ten employees and no admission is still not sourceable, because having staff is not being vouched for.';

CREATE INDEX IF NOT EXISTS organisation_active_idx
  ON module_organisations.organisation (kind)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Who may act for it
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_organisations.organisation_membership (
  membership_id     text        NOT NULL,
  organisation_id   text        NOT NULL,
  person_subject_id text        NOT NULL,
  person_account_id text        NOT NULL,
  roles             text[]      NOT NULL,
  status            text        NOT NULL,
  invited_by        text        NULL,
  invited_at        timestamptz NOT NULL,
  accepted_at       timestamptz NULL,
  suspended_at      timestamptz NULL,
  ended_at          timestamptz NULL,
  correlation_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT organisation_membership_pkey PRIMARY KEY (membership_id),
  -- One person, one place, per business. Two memberships would be two answers to "what may they do
  -- here", with nothing to say which one applies.
  CONSTRAINT organisation_membership_one_per_person UNIQUE (organisation_id, person_subject_id),
  CONSTRAINT organisation_membership_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT organisation_membership_id_opaque
    CHECK (module_organisations.is_opaque_identifier(membership_id)),
  CONSTRAINT organisation_membership_organisation_opaque
    CHECK (module_organisations.is_opaque_identifier(organisation_id)),
  CONSTRAINT organisation_membership_person_opaque
    CHECK (module_organisations.is_opaque_identifier(person_subject_id)),
  CONSTRAINT organisation_membership_person_account_opaque
    CHECK (module_organisations.is_opaque_identifier(person_account_id)),
  CONSTRAINT organisation_membership_inviter_opaque
    CHECK (invited_by IS NULL OR module_organisations.is_opaque_identifier(invited_by)),
  CONSTRAINT organisation_membership_correlation_opaque
    CHECK (module_organisations.is_opaque_identifier(correlation_id)),
  CONSTRAINT organisation_membership_idempotency_opaque
    CHECK (module_organisations.is_opaque_identifier(idempotency_key)),

  CONSTRAINT organisation_membership_status_known
    CHECK (status IN ('invited', 'active', 'suspended', 'revoked', 'left')),

  -- A membership that permits nothing is one nobody should hold, and a role outside the vocabulary
  -- is authority nothing can evaluate.
  CONSTRAINT organisation_membership_has_roles CHECK (cardinality(roles) > 0),
  CONSTRAINT organisation_membership_roles_known
    CHECK (roles <@ ARRAY['OWNER', 'ADMIN', 'MANAGER', 'SALES', 'PROCUREMENT', 'INVENTORY',
                          'FINANCE', 'FULFILMENT', 'DRIVER_MANAGER', 'READ_ONLY']::text[]),

  -- Joining a business is something a person agrees to, and the instant they did is part of the
  -- record. An invitation nobody has accepted has no acceptance.
  CONSTRAINT organisation_membership_acceptance_agrees
    CHECK ((status = 'invited') = (accepted_at IS NULL AND ended_at IS NULL)
           OR status IN ('revoked', 'left')),
  CONSTRAINT organisation_membership_acting_was_accepted
    CHECK (status NOT IN ('active', 'suspended') OR accepted_at IS NOT NULL),
  CONSTRAINT organisation_membership_ending_agrees
    CHECK ((status IN ('revoked', 'left')) = (ended_at IS NOT NULL)),
  CONSTRAINT organisation_membership_suspension_agrees
    CHECK (status = 'suspended' OR suspended_at IS NULL),
  CONSTRAINT organisation_membership_invited_at_finite
    CHECK (invited_at > '-infinity'::timestamptz AND invited_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_organisations.organisation_membership IS
  'One person''s place in one business, and the roles it carries. Scoped by construction: a role here confers nothing at another organisation, because that is a different row.';

COMMENT ON COLUMN module_organisations.organisation_membership.roles IS
  'A text[] rather than a joined string, so "who owns this business" is a query rather than a substring match that would also find a role with OWNER inside it.';

-- What the authorisation path reads: this person, this business, right now.
CREATE INDEX IF NOT EXISTS organisation_membership_acting_idx
  ON module_organisations.organisation_membership (person_subject_id, organisation_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS organisation_membership_roster_idx
  ON module_organisations.organisation_membership (organisation_id, status);

-- ---------------------------------------------------------------------------
-- How each of them got where it is
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_organisations.membership_event (
  event_id          text        NOT NULL,
  membership_id     text        NOT NULL,
  organisation_id   text        NOT NULL,
  from_status       text        NULL,
  to_status         text        NOT NULL,
  roles             text[]      NOT NULL,
  actor_subject_id  text        NOT NULL,
  reason            text        NOT NULL,
  occurred_at       timestamptz NOT NULL,
  correlation_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT membership_event_pkey PRIMARY KEY (event_id),

  CONSTRAINT membership_event_id_opaque
    CHECK (module_organisations.is_opaque_identifier(event_id)),
  CONSTRAINT membership_event_membership_opaque
    CHECK (module_organisations.is_opaque_identifier(membership_id)),
  CONSTRAINT membership_event_organisation_opaque
    CHECK (module_organisations.is_opaque_identifier(organisation_id)),
  -- The human who decided it. A business does not act; people act for it, and an audit trail that
  -- lost the person answers nothing.
  CONSTRAINT membership_event_actor_opaque
    CHECK (module_organisations.is_opaque_identifier(actor_subject_id)),
  CONSTRAINT membership_event_correlation_opaque
    CHECK (module_organisations.is_opaque_identifier(correlation_id)),
  CONSTRAINT membership_event_idempotency_opaque
    CHECK (module_organisations.is_opaque_identifier(idempotency_key)),

  CONSTRAINT membership_event_status_known
    CHECK (to_status IN ('invited', 'active', 'suspended', 'revoked', 'left')
           AND (from_status IS NULL
                OR from_status IN ('invited', 'active', 'suspended', 'revoked', 'left'))),
  CONSTRAINT membership_event_has_roles CHECK (cardinality(roles) > 0),
  CONSTRAINT membership_event_reason_present
    CHECK (length(btrim(reason)) >= 8 AND length(reason) <= 1000),
  CONSTRAINT membership_event_occurred_at_finite
    CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_organisations.membership_event IS
  'Append-only. "Who removed me, and when, and why" is what somebody asks after being removed from a business they worked for, and a record that could be edited is not an answer.';

CREATE INDEX IF NOT EXISTS membership_event_membership_idx
  ON module_organisations.membership_event (membership_id, occurred_at);

CREATE TABLE IF NOT EXISTS module_organisations.organisation_event (
  event_id        text        NOT NULL,
  organisation_id text        NOT NULL,
  from_status     text        NULL,
  to_status       text        NOT NULL,
  reason          text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  correlation_id  text        NOT NULL,
  idempotency_key text        NOT NULL,

  CONSTRAINT organisation_event_pkey PRIMARY KEY (event_id),

  CONSTRAINT organisation_event_id_opaque
    CHECK (module_organisations.is_opaque_identifier(event_id)),
  CONSTRAINT organisation_event_organisation_opaque
    CHECK (module_organisations.is_opaque_identifier(organisation_id)),
  CONSTRAINT organisation_event_correlation_opaque
    CHECK (module_organisations.is_opaque_identifier(correlation_id)),
  CONSTRAINT organisation_event_idempotency_opaque
    CHECK (module_organisations.is_opaque_identifier(idempotency_key)),

  CONSTRAINT organisation_event_status_known
    CHECK (to_status IN ('pending', 'active', 'suspended', 'closed')
           AND (from_status IS NULL
                OR from_status IN ('pending', 'active', 'suspended', 'closed'))),
  CONSTRAINT organisation_event_reason_present
    CHECK (length(btrim(reason)) >= 8 AND length(reason) <= 1000),
  CONSTRAINT organisation_event_occurred_at_finite
    CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_organisations.organisation_event IS
  'Append-only. Why a business was suspended is what its owner is entitled to be told, and what an appeal is judged against.';

CREATE INDEX IF NOT EXISTS organisation_event_organisation_idx
  ON module_organisations.organisation_event (organisation_id, occurred_at);

-- ---------------------------------------------------------------------------
-- The transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_organisations.outbox (
  outbox_id          text        NOT NULL,
  idempotency_key    text        NOT NULL,
  kind               text        NOT NULL,
  payload            jsonb       NOT NULL,
  recorded_at        timestamptz NOT NULL,
  producer           text        NOT NULL,
  correlation_id     text        NOT NULL,
  causation_id       text        NULL,
  processed_at       timestamptz NULL,
  retry_count        integer     NOT NULL DEFAULT 0,
  last_error         text        NULL,
  next_attempt_at    timestamptz NULL,
  dead_lettered_at   timestamptz NULL,
  dead_letter_reason text        NULL,

  CONSTRAINT outbox_pkey PRIMARY KEY (outbox_id),
  CONSTRAINT outbox_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT outbox_kind_known CHECK (kind IN ('event', 'audit')),
  CONSTRAINT outbox_retry_count_non_negative CHECK (retry_count >= 0),
  CONSTRAINT outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_dead_letter_agrees
    CHECK ((dead_lettered_at IS NULL) = (dead_letter_reason IS NULL)),
  CONSTRAINT outbox_dead_letter_not_processed
    CHECK (dead_lettered_at IS NULL OR processed_at IS NULL)
);

COMMENT ON TABLE module_organisations.outbox IS
  'M-49''s transactional outbox. No role travels in an event: who holds what authority in a company tells a competitor who to approach and who has just left. The roles are on the audit record, which is not a subscription.';

CREATE INDEX IF NOT EXISTS outbox_claimable_idx
  ON module_organisations.outbox (next_attempt_at NULLS FIRST, recorded_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

-- ---------------------------------------------------------------------------
-- What may never change, and what may never be left
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION module_organisations.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  RAISE EXCEPTION
    'table %.% is append-only: somebody has been told what happened to their place in a business, and rewriting it would make the record disagree',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$body$;

CREATE TRIGGER membership_event_is_append_only
  BEFORE UPDATE OR DELETE ON module_organisations.membership_event
  FOR EACH ROW EXECUTE FUNCTION module_organisations.refuse_mutation();

CREATE TRIGGER organisation_event_is_append_only
  BEFORE UPDATE OR DELETE ON module_organisations.organisation_event
  FOR EACH ROW EXECUTE FUNCTION module_organisations.refuse_mutation();

-- A business always has somebody who can administer it.
--
-- A DEFERRED constraint trigger, because the invariant spans rows and no CHECK can express it. It
-- fires at COMMIT, which is what makes founding a business possible at all: the organisation and its
-- owner are written in one transaction, and a trigger that fired per statement would refuse the
-- first of the two.
--
-- The service refuses the same thing with a message that says what to do instead. This is the layer
-- that survives somebody writing SQL by hand.
CREATE OR REPLACE FUNCTION module_organisations.membership_keeps_an_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
DECLARE
  affected text;
  owners integer;
  survives boolean;
BEGIN
  affected := COALESCE(NEW.organisation_id, OLD.organisation_id);

  -- An organisation that has itself gone is not one that needs an owner.
  SELECT EXISTS (
    SELECT 1 FROM module_organisations.organisation
     WHERE organisation_id = affected
  ) INTO survives;
  IF NOT survives THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO owners
    FROM module_organisations.organisation_membership
   WHERE organisation_id = affected
     AND status = 'active'
     AND 'OWNER' = ANY(roles);

  IF owners = 0 THEN
    RAISE EXCEPTION
      'organisation % would be left with no active owner: a business nobody owns is one nobody can administer, and the only way back would be an operator editing rows',
      affected
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$body$;

CREATE CONSTRAINT TRIGGER membership_keeps_an_owner
  AFTER INSERT OR UPDATE OR DELETE ON module_organisations.organisation_membership
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION module_organisations.membership_keeps_an_owner();

COMMIT;
