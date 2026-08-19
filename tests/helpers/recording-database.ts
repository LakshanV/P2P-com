/**
 * A `Database` that records the SQL it is given and answers from canned rows (FND-003a).
 *
 * The PostgreSQL adapter's most important property cannot be asserted by reading its source: that
 * a replacement publication supersedes the incumbent *before* activating the draft. Statement
 * order is behaviour, and behaviour needs running. This fake runs the real adapter and the real
 * service against recorded statements, so the ordering the partial unique index requires is proved
 * without a server.
 *
 * It is not a database. It answers `SELECT`s from rows the test supplies and reports a row count
 * for `UPDATE`s from a predicate the test supplies, which is exactly enough to drive the adapter
 * through its transaction paths — including the concurrency paths, where an `UPDATE` matching zero
 * rows is the whole point.
 */

import type { Database, DatabaseClient, QueryResult } from '../../platform/db/client.ts';

export interface RecordedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface RecordingOptions {
  /** Rows returned for a SELECT whose SQL matches. Consulted in order; first match wins. */
  readonly selects?: ReadonlyArray<{ readonly match: RegExp; readonly rows: readonly unknown[] }>;
  /** Rows affected by an UPDATE whose SQL matches. Anything unmatched affects one row. */
  readonly updates?: ReadonlyArray<{ readonly match: RegExp; readonly rowCount: number }>;
  /** Statement that should throw, simulating a constraint violation or a lost connection. */
  readonly failOn?: RegExp;
}

export class RecordingDatabase implements Database {
  readonly description = 'postgres://recorder:***@127.0.0.1:5432/recorded';
  readonly queries: RecordedQuery[] = [];
  sessionsOpened = 0;
  sessionsReleased = 0;

  readonly #options: RecordingOptions;

  constructor(options: RecordingOptions = {}) {
    this.#options = options;
  }

  /** Just the SQL, trimmed and whitespace-collapsed, for readable assertions. */
  statements(): string[] {
    return this.queries.map((query) => query.sql.replace(/\s+/g, ' ').trim());
  }

  /** Index of the first statement matching a pattern, or -1. */
  indexOf(pattern: RegExp): number {
    return this.statements().findIndex((sql) => pattern.test(sql));
  }

  connect(): Promise<DatabaseClient> {
    this.sessionsOpened += 1;
    return Promise.resolve({
      query: <Row = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<Row>> => {
        this.queries.push({ sql, params: params ?? [] });

        if (this.#options.failOn?.test(sql) === true) {
          return Promise.reject(new Error('simulated database failure'));
        }

        // Dispatch on the leading verb first. A `WHERE version_id = $1` matcher intended for a
        // SELECT also appears in the UPDATEs, and answering an UPDATE from canned rows would
        // report one row changed when the test meant to say none did — silently turning a
        // concurrency test into a happy path.
        const isWrite = /^\s*(UPDATE|INSERT|DELETE)/i.test(sql);

        if (!isWrite) {
          for (const canned of this.#options.selects ?? []) {
            if (canned.match.test(sql)) {
              return Promise.resolve({
                rows: canned.rows as readonly Row[],
                rowCount: canned.rows.length,
              });
            }
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        }

        for (const canned of this.#options.updates ?? []) {
          if (canned.match.test(sql)) {
            return Promise.resolve({ rows: [], rowCount: canned.rowCount });
          }
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
      release: (): Promise<void> => {
        this.sessionsReleased += 1;
        return Promise.resolve();
      },
    });
  }
}

/** A database row as the adapter expects to read it back. */
export function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version_id: 'ver-1',
    config_key: 'session.timeout_seconds',
    scope_level: 'global',
    scope_id: '',
    value_kind: 'integer',
    value_text: '900',
    effective_from: '2026-01-01T00:00:00.000Z',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    published_at: '2026-01-01T00:00:00.000Z',
    superseded_at: null,
    previous_version_id: null,
    idempotency_key: 'idem-1',
    origin: 'human',
    ...overrides,
  };
}
