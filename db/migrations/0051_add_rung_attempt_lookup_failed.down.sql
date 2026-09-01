-- migration: 0051_add_rung_attempt_lookup_failed
-- direction: down
-- owner: module_matching
--
-- Narrows the outcome vocabulary back to 0050's five.
--
-- **This can fail, by design.** If any `rung_attempt` row records `lookup-failed`, the CHECK cannot
-- be added and the migration stops. That is the correct behaviour: the alternatives are to destroy
-- the distinction by rewriting those rows to `unavailable` — which would turn an operational failure
-- into a configuration choice in the historical record — or to drop the rows entirely, which would
-- erase evidence of an outage. A rollback that silently rewrites history is worse than one that
-- refuses, so an operator who genuinely wants this must decide what to do with those rows first.

BEGIN;

ALTER TABLE module_matching.rung_attempt
  DROP CONSTRAINT IF EXISTS rung_attempt_outcome_known;

ALTER TABLE module_matching.rung_attempt
  ADD CONSTRAINT rung_attempt_outcome_known
    CHECK (outcome IN ('satisfied', 'insufficient', 'empty', 'unavailable', 'skipped'));

COMMIT;
