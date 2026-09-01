-- migration: 0033_add_kernel_ai_gateway_outbox_relay_columns
-- direction: down
-- owner: kernel_ai_gateway
--
-- Reverses 0033.
--
-- **Rolling back discards scheduling and dead-letter state.** A row that had been given up on
-- becomes an ordinary undispatched row again and the relay will pick it up on its next poll. That is
-- the correct behaviour — the operator has removed the mechanism that decided to give up, so the
-- decision goes with it — but it is not silent, and an operator rolling back with a poisoned row on
-- record should expect to see it retried.

BEGIN;

DROP INDEX IF EXISTS kernel_ai_gateway.outbox_claimable_idx;

ALTER TABLE kernel_ai_gateway.outbox
  DROP CONSTRAINT IF EXISTS outbox_dead_letter_is_not_processed;

ALTER TABLE kernel_ai_gateway.outbox
  DROP CONSTRAINT IF EXISTS outbox_dead_letter_is_explained;

ALTER TABLE kernel_ai_gateway.outbox
  DROP COLUMN IF EXISTS dead_letter_reason,
  DROP COLUMN IF EXISTS dead_lettered_at,
  DROP COLUMN IF EXISTS next_attempt_at;

COMMIT;
