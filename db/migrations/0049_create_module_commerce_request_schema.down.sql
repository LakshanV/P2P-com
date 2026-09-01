-- migration: 0049_create_module_commerce_request_schema
-- direction: down
-- owner: module_commerce_request
--
-- Drops M-03's schema and everything in it.
--
-- **This destroys what customers said.** Not a derived table, not a cache: `request.raw_text` is the
-- only place the platform keeps what somebody actually asked for, and no other schema holds a copy —
-- M-03's events deliberately publish the length rather than the words, precisely so a person's
-- request does not end up scattered across the platform. Rolling this back is therefore permanent
-- for that data, and rolling forward again produces an empty schema.
--
-- It is written anyway, because a migration that cannot be undone is one nobody can deploy on a
-- Friday, and because refusing to write it would not make the data any safer. The cost is recorded
-- here rather than discovered.

BEGIN;

DROP TRIGGER IF EXISTS request_event_is_append_only
  ON module_commerce_request.request_event;
DROP TRIGGER IF EXISTS request_media_is_append_only
  ON module_commerce_request.request_media;
DROP TRIGGER IF EXISTS request_interpretation_is_append_only
  ON module_commerce_request.request_interpretation;
DROP TRIGGER IF EXISTS request_raw_text_is_write_once
  ON module_commerce_request.request;

DROP FUNCTION IF EXISTS module_commerce_request.refuse_mutation();
DROP FUNCTION IF EXISTS module_commerce_request.request_immutable_columns();

DROP TABLE IF EXISTS module_commerce_request.outbox;
DROP TABLE IF EXISTS module_commerce_request.request_event;
DROP TABLE IF EXISTS module_commerce_request.request_media;
DROP TABLE IF EXISTS module_commerce_request.request_interpretation;
DROP TABLE IF EXISTS module_commerce_request.request;

DROP FUNCTION IF EXISTS module_commerce_request.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_commerce_request;

COMMIT;
