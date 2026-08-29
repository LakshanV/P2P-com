-- migration: 0026_create_module_universal_listing_schema
-- direction: up
-- owner: module_universal_listing
--
-- M-04 Universal Listing's own namespace and the listing half of its data. The inventory interface
-- — the replaceability requirement — is a later migration and is deliberately not here: an
-- interface that must be replaceable is worth building against its own contract tests rather than
-- alongside the thing it serves.
--
-- Owned data:
--   * `listing`             — the stable identity of an offer to supply one CommerceUnit type, and
--     its current status.
--   * `listing_version`     — one row per published version. Append-only and immutable.
--   * `listing_media`       — opaque references to media artefacts stored elsewhere. Append-only.
--   * `listing_declaration` — what the supplier asserts about what they are offering. Append-only.
--   * `outbox`              — the module's transactional outbox for K-08 events and K-09 audit
--     records.
--
-- **A listing is versioned, never edited.** An order placed in March is against version 3, and
-- publishing version 4 in June does not rewrite what was agreed. That is why `listing_version`,
-- `listing_media` and `listing_declaration` all carry append-only triggers: the claims a dispute is
-- judged against must be the claims that were actually made.
--
-- **Money is `bigint` minor units.** No `double precision`, `real` or `money` column exists in this
-- schema, and `tests/migrations.test.ts` asserts as much for the financial schemas. A price that
-- cannot be represented exactly is a price somebody eventually disputes.
--
-- `listing_media.reference` is an opaque handle to an artefact another system stores, subject to the
-- same `is_opaque_identifier` rule set as every identifier here — the same decision M-02 made about
-- evidence, for the same reason: a listing outlives its media, and a URL or a natural key written
-- into one is disclosed for as long as the platform exists.
--
-- `account_id` is an opaque K-03 id and `commerce_unit_type_id` an opaque K-11 id. Neither is a
-- foreign key: MODULE_MAP.md §10.4 forbids one unit joining to another's tables, because a join is
-- the coupling that makes later extraction to a service impossible.
--
-- `is_opaque_identifier` is M-04's own copy of the rule set every other unit carries, in M-04's
-- schema, for the same ownership reason. The copies are required to be character-for-character
-- identical by `tests/migrations.test.ts`.
--
-- This migration touches no other unit's schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS module_universal_listing;

COMMENT ON SCHEMA module_universal_listing IS
  'M-04 Universal Listing. Listings, their immutable versions, media references, declarations and the module outbox.';

-- Character-for-character identical to the copies in every other unit's schema, and required to
-- stay so by test.
CREATE OR REPLACE FUNCTION module_universal_listing.is_opaque_identifier(value text)
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

COMMENT ON FUNCTION module_universal_listing.is_opaque_identifier(text) IS
  'True when the value is an opaque internal handle: not an email, telephone, document number, IBAN, URL, domain, personal name or credential.';

-- ---------------------------------------------------------------------------
-- Listing: the stable identity of an offer
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_universal_listing.listing (
  listing_id              text        NOT NULL,
  account_id              text        NOT NULL,
  commerce_unit_type_id   text        NOT NULL,
  status                  text        NOT NULL,
  current_version         integer     NOT NULL,
  created_at              timestamptz NOT NULL,
  updated_at              timestamptz NOT NULL,
  published_at            timestamptz NULL,
  withdrawn_at            timestamptz NULL,
  correlation_id          text        NOT NULL,
  idempotency_key         text        NOT NULL,

  CONSTRAINT listing_pkey PRIMARY KEY (listing_id),
  CONSTRAINT listing_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT listing_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(listing_id)),
  CONSTRAINT listing_account_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(account_id)),
  CONSTRAINT listing_commerce_unit_type_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(commerce_unit_type_id)),
  CONSTRAINT listing_correlation_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(correlation_id)),
  CONSTRAINT listing_idempotency_key_opaque
    CHECK (module_universal_listing.is_opaque_identifier(idempotency_key)),
  CONSTRAINT listing_status_known
    CHECK (status IN ('draft', 'published', 'suspended', 'withdrawn')),
  CONSTRAINT listing_current_version_non_negative
    CHECK (current_version >= 0),
  -- A draft has published nothing, and anything that has left draft has. The version counter and
  -- the status cannot disagree about whether an offer was ever made.
  CONSTRAINT listing_draft_has_no_version
    CHECK ((status = 'draft') = (current_version = 0)),
  CONSTRAINT listing_published_at_matches_version
    CHECK ((current_version > 0) = (published_at IS NOT NULL)),
  CONSTRAINT listing_withdrawn_at_matches_status
    CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CONSTRAINT listing_created_at_finite
    CHECK (created_at > '-infinity'::timestamptz AND created_at < 'infinity'::timestamptz),
  CONSTRAINT listing_updated_at_finite
    CHECK (updated_at > '-infinity'::timestamptz AND updated_at < 'infinity'::timestamptz),
  CONSTRAINT listing_published_at_finite
    CHECK (published_at IS NULL
      OR (published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz)),
  CONSTRAINT listing_withdrawn_at_finite
    CHECK (withdrawn_at IS NULL
      OR (withdrawn_at > '-infinity'::timestamptz AND withdrawn_at < 'infinity'::timestamptz))
);

COMMENT ON TABLE module_universal_listing.listing IS
  'The stable identity of an offer to supply one CommerceUnit type. account_id and commerce_unit_type_id are opaque ids, not foreign keys.';

CREATE INDEX IF NOT EXISTS listing_account_idx
  ON module_universal_listing.listing (account_id);

CREATE INDEX IF NOT EXISTS listing_commerce_unit_type_idx
  ON module_universal_listing.listing (commerce_unit_type_id);

CREATE INDEX IF NOT EXISTS listing_status_idx
  ON module_universal_listing.listing (status);

-- ---------------------------------------------------------------------------
-- Listing version: what was on offer, as it was on offer
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_universal_listing.listing_version (
  version_id          text        NOT NULL,
  listing_id          text        NOT NULL,
  version_number      integer     NOT NULL,
  title               text        NOT NULL,
  description         text        NOT NULL,
  unit_price_minor    bigint      NOT NULL,
  currency            text        NOT NULL,
  quantity_available  bigint      NOT NULL,
  attributes          jsonb       NOT NULL,
  published_at        timestamptz NOT NULL,
  correlation_id      text        NOT NULL,
  idempotency_key     text        NOT NULL,

  CONSTRAINT listing_version_pkey PRIMARY KEY (version_id),
  CONSTRAINT listing_version_idempotency_unique UNIQUE (idempotency_key),
  -- Version numbers are per listing and never reused. This is the constraint an order relies on
  -- when it pins "listing L, version 3": that pair identifies exactly one set of terms, forever.
  CONSTRAINT listing_version_number_unique UNIQUE (listing_id, version_number),

  CONSTRAINT listing_version_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(version_id)),
  CONSTRAINT listing_version_listing_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(listing_id)),
  CONSTRAINT listing_version_correlation_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(correlation_id)),
  CONSTRAINT listing_version_idempotency_key_opaque
    CHECK (module_universal_listing.is_opaque_identifier(idempotency_key)),
  CONSTRAINT listing_version_number_positive
    CHECK (version_number >= 1),
  CONSTRAINT listing_version_title_present
    CHECK (length(btrim(title)) > 0 AND length(title) <= 200),
  CONSTRAINT listing_version_description_present
    CHECK (length(btrim(description)) > 0 AND length(description) <= 5000),
  -- Money is an exact integer in minor units. A negative price is not a discount, it is a defect.
  CONSTRAINT listing_version_unit_price_non_negative
    CHECK (unit_price_minor >= 0),
  CONSTRAINT listing_version_quantity_non_negative
    CHECK (quantity_available >= 0),
  CONSTRAINT listing_version_currency_well_formed
    CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT listing_version_published_at_finite
    CHECK (published_at > '-infinity'::timestamptz AND published_at < 'infinity'::timestamptz),
  CONSTRAINT listing_version_attributes_object
    CHECK (jsonb_typeof(attributes) = 'object')
);

COMMENT ON TABLE module_universal_listing.listing_version IS
  'One published version of a listing. Append-only and immutable: an order pins a version, and the version must still say what it said.';

CREATE INDEX IF NOT EXISTS listing_version_listing_idx
  ON module_universal_listing.listing_version (listing_id, version_number);

-- ---------------------------------------------------------------------------
-- Listing media: a reference to an artefact somebody else stores
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_universal_listing.listing_media (
  media_id          text        NOT NULL,
  listing_id        text        NOT NULL,
  version_id        text        NOT NULL,
  kind              text        NOT NULL,
  reference         text        NOT NULL,
  position          integer     NOT NULL,
  caption           text        NOT NULL,
  added_at          timestamptz NOT NULL,
  correlation_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT listing_media_pkey PRIMARY KEY (media_id),
  CONSTRAINT listing_media_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT listing_media_position_unique UNIQUE (version_id, position),

  CONSTRAINT listing_media_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(media_id)),
  CONSTRAINT listing_media_listing_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(listing_id)),
  CONSTRAINT listing_media_version_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(version_id)),
  CONSTRAINT listing_media_correlation_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(correlation_id)),
  CONSTRAINT listing_media_idempotency_key_opaque
    CHECK (module_universal_listing.is_opaque_identifier(idempotency_key)),
  -- The same rule every identifier obeys, for the same reason M-02 applies it to evidence: this
  -- column holds a handle to an artefact, never the artefact and never a URL to it.
  CONSTRAINT listing_media_reference_opaque
    CHECK (module_universal_listing.is_opaque_identifier(reference)),
  CONSTRAINT listing_media_kind_known
    CHECK (kind IN ('image', 'video', 'document')),
  CONSTRAINT listing_media_position_non_negative
    CHECK (position >= 0),
  CONSTRAINT listing_media_caption_present
    CHECK (length(btrim(caption)) > 0 AND length(caption) <= 500),
  CONSTRAINT listing_media_added_at_finite
    CHECK (added_at > '-infinity'::timestamptz AND added_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_universal_listing.listing_media IS
  'An opaque reference to a media artefact stored elsewhere, pinned to one listing version. Append-only.';

CREATE INDEX IF NOT EXISTS listing_media_version_idx
  ON module_universal_listing.listing_media (version_id, position);

CREATE INDEX IF NOT EXISTS listing_media_listing_idx
  ON module_universal_listing.listing_media (listing_id);

-- ---------------------------------------------------------------------------
-- Listing declaration: what the supplier asserts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_universal_listing.listing_declaration (
  declaration_id    text        NOT NULL,
  listing_id        text        NOT NULL,
  version_id        text        NOT NULL,
  kind              text        NOT NULL,
  statement         text        NOT NULL,
  declared_at       timestamptz NOT NULL,
  correlation_id    text        NOT NULL,
  idempotency_key   text        NOT NULL,

  CONSTRAINT listing_declaration_pkey PRIMARY KEY (declaration_id),
  CONSTRAINT listing_declaration_idempotency_unique UNIQUE (idempotency_key),

  CONSTRAINT listing_declaration_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(declaration_id)),
  CONSTRAINT listing_declaration_listing_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(listing_id)),
  CONSTRAINT listing_declaration_version_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(version_id)),
  CONSTRAINT listing_declaration_correlation_id_opaque
    CHECK (module_universal_listing.is_opaque_identifier(correlation_id)),
  CONSTRAINT listing_declaration_idempotency_key_opaque
    CHECK (module_universal_listing.is_opaque_identifier(idempotency_key)),
  CONSTRAINT listing_declaration_kind_known
    CHECK (kind IN ('condition', 'origin', 'compliance', 'warranty', 'restriction')),
  CONSTRAINT listing_declaration_statement_present
    CHECK (length(btrim(statement)) > 0 AND length(statement) <= 2000),
  CONSTRAINT listing_declaration_declared_at_finite
    CHECK (declared_at > '-infinity'::timestamptz AND declared_at < 'infinity'::timestamptz)
);

COMMENT ON TABLE module_universal_listing.listing_declaration IS
  'What the supplier asserts about one listing version. Append-only: these are the claims a dispute is judged against.';

CREATE INDEX IF NOT EXISTS listing_declaration_version_idx
  ON module_universal_listing.listing_declaration (version_id, declared_at, declaration_id);

CREATE INDEX IF NOT EXISTS listing_declaration_listing_idx
  ON module_universal_listing.listing_declaration (listing_id);

-- ---------------------------------------------------------------------------
-- Outbox: the module's transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS module_universal_listing.outbox (
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

COMMENT ON TABLE module_universal_listing.outbox IS
  'Transactional outbox for listing events and audit records, dispatched by a relay.';

CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON module_universal_listing.outbox (recorded_at, outbox_id)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Append-only, enforced by the database
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION module_universal_listing.refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION
    'Listing versions, media and declarations are append-only: % on % is refused',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$guard$;

COMMENT ON FUNCTION module_universal_listing.refuse_mutation() IS
  'Raises on any UPDATE or DELETE against an append-only table in this schema.';

CREATE TRIGGER listing_version_is_append_only
  BEFORE UPDATE OR DELETE ON module_universal_listing.listing_version
  FOR EACH ROW EXECUTE FUNCTION module_universal_listing.refuse_mutation();

CREATE TRIGGER listing_media_is_append_only
  BEFORE UPDATE OR DELETE ON module_universal_listing.listing_media
  FOR EACH ROW EXECUTE FUNCTION module_universal_listing.refuse_mutation();

CREATE TRIGGER listing_declaration_is_append_only
  BEFORE UPDATE OR DELETE ON module_universal_listing.listing_declaration
  FOR EACH ROW EXECUTE FUNCTION module_universal_listing.refuse_mutation();

COMMIT;
