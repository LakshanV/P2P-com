/**
 * The PostgreSQL adapter (FND-002b).
 *
 * The only file in the repository that knows a database driver exists. Everything above it talks
 * to the `Database` interface, which is what makes the runner's behaviour testable without a
 * server.
 *
 * `pg` is imported dynamically rather than declared as a dependency. The repository ships no
 * runtime dependencies at all — `npm ci` installs a toolchain and nothing else — and adding a
 * driver for a runner that no environment can yet point at would put an unused package in every
 * install and every audit. A contributor who wants to apply a migration installs it explicitly;
 * the error below says so. When a real environment exists, this becomes a declared dependency and
 * this comment goes away.
 *
 * Owned by: FND-002b (data foundation).
 */

import process from 'node:process';

import {
  redactConnectionString,
  redactText,
  passwordOf,
  type Database,
  type DatabaseClient,
  type QueryResult,
} from './client.ts';

/** Shape of the slice of `pg` this adapter uses, so the dynamic import stays typed. */
interface PgQueryResult {
  readonly rows?: unknown[];
  readonly rowCount?: number | null;
}
interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: readonly unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}
interface PgModule {
  readonly Client: new (config: { connectionString: string }) => PgClient;
}

export const DATABASE_URL_ENV = 'DATABASE_URL';

/** The optional driver. Not a declared dependency — see the module comment. */
export const DRIVER_MODULE = 'pg';

export class MissingDriverError extends Error {
  constructor(detail: string) {
    super(
      'the PostgreSQL driver is not installed. It is deliberately not a declared dependency — ' +
        'install it explicitly to run migrations:\n\n    npm install --no-save pg\n\n' +
        `underlying error: ${detail}`,
    );
    this.name = 'MissingDriverError';
  }
}

export class MissingConnectionError extends Error {
  constructor() {
    super(
      `${DATABASE_URL_ENV} is not set. The runner takes its target from the environment and ` +
        'never from an argument, so a connection string cannot end up in shell history or in a ' +
        'process listing.',
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
    let pg: PgModule;
    try {
      // Specifier held in a variable on purpose: `pg` is not a declared dependency, so a literal
      // here would fail type resolution in an install that does not have it — which is every
      // ordinary install.
      const specifier = DRIVER_MODULE;
      pg = (await import(specifier)) as PgModule;
    } catch (error) {
      throw new MissingDriverError(error instanceof Error ? error.message : String(error));
    }

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
          const result = await client.query(sql, params);
          return {
            rows: (result.rows ?? []) as readonly Row[],
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
