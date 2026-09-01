-- migration: 0052_create_module_rfq_schema
-- direction: down
-- owner: module_rfq
--
-- Drops M-09's schema and everything in it.
--
-- What is lost is the record of what was asked of whom. No Need and no order depends on it, so
-- nothing breaks — but a supplier who quoted has a legitimate interest in the tender they quoted for
-- still existing, and an award that no longer names a tender cannot be explained to the suppliers
-- who lost.

BEGIN;

DROP TRIGGER IF EXISTS rfq_event_is_append_only ON module_rfq.rfq_event;
DROP TRIGGER IF EXISTS rfq_invitation_is_append_only ON module_rfq.rfq_invitation;

DROP FUNCTION IF EXISTS module_rfq.refuse_mutation();

DROP TABLE IF EXISTS module_rfq.outbox;
DROP TABLE IF EXISTS module_rfq.rfq_event;
DROP TABLE IF EXISTS module_rfq.rfq_invitation;
DROP TABLE IF EXISTS module_rfq.rfq;

DROP FUNCTION IF EXISTS module_rfq.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_rfq;

COMMIT;
