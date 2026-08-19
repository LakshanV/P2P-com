/**
 * K-09 Audit Foundation — the persistence port (FND-003c).
 *
 * Two operations and a read. That is the entire surface, and the shortness is the design:
 *
 *   - `insertRecord` — append, refusing a duplicate id or a reused idempotency key
 *   - `findRecordById` / `findRecordByIdempotencyKey` — read one
 *   - `queryRecords` — read many, filtered, in a stable order, a page at a time
 *
 * **There is no update and no delete.** Not a restricted one, not an internal one. A port that
 * offered either would make every record conditional on nobody having used it, and an audit trail
 * that can be edited is not evidence of anything. `tests/audit-repository.test.ts` inspects the
 * transaction object at runtime and fails if an operation matching update or delete ever appears —
 * a rule enforced by a type is a rule a cast can undo.
 *
 * Ordering is `(recordedAt, recordId)` ascending, never `recordedAt` alone. Audit records arrive in
 * bursts and two can share an instant to the microsecond; ordering on time alone would make a
 * paginated read skip or repeat rows depending on which the database happened to return first.
 *
 * Owned by: K-09 Audit Foundation.
 */

import { compareInstants } from '../../platform/time/instant.ts';

import { sealRecord, sealRecords } from './immutable.ts';

import { AuditError, type AuditRecord } from './types.ts';

/** Where a page of results starts. Exclusive: the record named here has already been returned. */
export interface AuditCursor {
  readonly recordedAt: string;
  readonly recordId: string;
}

/**
 * What to retrieve.
 *
 * Every filter is optional and they combine with AND. Absent filters mean "everything", which is
 * the right default for a log whose most common query during an incident is "what happened between
 * these two instants".
 */
export interface AuditQuery {
  readonly action?: string;
  readonly actorId?: string;
  readonly resourceOwner?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly outcome?: string;
  readonly correlationId?: string;
  /** Inclusive lower bound on `recordedAt`. */
  readonly from?: string;
  /** Exclusive upper bound, so adjacent pages of a time series cannot double-count a boundary row. */
  readonly before?: string;
  /** Start after this record. */
  readonly after?: AuditCursor;
  readonly limit: number;
}

export interface AuditPage {
  readonly records: readonly AuditRecord[];
  /** Where the next page starts, or null when this page is the last. */
  readonly next: AuditCursor | null;
}

export interface AuditTransaction {
  /** The exact record, or null. */
  findRecordById(recordId: string): Promise<AuditRecord | null>;

  /** A previous recording with this idempotency key, if one exists. */
  findRecordByIdempotencyKey(idempotencyKey: string): Promise<AuditRecord | null>;

  /**
   * Append a record. Must refuse a duplicate id and a reused idempotency key.
   *
   * There is deliberately no counterpart. An audit record is written once and read for ever.
   */
  insertRecord(record: AuditRecord): Promise<void>;

  /** A page of records, ordered by `(recordedAt, recordId)` ascending. */
  queryRecords(query: AuditQuery): Promise<AuditPage>;
}

export interface AuditRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written.
   */
  withTransaction<T>(body: (tx: AuditTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract, not a convenience double: it enforces the
 * same invariants the database does — unique record ids, unique idempotency keys, append-only
 * storage, and the `(recordedAt, recordId)` ordering that makes pagination stable.
 *
 * Transactions read a snapshot on entry and, on commit, append only what they wrote — refusing if
 * another transaction claimed the same id or key first. Two recorders that overlap therefore behave
 * here as they would against a server.
 */
export class InMemoryAuditRepository implements AuditRepository {
  #records: AuditRecord[] = [];
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  records(): readonly AuditRecord[] {
    return sealRecords(this.#records);
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(records: readonly AuditRecord[]): void {
    // Sealed on the way in: a test that seeds an array and then edits it must not be editing the
    // store. A shallow copy would have shared the actor and resource objects.
    this.#records = records.map(sealRecord);
  }

  async withTransaction<T>(body: (tx: AuditTransaction) => Promise<T>): Promise<T> {
    const base = this.#records.map(sealRecord);
    const working = base.map(sealRecord);
    const tx = new InMemoryAuditTransaction(working);

    try {
      const result = await body(tx);
      this.#commit(base, working);
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  /**
   * Append this transaction's records onto the store as it stands now.
   *
   * Only appends, because that is the only thing the port can do. The conflict checks are against
   * the *current* store rather than the snapshot: two recorders that both read a store with no such
   * idempotency key would otherwise both append, producing two records for one action — which is
   * exactly what an idempotency key exists to prevent.
   */
  #commit(base: readonly AuditRecord[], working: readonly AuditRecord[]): void {
    const baseIds = new Set(base.map((record) => record.recordId));
    const appended = working.filter((record) => !baseIds.has(record.recordId));
    if (appended.length === 0) return;

    const currentIds = new Set(this.#records.map((record) => record.recordId));
    const currentKeys = new Map(
      this.#records.map((record) => [record.idempotencyKey, record.recordId]),
    );

    for (const record of appended) {
      if (currentIds.has(record.recordId)) {
        throw new AuditError(
          'duplicate-record-id',
          `record ${record.recordId} was appended by another transaction while this one was open`,
        );
      }
      const holder = currentKeys.get(record.idempotencyKey);
      if (holder !== undefined) {
        throw new AuditError(
          'idempotency-key-reuse',
          `idempotency key "${record.idempotencyKey}" was used by record ${holder}, appended by ` +
            'another transaction while this one was open',
        );
      }
    }

    this.#records = [...this.#records, ...appended.map(sealRecord)];
  }
}

class InMemoryAuditTransaction implements AuditTransaction {
  readonly #records: AuditRecord[];

  constructor(records: AuditRecord[]) {
    this.#records = records;
  }

  findRecordById(recordId: string): Promise<AuditRecord | null> {
    const found = this.#records.find((record) => record.recordId === recordId);
    return Promise.resolve(found === undefined ? null : sealRecord(found));
  }

  findRecordByIdempotencyKey(idempotencyKey: string): Promise<AuditRecord | null> {
    const found = this.#records.find((record) => record.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealRecord(found));
  }

  insertRecord(record: AuditRecord): Promise<void> {
    if (this.#records.some((existing) => existing.recordId === record.recordId)) {
      return Promise.reject(
        new AuditError(
          'duplicate-record-id',
          `record ${record.recordId} already exists. An audit record is written once and never rewritten`,
        ),
      );
    }
    if (this.#records.some((existing) => existing.idempotencyKey === record.idempotencyKey)) {
      return Promise.reject(
        new AuditError(
          'idempotency-key-reuse',
          `idempotency key "${record.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#records.push(sealRecord(record));
    return Promise.resolve();
  }

  queryRecords(query: AuditQuery): Promise<AuditPage> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      return Promise.reject(
        new AuditError(
          'invalid-query',
          `limit must be a positive integer, got ${String(query.limit)}`,
        ),
      );
    }

    const matching = this.#records
      .filter((record) => matches(record, query))
      .sort(
        (a, b) =>
          compareInstants(a.recordedAt, b.recordedAt) || a.recordId.localeCompare(b.recordId),
      );

    const start =
      query.after === undefined
        ? 0
        : matching.findIndex(
            (record) =>
              compareInstants(record.recordedAt, (query.after as AuditCursor).recordedAt) > 0 ||
              (compareInstants(record.recordedAt, (query.after as AuditCursor).recordedAt) === 0 &&
                record.recordId.localeCompare((query.after as AuditCursor).recordId) > 0),
          );

    const from = start === -1 ? matching.length : start;
    const page = matching.slice(from, from + query.limit);
    const last = page[page.length - 1];
    const exhausted = from + page.length >= matching.length;

    return Promise.resolve({
      records: sealRecords(page),
      next:
        last === undefined || exhausted
          ? null
          : { recordedAt: last.recordedAt, recordId: last.recordId },
    });
  }
}

function matches(record: AuditRecord, query: AuditQuery): boolean {
  if (query.action !== undefined && record.action !== query.action) return false;
  if (query.actorId !== undefined && record.actor.id !== query.actorId) return false;
  if (query.resourceOwner !== undefined && record.resource.owner !== query.resourceOwner) {
    return false;
  }
  if (query.resourceType !== undefined && record.resource.type !== query.resourceType) return false;
  if (query.resourceId !== undefined && record.resource.id !== query.resourceId) return false;
  if (query.outcome !== undefined && record.outcome !== query.outcome) return false;
  if (query.correlationId !== undefined && record.correlationId !== query.correlationId) {
    return false;
  }
  if (query.from !== undefined && compareInstants(record.recordedAt, query.from) < 0) return false;
  if (query.before !== undefined && compareInstants(record.recordedAt, query.before) >= 0) {
    return false;
  }
  return true;
}
