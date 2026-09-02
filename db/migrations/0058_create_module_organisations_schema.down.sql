-- migration: 0058_create_module_organisations_schema
-- direction: down
-- owner: module_organisations
--
-- Drops M-49's schema and everything in it.
--
-- What is lost is every business and every membership: who trades as an organisation, and which
-- people may act for it. Nothing breaks mechanically -- no other schema holds a foreign key into
-- this one -- but the accounts those businesses trade under survive in M-04, M-11, M-13 and M-48
-- with nobody able to act in them. Their listings, orders and wallets remain, owned by an account
-- that no longer has a single person attached to it, and the only way back is to recreate the
-- organisations and re-invite everybody.

BEGIN;

DROP TRIGGER IF EXISTS membership_keeps_an_owner
  ON module_organisations.organisation_membership;
DROP TRIGGER IF EXISTS organisation_event_is_append_only
  ON module_organisations.organisation_event;
DROP TRIGGER IF EXISTS membership_event_is_append_only
  ON module_organisations.membership_event;

DROP FUNCTION IF EXISTS module_organisations.membership_keeps_an_owner();
DROP FUNCTION IF EXISTS module_organisations.refuse_mutation();

DROP TABLE IF EXISTS module_organisations.outbox;
DROP TABLE IF EXISTS module_organisations.organisation_event;
DROP TABLE IF EXISTS module_organisations.membership_event;
DROP TABLE IF EXISTS module_organisations.organisation_membership;
DROP TABLE IF EXISTS module_organisations.organisation;

DROP FUNCTION IF EXISTS module_organisations.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_organisations;

COMMIT;
