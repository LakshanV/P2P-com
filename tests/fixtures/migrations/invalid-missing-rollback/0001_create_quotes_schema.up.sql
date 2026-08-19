-- migration: 0001_create_quotes_schema
-- direction: up
-- owner: module_quotes

BEGIN;
CREATE SCHEMA IF NOT EXISTS module_quotes;
COMMIT;
