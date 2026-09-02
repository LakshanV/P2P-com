-- migration: 0053_create_module_quotes_schema
-- direction: down
-- owner: module_quotes
--
-- Drops M-10's schema and everything in it.
--
-- What is lost is every offer the market made. An awarded tender in M-09 names a winning quote id
-- that would then point at nothing, and an order opened from an accepted offer would no longer be
-- able to show the terms it was opened on. Nothing breaks mechanically — the reference is a text
-- column, not a foreign key across a schema boundary — but a supplier who quoted and a buyer who
-- accepted both have a legitimate interest in that offer still existing.

BEGIN;

DROP TRIGGER IF EXISTS quote_terms_are_immutable ON module_quotes.quote;

DROP FUNCTION IF EXISTS module_quotes.refuse_term_change();

DROP TABLE IF EXISTS module_quotes.outbox;
DROP TABLE IF EXISTS module_quotes.quote;

DROP FUNCTION IF EXISTS module_quotes.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_quotes;

COMMIT;
