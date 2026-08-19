-- migration: 0001_create_listing_table
-- direction: down
-- owner: module_universal_listing

BEGIN;
DROP TABLE IF EXISTS module_universal_listing.listing;
COMMIT;
