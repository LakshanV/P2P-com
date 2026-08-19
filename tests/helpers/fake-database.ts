/**
 * An in-memory stand-in for PostgreSQL, good enough to hold the runner honest (FND-002b).
 *
 * It is not a database. It models exactly the behaviours the runner depends on and nothing else:
 * a session-scoped advisory lock shared between sessions, transaction boundaries with rollback,
 * a ledger table that does not exist until bootstrap creates it, and the ability to make a chosen
 * statement fail.
 *
 * The point of the fake is determinism. Failure paths — a migration whose SQL throws, a rollback
 * that must leave the ledger untouched, a second runner arriving mid-run — are the paths that
 * matter most and the ones a live database makes slow and flaky to provoke on demand.
 */

import type { Database, DatabaseClient, QueryResult } from '../../platform/db/client.ts';
import type { LedgerRow } from '../../platform/db/runner.ts';

export interface FakeOptions {
  /** Rows already in the ledger. Implies the database has been bootstrapped. */
  readonly ledger?: readonly LedgerRow[];
  /** Statement that should throw, simulating a SQL error. */
  readonly failOn?: RegExp;
  /** Pretend another runner already holds the advisory lock. */
  readonly lockHeldByAnother?: boolean;
  readonly description?: string;
}

interface LedgerEntry extends LedgerRow {
  readonly durationMs: number | null;
}

export class FakeDatabase implements Database {
  readonly description: string;

  /** Every statement the runner issued, in order. The primary assertion surface. */
  readonly statements: string[] = [];
  /** Sessions opened, so a test can prove the client was released on every path. */
  sessionsOpened = 0;
  sessionsReleased = 0;

  ledger: LedgerEntry[] = [];
  bootstrapped = false;
  lockHeld: boolean;
  lockAcquisitions = 0;
  lockReleases = 0;

  readonly #failOn: RegExp | undefined;
  #inTransaction = false;
  #pendingLedger: LedgerEntry[] = [];
  #pendingBootstrap = false;

  constructor(options: FakeOptions = {}) {
    this.description = options.description ?? 'postgres://jaya:***@localhost:5432/jaya_test';
    this.#failOn = options.failOn;
    this.lockHeld = options.lockHeldByAnother ?? false;
    if (options.ledger !== undefined) {
      this.bootstrapped = true;
      this.ledger = options.ledger.map((row) => ({ ...row, durationMs: null }));
    }
  }

  /** Versions currently committed to the ledger, in order. */
  appliedVersions(): string[] {
    return this.ledger.map((row) => row.version).sort();
  }

  connect(): Promise<DatabaseClient> {
    this.sessionsOpened += 1;
    return Promise.resolve({
      query: <Row = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<Row>> => {
        // Synchronous underneath, deliberately: a fake that resolves on a later tick would let
        // an ordering bug in the runner pass by accident.
        try {
          return Promise.resolve(this.execute<Row>(sql, params));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      release: (): Promise<void> => {
        this.sessionsReleased += 1;
        return Promise.resolve();
      },
    });
  }

  private execute<Row>(sql: string, params?: readonly unknown[]): QueryResult<Row> {
    this.statements.push(sql.trim());

    if (/pg_try_advisory_lock/.test(sql)) {
      if (this.lockHeld) return this.rows<Row>([{ locked: false } as Row]);
      this.lockHeld = true;
      this.lockAcquisitions += 1;
      return this.rows<Row>([{ locked: true } as Row]);
    }
    if (/pg_advisory_unlock/.test(sql)) {
      this.lockHeld = false;
      this.lockReleases += 1;
      return this.rows<Row>([]);
    }

    if (/^BEGIN\s*;?$/i.test(sql.trim())) {
      this.#inTransaction = true;
      this.#pendingLedger = [];
      this.#pendingBootstrap = false;
      return this.rows<Row>([]);
    }
    if (/^COMMIT\s*;?$/i.test(sql.trim())) {
      this.ledger.push(...this.#pendingLedger);
      if (this.#pendingBootstrap) this.bootstrapped = true;
      this.#inTransaction = false;
      this.#pendingLedger = [];
      this.#pendingBootstrap = false;
      return this.rows<Row>([]);
    }
    if (/^ROLLBACK\s*;?$/i.test(sql.trim())) {
      this.#inTransaction = false;
      this.#pendingLedger = [];
      this.#pendingBootstrap = false;
      return this.rows<Row>([]);
    }

    // A failure is raised only for statements inside a transaction body or bootstrap DDL, which
    // is where the runner's recovery behaviour lives.
    if (this.#failOn?.test(sql) === true) {
      throw new Error('simulated SQL failure');
    }

    if (/CREATE TABLE IF NOT EXISTS platform\.schema_migrations/i.test(sql)) {
      this.#pendingBootstrap = true;
      return this.rows<Row>([]);
    }

    if (/^SELECT version, slug, checksum FROM platform\.schema_migrations/i.test(sql)) {
      if (!this.bootstrapped)
        throw new Error('relation "platform.schema_migrations" does not exist');
      const sorted = [...this.ledger].sort((a, b) => a.version.localeCompare(b.version));
      return this.rows<Row>(sorted.map((row) => ({ ...row }) as Row));
    }

    if (/^INSERT INTO platform\.schema_migrations/i.test(sql)) {
      const [version, slug, checksum, durationMs] = params ?? [];
      const entry: LedgerEntry = {
        version: String(version),
        slug: String(slug),
        checksum: String(checksum),
        durationMs: typeof durationMs === 'number' ? durationMs : null,
      };
      if (this.#inTransaction) this.#pendingLedger.push(entry);
      else this.ledger.push(entry);
      return this.rows<Row>([]);
    }

    if (/^DELETE FROM platform\.schema_migrations/i.test(sql)) {
      const [version] = params ?? [];
      this.ledger = this.ledger.filter((row) => row.version !== String(version));
      return this.rows<Row>([]);
    }

    // Anything else is migration body SQL: recorded, otherwise a no-op.
    return this.rows<Row>([]);
  }

  private rows<Row>(rows: readonly Row[]): QueryResult<Row> {
    return { rows, rowCount: rows.length };
  }
}
