-- migration: 0051_add_rung_attempt_lookup_failed
-- direction: up
-- owner: module_matching
--
-- Splits `unavailable` into two outcomes, because it was carrying two different facts.
--
-- 0050 recorded both "no adapter is wired for this rung" and "the adapter was called and failed" as
-- `unavailable`. Both are correctly distinct from `empty` — neither establishes anything about the
-- world — but they are not the same as each other, and the difference decides what somebody does
-- next:
--
--   * `unavailable` is a **configuration** fact. This deployment has not wired an external discovery
--     provider, so that rung was never going to answer. Nobody is paged; the ladder is working as
--     configured.
--   * `lookup-failed` is an **operational** fact. The supplier directory was called and it broke.
--     Somebody should be paged, and until they are, every Need is escalating to RFQ for a reason
--     that has nothing to do with supply.
--
-- Conflating them means a broken directory looks exactly like a deployment choice, and the alert
-- nobody wrote is the alert nobody misses.
--
-- A widening of a CHECK constraint. No existing row can be invalidated by it, and the rollback can
-- fail by design: narrowing it again with `lookup-failed` rows on record would either destroy the
-- distinction or refuse, and refusing is the correct answer.
--
-- This migration touches no other unit's schema.

BEGIN;

ALTER TABLE module_matching.rung_attempt
  DROP CONSTRAINT IF EXISTS rung_attempt_outcome_known;

ALTER TABLE module_matching.rung_attempt
  ADD CONSTRAINT rung_attempt_outcome_known
    CHECK (outcome IN ('satisfied', 'insufficient', 'empty', 'unavailable', 'lookup-failed',
                       'skipped'));

COMMENT ON COLUMN module_matching.rung_attempt.outcome IS
  'What the rung did. "empty" means it looked and found nothing; "unavailable" means no adapter is wired, which is a configuration fact; "lookup-failed" means the adapter was called and broke, which is an operational one. The three are deliberately distinct: only the last should page anybody.';

COMMIT;
