-- migration: 0026_create_module_universal_listing_schema
-- direction: down
-- owner: module_universal_listing
--
-- Reverses 0026. Nothing outside M-04 depends on these objects and the migration ledger that
-- records this rollback lives in another schema, so the reversal is genuine.
--
-- Order matters. The triggers reference `refuse_mutation`, so they go first. The tables' CHECK
-- constraints reference `is_opaque_identifier`, so the tables go before that function.

BEGIN;

DROP INDEX IF EXISTS module_universal_listing.outbox_unprocessed_idx;

DROP INDEX IF EXISTS module_universal_listing.listing_declaration_listing_idx;
DROP INDEX IF EXISTS module_universal_listing.listing_declaration_version_idx;

DROP INDEX IF EXISTS module_universal_listing.listing_media_listing_idx;
DROP INDEX IF EXISTS module_universal_listing.listing_media_version_idx;

DROP INDEX IF EXISTS module_universal_listing.listing_version_listing_idx;

DROP INDEX IF EXISTS module_universal_listing.listing_status_idx;
DROP INDEX IF EXISTS module_universal_listing.listing_commerce_unit_type_idx;
DROP INDEX IF EXISTS module_universal_listing.listing_account_idx;

DROP TRIGGER IF EXISTS listing_declaration_is_append_only
  ON module_universal_listing.listing_declaration;

DROP TRIGGER IF EXISTS listing_media_is_append_only
  ON module_universal_listing.listing_media;

DROP TRIGGER IF EXISTS listing_version_is_append_only
  ON module_universal_listing.listing_version;

DROP TABLE IF EXISTS module_universal_listing.outbox;

DROP TABLE IF EXISTS module_universal_listing.listing_declaration;

DROP TABLE IF EXISTS module_universal_listing.listing_media;

DROP TABLE IF EXISTS module_universal_listing.listing_version;

DROP TABLE IF EXISTS module_universal_listing.listing;

DROP FUNCTION IF EXISTS module_universal_listing.refuse_mutation();

DROP FUNCTION IF EXISTS module_universal_listing.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_universal_listing RESTRICT;

COMMIT;
