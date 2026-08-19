/**
 * An in-memory stand-in for PostgreSQL, good enough to hold the seed runner honest (FND-002d).
 *
 * It is not a database. It models exactly what the runner depends on: transaction boundaries with
 * a real rollback, `INSERT … ON CONFLICT (identity) DO NOTHING` including the row count that makes
 * a rerun observably a no-op, `DELETE … WHERE identity`, and the ability to make a chosen statement
 * fail so the atomicity claim can be tested rather than asserted.
 *
 * The point is determinism. "A load that fails halfway leaves nothing behind" is the guarantee most
 * worth having and the one a live database makes slowest to provoke on demand.
 */

import type { Database, DatabaseClient, QueryResult } from '../../platform/db/client.ts';

export interface SeedFakeOptions {
  /** Statement that should throw, simulating a constraint violation or a lost connection. */
  readonly failOn?: RegExp;
  /** Fail when a statement's parameters include this value — for failing on one row of many. */
  readonly failOnValue?: string;
  /** Rows already present, so a reload has something to conflict with. */
  readonly rows?: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
  readonly description?: string;
}

const INSERT =
  /^INSERT INTO\s+([\w.]+)\s*\(([^)]*)\)[\s\S]*ON CONFLICT\s*\(([^)]*)\)\s*DO NOTHING/i;
const DELETE = /^DELETE FROM\s+([\w.]+)\s+WHERE\s+([\s\S]*?);?$/i;

export class SeedFakeDatabase implements Database {
  readonly description: string;

  /** Every statement issued, whitespace-collapsed, in order. The primary assertion surface. */
  readonly statements: string[] = [];
  /** Statements with their parameters, for tests that care what was written. */
  readonly queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  sessionsOpened = 0;
  sessionsReleased = 0;
  commits = 0;
  rollbacks = 0;

  #tables = new Map<string, Array<Record<string, unknown>>>();
  #pending: Map<string, Array<Record<string, unknown>>> | null = null;
  readonly #options: SeedFakeOptions;

  constructor(options: SeedFakeOptions = {}) {
    this.description = options.description ?? 'postgres://jaya:***@localhost:5432/jaya_test';
    this.#options = options;
    for (const [table, rows] of Object.entries(options.rows ?? {})) {
      this.#tables.set(
        table,
        rows.map((row) => ({ ...row })),
      );
    }
  }

  /** Committed rows for a table. Uncommitted work is invisible, exactly as it would be. */
  rowsOf(table: string): ReadonlyArray<Record<string, unknown>> {
    return (this.#tables.get(table) ?? []).map((row) => ({ ...row }));
  }

  get tableNames(): readonly string[] {
    return [...this.#tables.keys()].sort();
  }

  get totalRows(): number {
    return [...this.#tables.values()].reduce((total, rows) => total + rows.length, 0);
  }

  connect(): Promise<DatabaseClient> {
    this.sessionsOpened += 1;
    return Promise.resolve({
      query: <Row = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<Row>> => {
        const collapsed = sql.replace(/\s+/g, ' ').trim();
        this.statements.push(collapsed);
        this.queries.push({ sql: collapsed, params: params ?? [] });

        if (this.#options.failOn?.test(collapsed) === true) {
          return Promise.reject(new Error(`simulated failure on: ${collapsed.slice(0, 60)}`));
        }
        if (
          this.#options.failOnValue !== undefined &&
          (params ?? []).includes(this.#options.failOnValue)
        ) {
          return Promise.reject(
            new Error(`simulated constraint violation on row ${this.#options.failOnValue}`),
          );
        }

        return Promise.resolve(this.#run(collapsed, params ?? []) as QueryResult<Row>);
      },
      release: (): Promise<void> => {
        this.sessionsReleased += 1;
        return Promise.resolve();
      },
    });
  }

  #run(sql: string, params: readonly unknown[]): QueryResult {
    const empty = { rows: [], rowCount: 0 };

    if (/^BEGIN;?$/i.test(sql)) {
      // Copy on entry, swap on commit: the whole point is that a rollback discards everything.
      this.#pending = new Map(
        [...this.#tables].map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]),
      );
      return empty;
    }
    if (/^COMMIT;?$/i.test(sql)) {
      if (this.#pending !== null) this.#tables = this.#pending;
      this.#pending = null;
      this.commits += 1;
      return empty;
    }
    if (/^ROLLBACK;?$/i.test(sql)) {
      this.#pending = null;
      this.rollbacks += 1;
      return empty;
    }

    const target = this.#pending ?? this.#tables;

    const insert = INSERT.exec(sql);
    if (insert !== null) {
      const table = insert[1] as string;
      const columns = (insert[2] as string).split(',').map((column) => column.trim());
      const conflict = (insert[3] as string).split(',').map((column) => column.trim());
      const rows = target.get(table) ?? [];

      const row: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        row[column] = params[index] ?? null;
      });

      const clashes = rows.some((existing) =>
        conflict.every((column) => String(existing[column]) === String(row[column])),
      );
      if (clashes) return empty; // DO NOTHING: zero rows affected, which is what a rerun reports.

      target.set(table, [...rows, row]);
      return { rows: [], rowCount: 1 };
    }

    const remove = DELETE.exec(sql);
    if (remove !== null) {
      const table = remove[1] as string;
      const columns = [...(remove[2] as string).matchAll(/(\w+)\s*=\s*\$(\d+)/g)].map((match) => ({
        column: match[1] as string,
        index: Number(match[2]) - 1,
      }));
      const rows = target.get(table) ?? [];
      const keep = rows.filter(
        (existing) =>
          !columns.every(({ column, index }) => String(existing[column]) === String(params[index])),
      );
      target.set(table, keep);
      return { rows: [], rowCount: rows.length - keep.length };
    }

    return empty;
  }
}
