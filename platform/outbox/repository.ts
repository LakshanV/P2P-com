/**
 * In-memory reference implementation of the outbox insert path (FND-003d).
 *
 * Each module's in-memory repository owns its own outbox entries. This file provides the shared
 * storage mechanics so every module's reference implementation behaves the same way without
 * duplicating the append-only-with-unique-keys logic.
 *
 * Owned by: platform substrate.
 */

import { parseInstant } from '../time/instant.ts';

import type { OutboxEntry, OutboxSource } from './types.ts';

/**
 * A simple append-only store for outbox rows, plus the polling and marking operations a relay
 * needs. Two rows may not share an outbox id or an idempotency key.
 */
export class InMemoryOutboxStore implements OutboxSource {
  readonly #name: string;
  readonly #schema: string;
  #entries: OutboxEntry[] = [];

  constructor(name: string, schema: string) {
    this.#name = name;
    this.#schema = schema;
  }

  get name(): string {
    return this.#name;
  }

  get schema(): string {
    return this.#schema;
  }

  entries(): readonly OutboxEntry[] {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(entries: readonly OutboxEntry[]): void {
    this.#entries = entries.map((entry) => ({ ...entry }));
  }

  insert(entry: OutboxEntry): void {
    if (this.#entries.some((existing) => existing.outboxId === entry.outboxId)) {
      throw new Error(
        `outbox row ${entry.outboxId} already exists; an outbox id is stable for the life of the row`,
      );
    }
    if (this.#entries.some((existing) => existing.idempotencyKey === entry.idempotencyKey)) {
      throw new Error(
        `outbox idempotency key "${entry.idempotencyKey}" was already used by another row`,
      );
    }
    this.#entries.push({ ...entry });
  }

  /**
   * Claim up to `limit` entries that are due at `now`.
   *
   * Due means: never dispatched, never given up on, and either eligible immediately or past its
   * scheduled retry.
   *
   * The comparison parses both instants rather than comparing the strings. `formatInstant` trims
   * trailing zeros — `09:00:02Z` and `09:00:02.000000Z` are the same instant written two ways —
   * so lexical order is *not* chronological order, and a string comparison would have this
   * reference implementation disagree with the PostgreSQL adapter, which compares as
   * `timestamptz`. Two implementations of one contract disagreeing about which rows are due is the
   * kind of divergence that only shows up under load.
   */
  async poll(limit: number, now: string): Promise<readonly OutboxEntry[]> {
    await Promise.resolve();
    if (limit < 1) return [];
    const at = parseInstant(now).epochMicros;
    return this.#entries
      .filter(
        (entry) =>
          entry.processedAt === null &&
          entry.deadLetteredAt === null &&
          (entry.nextAttemptAt === null || parseInstant(entry.nextAttemptAt).epochMicros <= at),
      )
      .sort(
        (a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.outboxId.localeCompare(b.outboxId),
      )
      .slice(0, limit);
  }

  async markProcessed(outboxId: string, processedAt: string): Promise<void> {
    await Promise.resolve();
    const index = this.#entries.findIndex((entry) => entry.outboxId === outboxId);
    if (index === -1) throw new Error(`outbox row ${outboxId} not found`);
    const existing: OutboxEntry = this.#entries[index] as OutboxEntry;
    const updated: OutboxEntry = {
      ...existing,
      processedAt,
      lastError: null,
    };
    this.#entries[index] = updated;
  }

  async markError(
    outboxId: string,
    error: string,
    retryCount: number,
    nextAttemptAt: string,
  ): Promise<void> {
    await Promise.resolve();
    const index = this.#entries.findIndex((entry) => entry.outboxId === outboxId);
    if (index === -1) throw new Error(`outbox row ${outboxId} not found`);
    const existing: OutboxEntry = this.#entries[index] as OutboxEntry;
    const updated: OutboxEntry = {
      ...existing,
      retryCount,
      lastError: error,
      nextAttemptAt,
    };
    this.#entries[index] = updated;
  }

  /**
   * Give up on an entry.
   *
   * `processedAt` deliberately stays null: the entry was never dispatched, and saying otherwise
   * would tell every reader the opposite of what happened. The row simply leaves the claimable set.
   */
  async markDeadLettered(
    outboxId: string,
    reason: string,
    retryCount: number,
    deadLetteredAt: string,
  ): Promise<void> {
    await Promise.resolve();
    const index = this.#entries.findIndex((entry) => entry.outboxId === outboxId);
    if (index === -1) throw new Error(`outbox row ${outboxId} not found`);
    const existing: OutboxEntry = this.#entries[index] as OutboxEntry;
    this.#entries[index] = {
      ...existing,
      retryCount,
      lastError: reason,
      deadLetteredAt,
      deadLetterReason: reason,
      nextAttemptAt: null,
    };
  }
}
