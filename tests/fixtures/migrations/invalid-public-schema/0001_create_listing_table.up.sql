-- migration: 0001_create_listing_table
-- direction: up
-- owner: module_universal_listing
--
-- Module data placed in the default schema: on the default search_path, reachable by every unit
-- and owned by none.

BEGIN;

CREATE TABLE IF NOT EXISTS public.listing (
  id uuid NOT NULL,
  CONSTRAINT listing_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS listing_audit (
  id uuid NOT NULL
);

COMMIT;
