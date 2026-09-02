-- migration: 0056_claim_token_covers_a_batch
-- direction: up
-- owner: kernel_event_infrastructure
--
-- A claim token identifies one **claim**, and a claim covers a batch of deliveries.
--
-- 0004 wrote that intent in its header and then enforced something stricter:
-- `UNIQUE (claim_token)` allowed a token to appear on exactly one row. So a worker claiming two due
-- deliveries in one call — which is what `claimDueDeliveries(limit)` exists to do — stamped both
-- rows with the same token and violated the constraint. **Batching has never worked against
-- PostgreSQL.** The in-memory repository allowed it, so every unit test passed; the failure needed
-- two events due for one subscription at the same moment, which nothing produced until an
-- end-to-end journey accepted two offers on one tender.
--
-- The failure is not a graceful one either. It is a unique-violation from inside the claim, so the
-- consumer makes no progress at all rather than making progress one row at a time: a subscription
-- with a backlog stops, and the error names a constraint rather than the situation.
--
-- **What the token actually guards** is completion. `completeDelivery`, `rescheduleDelivery` and
-- `deadLetterDelivery` are each conditional on the token still being the current one, so a worker
-- whose lease expired finds nothing to update. That guarantee is per row and needs the token stored
-- per row — it never needed the token to be globally unique.
--
-- **Reuse is still refused**, and has to be: two claims that cannot be told apart defeat the guard
-- above. It moves from a database constraint to an explicit check inside the same transaction as
-- the claim, which is where the in-memory repository has always done it — so the two now agree
-- rather than one being quietly stricter than the other.
--
-- This migration touches no other unit's schema.

BEGIN;

ALTER TABLE kernel_event_infrastructure.event_delivery
  DROP CONSTRAINT IF EXISTS event_delivery_claim_token_unique;

-- A token appears once per delivery, which is what "one row per (claim, delivery)" means. It does
-- not stop a token covering several deliveries, because that is what a batch is.
ALTER TABLE kernel_event_infrastructure.event_delivery
  ADD CONSTRAINT event_delivery_claim_token_per_delivery UNIQUE (claim_token, delivery_id);

COMMENT ON CONSTRAINT event_delivery_claim_token_per_delivery
  ON kernel_event_infrastructure.event_delivery IS
  'A claim token identifies one claim, and a claim may cover a batch. Reuse across claims is refused inside claimDueDeliveries, in the same transaction, exactly as the in-memory repository does.';

-- What the claim actually reads to detect reuse. Without it every claim scans the table.
CREATE INDEX IF NOT EXISTS event_delivery_claim_token_idx
  ON kernel_event_infrastructure.event_delivery (claim_token)
  WHERE claim_token IS NOT NULL;

COMMIT;
