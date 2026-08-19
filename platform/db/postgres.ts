/**
 * The PostgreSQL adapter (FND-002b).
 *
 * The only file in the repository that knows a database driver exists. Everything above it talks
 * to the `Database` interface, which is what makes the runner's behaviour testable without a
 * server.
 *
 * `pg` is a declared, version-locked dependency. An earlier revision imported it dynamically to
 * keep the repository dependency-free, which meant a clean `npm ci` produced a runner that could
 * not run — a migration tool that needs an undocumented extra install is not a migration tool.
 * The driver and its typings are pinned exactly, like everything else here.
 *
 * Owned by: FND-002b (data foundation).
 */

import process from 'node:process';

import pg from 'pg';

import {
  redactConnectionString,
  redactText,
  passwordOf,
  type Database,
  type DatabaseClient,
  type QueryResult,
} from './client.ts';

export const DATABASE_URL_ENV = 'DATABASE_URL';

/** The declared driver, named once so tests and documentation can refer to it. */
export const DRIVER_MODULE = 'pg';

export class MissingConnectionError extends Error {
  constructor() {
    super(
      `${DATABASE_URL_ENV} is not set, and no .env supplied it.\n\n    cp .env.example .env\n\n` +
        'The runner takes its target from the environment and never from an argument, so a ' +
        'connection string cannot end up in shell history or in a process listing.',
    );
    this.name = 'MissingConnectionError';
  }
}

/** Read the connection string from the environment, or explain precisely what is missing. */
export function connectionStringFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[DATABASE_URL_ENV];
  if (raw === undefined || raw.trim() === '') throw new MissingConnectionError();
  return raw.trim();
}

/**
 * A `Database` backed by a single `pg.Client`.
 *
 * One session, not a pool: the advisory lock the runner takes is session-scoped, so a pool would
 * hand later queries to a connection that does not hold it.
 */
export class PostgresDatabase implements Database {
  readonly description: string;
  readonly #connectionString: string;
  readonly #secrets: readonly string[];

  constructor(connectionString: string) {
    this.#connectionString = connectionString;
    this.description = redactConnectionString(connectionString);
    const password = passwordOf(connectionString);
    this.#secrets = password === '' ? [connectionString] : [password, connectionString];
  }

  /** Redact anything before it leaves this adapter. Driver messages quote connection strings. */
  redact(text: string): string {
    return redactText(text, this.#secrets);
  }

  async connect(): Promise<DatabaseClient> {
    const client = new pg.Client({ connectionString: this.#connectionString });
    try {
      await client.connect();
    } catch (error) {
      const message = this.redact(error instanceof Error ? error.message : String(error));
      // Deliberately NOT attaching the caught error as `cause`. A driver's connection error
      // routinely quotes the connection string it failed on, and an error chain is precisely
      // what gets printed and pasted into an issue. Losing the stack is the lesser cost; the
      // redacted message carries the diagnostic content.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`could not connect to ${this.description}: ${message}`);
    }

    const redact = (text: string): string => this.redact(text);

    return {
      async query<Row = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<Row>> {
        try {
          // QueryConfig form rather than (text, values): with an optional `params` the
          // positional overload resolves to the callback signature instead.
          const result = await client.query({ text: sql, values: params ? [...params] : [] });
          return {
            rows: (result.rows ?? []) as unknown as readonly Row[],
            rowCount: result.rowCount ?? 0,
          };
        } catch (error) {
          // Same reasoning as the connect path: a `cause` here would carry the unredacted
          // driver error, and with it whatever credential the driver chose to quote.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(redact(error instanceof Error ? error.message : String(error)));
        }
      },
      async release(): Promise<void> {
        await client.end();
      },
    };
  }
}
