-- migration: 0038_add_kernel_ledger_foundation_outbox_relay_columns
-- direction: up
-- owner: kernel_ledger_foundation
--
-- Give kernel_ledger_foundation's outbox what a production relay needs: a time before which a failed row must not
-- be retried, and a way to stop retrying a row that will never succeed.
--
-- The outbox contract shipped with `retry_count` and `last_error`, which record what happened but
-- do not change what happens next. A relay reading only those retries a failing row on every poll,
-- so a downstream outage becomes a tight loop against the thing that is already struggling, and a
-- permanently poisoned row is retried until somebody notices — which, for a row nothing else waits
-- on, is usually never.
--
--   * `next_attempt_at` — the relay skips the row until this instant. NULL means eligible now,
--     which is what every existing row means, and why the column is nullable rather than defaulted
--     to a timestamp nobody chose.
--   * `dead_lettered_at` — set when the relay gives up. A dead-lettered row is **not** processed:
--     `processed_at` stays NULL because it never was dispatched. It is simply no longer claimed.
--   * `dead_letter_reason` — why. A row abandoned without a reason is a support ticket.
--
-- The outbox is a platform contract, but each unit owns its own table, so this change lands once per
-- owner rather than as one migration reaching across fifteen namespaces. `check:migrations` refuses
-- the latter, and it is right to.
--
-- **Additive only.** Every column is nullable with no default, so no existing row is rewritten.

BEGIN;

ALTER TABLE kernel_ledger_foundation.outbox
  ADD COLUMN IF NOT EXISTS next_attempt_at    timestamptz NULL,
  ADD COLUMN IF NOT EXISTS dead_lettered_at   timestamptz NULL,
  ADD COLUMN IF NOT EXISTS dead_letter_reason text        NULL;

-- A dead-letter decision nobody can reconstruct is worse than none.
ALTER TABLE kernel_ledger_foundation.outbox
  DROP CONSTRAINT IF EXISTS outbox_dead_letter_is_explained;

ALTER TABLE kernel_ledger_foundation.outbox
  ADD CONSTRAINT outbox_dead_letter_is_explained
    CHECK ((dead_lettered_at IS NULL) = (dead_letter_reason IS NULL));

-- A dead-lettered row was never dispatched. Marking it processed would tell every reader the
-- opposite of what happened.
ALTER TABLE kernel_ledger_foundation.outbox
  DROP CONSTRAINT IF EXISTS outbox_dead_letter_is_not_processed;

ALTER TABLE kernel_ledger_foundation.outbox
  ADD CONSTRAINT outbox_dead_letter_is_not_processed
    CHECK (dead_lettered_at IS NULL OR processed_at IS NULL);

-- The claim index: what the relay actually scans. Rows already dispatched or given up on are not in
-- it at all, so it stays the size of the backlog rather than the size of history.
DROP INDEX IF EXISTS kernel_ledger_foundation.outbox_claimable_idx;

CREATE INDEX outbox_claimable_idx
  ON kernel_ledger_foundation.outbox (next_attempt_at NULLS FIRST, recorded_at, outbox_id)
  WHERE processed_at IS NULL AND dead_lettered_at IS NULL;

COMMENT ON COLUMN kernel_ledger_foundation.outbox.next_attempt_at IS
  'The relay skips this row until this instant. NULL means eligible now.';

COMMENT ON COLUMN kernel_ledger_foundation.outbox.dead_lettered_at IS
  'When the relay gave up. The row was never dispatched, so processed_at stays NULL.';

COMMIT;
