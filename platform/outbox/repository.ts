/**
 * In-memory reference implementation of the outbox insert path (FND-003d).
 *
 * Each module's in-memory repository owns its own outbox entries. This file provides the shared
 * storage mechanics so every module's reference implementation behaves the same way without
 * duplicating the append-only-with-unique-keys logic.
 *
 * Owned by: platform substrate.
 */

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

  async poll(limit: number, _now: string): Promise<readonly OutboxEntry[]> {
    await Promise.resolve();
    if (limit < 1) return [];
    return this.#entries
      .filter((entry) => entry.processedAt === null)
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
    _now: string,
  ): Promise<void> {
    await Promise.resolve();
    const index = this.#entries.findIndex((entry) => entry.outboxId === outboxId);
    if (index === -1) throw new Error(`outbox row ${outboxId} not found`);
    const existing: OutboxEntry = this.#entries[index] as OutboxEntry;
    const updated: OutboxEntry = {
      ...existing,
      retryCount,
      lastError: error,
    };
    this.#entries[index] = updated;
  }
}
