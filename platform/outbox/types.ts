/**
 * Shared outbox contract (FND-003d).
 *
 * The outbox is the bridge between a module's own transaction and the platform's event/audit log:
 * a module writes its business rows and an outbox row in one transaction, and a relay later reads
 * that row and dispatches it to K-08 Event Infrastructure or K-09 Audit Foundation. Either both
 * the business write and the outbox row exist, or neither does, which is what makes the eventual
 * publication reliable.
 *
 * This module owns only the abstract contract. Concrete outbox tables live in each producing
 * module's schema, and each module's repository implements the insert path. Relays consume the
 * generic reader defined here.
 *
 * Owned by: platform substrate.
 */

export const OUTBOX_KINDS = ['event', 'audit'] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/**
 * An entry waiting to be dispatched.
 *
 * The payload is the complete request that will be handed to the downstream service, so the relay
 * does not need to know how to build an event envelope or an audit record — it only moves what the
 * producer already constructed.
 */
export interface OutboxEntry {
  /** Stable identifier for this outbox row, supplied by the producer. */
  readonly outboxId: string;
  /** Stable across retries of the same logical dispatch. */
  readonly idempotencyKey: string;
  readonly kind: OutboxKind;
  /** The request payload the relay will pass through. */
  readonly payload: unknown;
  /** When the business action happened, according to the producer. */
  readonly recordedAt: string;
  /** Manifest id of the unit that produced this entry, e.g. `K-05`. */
  readonly producer: string;
  /** Ties this entry to the causal chain that produced it. */
  readonly correlationId: string;
  /** The event or record that caused this one, or null when it starts the chain. */
  readonly causationId: string | null;
  /** Set when the relay successfully dispatches the entry. */
  readonly processedAt: string | null;
  /** How many times the relay has tried and failed. */
  readonly retryCount: number;
  /** The most recent failure message, or null. */
  readonly lastError: string | null;
}

/**
 * What a transaction must support for a producing module to append outbox rows atomically with its
 * own writes.
 *
 * Each module's transaction interface extends this one and its repository implements the insert.
 */
export interface OutboxTransaction {
  insertOutbox(entry: OutboxEntry): Promise<void>;
}

/**
 * A source the relay polls for undispatched entries.
 *
 * One source per module schema, so the relay can consume from every producer without owning any
 * module's tables.
 */
export interface OutboxSource {
  readonly name: string;
  readonly schema: string;
  poll(limit: number, now: string): Promise<readonly OutboxEntry[]>;
  markProcessed(outboxId: string, processedAt: string): Promise<void>;
  markError(outboxId: string, error: string, retryCount: number, now: string): Promise<void>;
}
