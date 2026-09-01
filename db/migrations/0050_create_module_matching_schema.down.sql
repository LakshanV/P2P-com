-- migration: 0050_create_module_matching_schema
-- direction: down
-- owner: module_matching
--
-- Drops M-07's schema and everything in it.
--
-- What is lost is the record of what the platform tried. No Need, no order and no payment depends on
-- it, so nothing breaks — but the answer to "why did this become an RFQ" goes with it, and that
-- answer cannot be reconstructed afterwards: supply changes, and a run is evidence of what could be
-- found at one moment that has passed.

BEGIN;

DROP TRIGGER IF EXISTS match_candidate_is_append_only ON module_matching.match_candidate;
DROP TRIGGER IF EXISTS rung_attempt_is_append_only ON module_matching.rung_attempt;
DROP TRIGGER IF EXISTS match_run_is_append_only ON module_matching.match_run;

DROP FUNCTION IF EXISTS module_matching.refuse_mutation();

DROP TABLE IF EXISTS module_matching.outbox;
DROP TABLE IF EXISTS module_matching.match_candidate;
DROP TABLE IF EXISTS module_matching.rung_attempt;
DROP TABLE IF EXISTS module_matching.match_run;

DROP FUNCTION IF EXISTS module_matching.is_opaque_identifier(text);

DROP SCHEMA IF EXISTS module_matching;

COMMIT;
