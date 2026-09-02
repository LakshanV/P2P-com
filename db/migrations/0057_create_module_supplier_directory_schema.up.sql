-- migration: 0057_create_module_supplier_directory_schema
-- direction: up
-- owner: module_supplier_directory
--
-- M-48 Supplier & Merchant Directory: the network the sourcing ladder was built to search.
--
-- The ladder shipped with five rungs and only one of them could be wired, because nothing owned the
-- answer to "who supplies this". So every Need the catalogue could not fill became a tender —
-- exactly the behaviour the ladder exists to avoid.
--
-- **One account, one entry.** `UNIQUE (account_id)`. Two entries for one party would make "who
-- supplies this" ambiguous for the same business, and a buyer receiving two invitations from one
-- supplier is a platform that does not know who its suppliers are.
--
-- **What a supplier claims is separated from what they have done.** Everything in this schema is a
-- claim: they say they supply cement, they say they deliver to Matale. Prior trade is a fact and
-- lives in `module_orders`; verification is a judgement and lives in
-- `module_capability_verification`. There is deliberately no `verified` column and no
-- `reliability_per_mille` here — a directory that stored either would be a second, staler answer to
-- a question another module already answers.
--
-- **One facet table, not four.** Categories, brands, capabilities and service districts are
-- structurally identical — a code a supplier claims and may later withdraw — and four tables
-- differing only in name would drift apart in their constraints. `facet_kind` is a closed CHECK, so
-- this is a discriminated set rather than a bag anybody can add to.
--
-- **Withdrawing is a state change, not a delete.** `UNIQUE (supplier_id, facet_kind, value)` means
-- one row per claim for its whole life, moving between `active` and `withdrawn`. A dispute about an
-- order placed in March is judged against what the supplier said in March, and a deleted row cannot
-- say.
--
-- **A location carries a district, not an address.** The platform routes on districts, and a precise
-- address is personal data for a sole trader working from home.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_supplier_directory;

COMMENT ON SCHEMA module_supplier_directory IS
  'M-48 Supplier & Merchant Directory. Who supplies what, where, and whether they are open — as claims. What they have actually done lives in M-11; whether they are verified lives in M-02.';

-- Character-for-character identical to every other schema's copy, and required to stay so by test.
CREATE OR REPLACE FUNCTION module_supplier_directory.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION module_supplier_directory.is_opaque_identifier(text) IS
  'M-48''s copy of the platform identifier rule. Byte-identical to every other schema''s, and checked by test.';

-- A declared vocabulary code: a category, a brand, a capability, a district.
--
-- **Deliberately not the identifier rule.** That rule requires at least eight characters, because an
-- identity space anybody can enumerate lets them count the platform's parties. A shared vocabulary
-- is the opposite case: "cement" and "matale" are meant to be enumerable — a buyer picks from a list
-- of them — and padding them to eight characters would mean inventing nonsense for the words the
-- product actually uses.
--
-- What still applies is that these travel into tenders and into match explanations, so a code that
-- was somebody's email address or telephone number would publish it into every invitation the
-- supplier ever received. Those are refused here by shape.
CREATE OR REPLACE FUNCTION module_supplier_directory.is_facet_code(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $codes$
  SELECT
        value ~ '^[a-z0-9][a-z0-9-]{1,63}$'
    -- A code with no letter in it is a number wearing a word's clothes, and the numbers that reach
    -- a field like this are telephone numbers.
    AND value ~ '[a-z]'
    AND value !~ '[0-9]{7,}'
    AND position('@' in value) = 0
$codes$;

COMMENT ON FUNCTION module_supplier_directory.is_facet_code(text) IS
  'A declared vocabulary code. Enumerable on purpose — a buyer picks from a list — but still refused when it looks like an address or a telephone number, because it travels into every invitation.';

-- ---------------------------------------------------------------------------
-- The trading party
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_supplier_directory.directory_entry (
  supplier_id     text        NOT NULL,
  account_id      text        NOT NULL,
  kind            text        NOT NULL,
  display_name    text        NOT NULL,
  status          text        NOT NULL,
  accepts_orders  boolean     NOT NULL,
  daily_capacity  bigint      NULL,
  registered_at   timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  closed_at       timestamptz NULL,
  closure_reason  text        NULL,
  correlation_id  text        NOT NULL,
  idempotency_key text        NOT NULL,

  CONSTRAINT directory_entry_pkey PRIMARY KEY (supplier_id),
  -- One account, one entry. See the header.
  CONSTRAINT directory_entry_account_unique UNIQUE (account_id),
  CONSTRAINT directory_entry_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT directory_entry_id_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(supplier_id)),
  CONSTRAINT directory_entry_account_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(account_id)),
  CONSTRAINT directory_entry_correlation_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(correlation_id)),
  CONSTRAINT directory_entry_idempotency_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(idempotency_key)),

  CONSTRAINT directory_entry_kind_known CHECK (kind IN ('supplier', 'merchant')),
  CONSTRAINT directory_entry_status_known
    CHECK (status IN ('pending', 'active', 'suspended', 'closed')),

  -- Public by design: it is what a buyer sees on an invitation. Bounded, because a name field long
  -- enough to hold a paragraph is one somebody will paste a paragraph into.
  CONSTRAINT directory_entry_name_bounded
    CHECK (length(btrim(display_name)) > 0 AND length(display_name) <= 200),

  -- A supplier who can take nothing says so by closing, not by claiming a negative capacity.
  CONSTRAINT directory_entry_capacity_non_negative
    CHECK (daily_capacity IS NULL OR daily_capacity >= 0),

  -- A closed entry says when it closed and why, and an open one does not pretend to have.
  CONSTRAINT directory_entry_closure_agrees
    CHECK ((status = 'closed') = (closed_at IS NOT NULL)
       AND (closed_at IS NULL) = (closure_reason IS NULL)),
  -- And a closed party is not open for orders. A row claiming both is a contradiction a reader
  -- would have to resolve for themselves.
  CONSTRAINT directory_entry_closed_is_shut
    CHECK (status <> 'closed' OR accepts_orders = false),
  CONSTRAINT directory_entry_reason_present
    CHECK (closure_reason IS NULL
           OR (length(btrim(closure_reason)) >= 8 AND length(closure_reason) <= 1000)),
  CONSTRAINT directory_entry_registered_at_finite
    CHECK (registered_at > '-infinity'::timestamptz AND registered_at < 'infinity'::timestamptz),
  CONSTRAINT directory_entry_updated_not_before_registered CHECK (updated_at >= registered_at)
);

COMMENT ON TABLE module_supplier_directory.directory_entry IS
  'One trading party. Registration is not activation: a new entry is pending and the sourcing rungs do not see it, because a platform where signing up puts you straight into the market gives the first tender to whoever registered fastest.';

COMMENT ON COLUMN module_supplier_directory.directory_entry.accepts_orders IS
  'Whether they are open today. Distinct from status and from capacity: "closed for the week" and "capacity zero" are different answers to a buyer asking why they were not invited.';

-- What a sourcing query scans: open, active parties.
CREATE INDEX IF NOT EXISTS directory_entry_open_idx
  ON module_supplier_directory.directory_entry (kind)
  WHERE status = 'active' AND accepts_orders = true;

-- ---------------------------------------------------------------------------
-- What they claim they can do
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_supplier_directory.supplier_facet (
  facet_id        text        NOT NULL,
  supplier_id     text        NOT NULL,
  facet_kind      text        NOT NULL,
  value           text        NOT NULL,
  status          text        NOT NULL,
  declared_at     timestamptz NOT NULL,
  withdrawn_at    timestamptz NULL,
  correlation_id  text        NOT NULL,
  idempotency_key text        NOT NULL,

  CONSTRAINT supplier_facet_pkey PRIMARY KEY (facet_id),
  -- One row per claim for its whole life. Declaring again moves this row rather than adding one, so
  -- the history is one row's story rather than two rows disagreeing.
  CONSTRAINT supplier_facet_once_per_value UNIQUE (supplier_id, facet_kind, value),

  CONSTRAINT supplier_facet_id_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(facet_id)),
  CONSTRAINT supplier_facet_supplier_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(supplier_id)),
  -- A vocabulary code rather than an identifier. See `is_facet_code`.
  CONSTRAINT supplier_facet_value_is_code
    CHECK (module_supplier_directory.is_facet_code(value)),
  CONSTRAINT supplier_facet_correlation_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(correlation_id)),
  CONSTRAINT supplier_facet_idempotency_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(idempotency_key)),

  CONSTRAINT supplier_facet_kind_known
    CHECK (facet_kind IN ('category', 'brand', 'capability', 'district')),
  CONSTRAINT supplier_facet_status_known CHECK (status IN ('active', 'withdrawn')),
  CONSTRAINT supplier_facet_withdrawal_agrees
    CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CONSTRAINT supplier_facet_declared_at_finite
    CHECK (declared_at > '-infinity'::timestamptz AND declared_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_supplier_directory.supplier_facet IS
  'What a supplier claims: categories, brands, capabilities and service districts. One table because the four are structurally identical, with a closed CHECK on the kind so it is a discriminated set rather than a bag.';

-- The directory query. Category is the gate, so it leads.
CREATE INDEX IF NOT EXISTS supplier_facet_lookup_idx
  ON module_supplier_directory.supplier_facet (facet_kind, value)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS supplier_facet_supplier_idx
  ON module_supplier_directory.supplier_facet (supplier_id, facet_kind)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Where they trade from, and a merchant's branches
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_supplier_directory.supplier_location (
  location_id     text        NOT NULL,
  supplier_id     text        NOT NULL,
  name            text        NOT NULL,
  district        text        NOT NULL,
  is_primary      boolean     NOT NULL,
  status          text        NOT NULL,
  opened_at       timestamptz NOT NULL,
  closed_at       timestamptz NULL,
  correlation_id  text        NOT NULL,
  idempotency_key text        NOT NULL,

  CONSTRAINT supplier_location_pkey PRIMARY KEY (location_id),
  CONSTRAINT supplier_location_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT supplier_location_id_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(location_id)),
  CONSTRAINT supplier_location_supplier_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(supplier_id)),
  CONSTRAINT supplier_location_district_is_code
    CHECK (module_supplier_directory.is_facet_code(district)),
  CONSTRAINT supplier_location_correlation_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(correlation_id)),
  CONSTRAINT supplier_location_idempotency_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(idempotency_key)),

  CONSTRAINT supplier_location_name_bounded
    CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
  CONSTRAINT supplier_location_status_known CHECK (status IN ('active', 'withdrawn')),
  CONSTRAINT supplier_location_closure_agrees
    CHECK ((status = 'withdrawn') = (closed_at IS NOT NULL)),
  -- A closed branch is not the primary one. "Show the buyer the main branch" must not answer with a
  -- shop that has shut.
  CONSTRAINT supplier_location_closed_is_not_primary
    CHECK (status = 'active' OR is_primary = false),
  CONSTRAINT supplier_location_opened_at_finite
    CHECK (opened_at > '-infinity'::timestamptz AND opened_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_supplier_directory.supplier_location IS
  'Where a supplier trades from, and a merchant''s branches. A district rather than an address: the platform routes on districts, and a precise address is personal data for a sole trader working from home.';

-- At most one primary location per supplier, among the open ones. A partial unique index rather
-- than a CHECK, because the rule spans rows.
CREATE UNIQUE INDEX IF NOT EXISTS supplier_location_one_primary_idx
  ON module_supplier_directory.supplier_location (supplier_id)
  WHERE is_primary = true AND status = 'active';

CREATE INDEX IF NOT EXISTS supplier_location_district_idx
  ON module_supplier_directory.supplier_location (district)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- How it got where it is
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_supplier_directory.directory_event (
  event_id        text        NOT NULL,
  supplier_id     text        NOT NULL,
  from_status     text        NULL,
  to_status       text        NOT NULL,
  reason          text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  correlation_id  text        NOT NULL,
  idempotency_key text        NOT NULL,

  CONSTRAINT directory_event_pkey PRIMARY KEY (event_id),
  CONSTRAINT directory_event_id_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(event_id)),
  CONSTRAINT directory_event_supplier_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(supplier_id)),
  CONSTRAINT directory_event_correlation_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(correlation_id)),
  CONSTRAINT directory_event_idempotency_opaque
    CHECK (module_supplier_directory.is_opaque_identifier(idempotency_key)),
  CONSTRAINT directory_event_from_known
    CHECK (from_status IS NULL
           OR from_status IN ('pending', 'active', 'suspended', 'closed')),
  CONSTRAINT directory_event_to_known
    CHECK (to_status IN ('pending', 'active', 'suspended', 'closed')),
  -- A suspended supplier is entitled to know why, and "suspended" is not a reason.
  CONSTRAINT directory_event_reason_present
    CHECK (length(btrim(reason)) >= 8 AND length(reason) <= 1000),
  CONSTRAINT directory_event_occurred_at_finite
    CHECK (occurred_at > '-infinity'::timestamptz AND occurred_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_supplier_directory.directory_event IS
  'One row per status change. Append-only: a supplier has been told what happened, and rewriting it would make the record disagree.';

CREATE INDEX IF NOT EXISTS directory_event_supplier_idx
  ON module_supplier_directory.directory_event (supplier_id, occurred_at);

-- ---------------------------------------------------------------------------
-- The outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_supplier_directory.outbox (
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

COMMENT ON TABLE module_supplier_directory.outbox IS
  'M-48''s transactional outbox. No declaration travels in an event: what a business sells is useful to its competitors, and a directory that broadcast its own contents would be a market-intelligence feed nobody agreed to publish.';

CREATE INDEX IF NOT EXISTS outbox_claimable_idx
  ON module_supplier_directory.outbox (next_attempt_at NULLS FIRST, recorded_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

-- ---------------------------------------------------------------------------
-- What may never change
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION module_supplier_directory.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  RAISE EXCEPTION
    'table %.% is append-only: the supplier has been told what happened, and rewriting it would make the record disagree',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$body$;

CREATE TRIGGER directory_event_is_append_only
  BEFORE UPDATE OR DELETE ON module_supplier_directory.directory_event
  FOR EACH ROW EXECUTE FUNCTION module_supplier_directory.refuse_mutation();

COMMIT;
