-- migration: 0056_claim_token_covers_a_batch
-- direction: down
-- owner: kernel_event_infrastructure
--
-- Restores the one-row-per-token constraint.
--
-- **This rollback can fail, and that is the correct behaviour.** If any claim in flight covers more
-- than one delivery, restoring `UNIQUE (claim_token)` is impossible without either releasing those
-- claims or rewriting their tokens -- and both mean deciding, on an operator's behalf, that work
-- another worker currently owns should be taken away from it. Refusing is better than either.
--
-- With no in-flight batch on record, this reverses cleanly. Batching stops working again the moment
-- it does.

BEGIN;

DROP INDEX IF EXISTS kernel_event_infrastructure.event_delivery_claim_token_idx;

ALTER TABLE kernel_event_infrastructure.event_delivery
  DROP CONSTRAINT IF EXISTS event_delivery_claim_token_per_delivery;

ALTER TABLE kernel_event_infrastructure.event_delivery
  ADD CONSTRAINT event_delivery_claim_token_unique UNIQUE (claim_token);

COMMIT;
