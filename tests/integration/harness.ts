/**
 * The only sanctioned way for a live suite to reach a database (FND-002c correction).
 *
 * The previous revision ran the migration suite — apply, roll back, re-apply — directly against
 * whatever DATABASE_URL named. That is the development database. Running the tests therefore cost
 * you your local data, and the guarded `_test` lifecycle sat alongside it proving that a *second*
 * suite was safe while the first one was not.
 *
 * So the development URL is now treated as what it actually is: **connection and configuration
 * input**. Nothing here ever builds a migration runner against it. Every migration, rollback and
 * schema assertion runs inside a derived `_test` database that is created for the test and dropped
 * afterwards, on success and on failure alike, and every target passes assertSafeTestTarget first.
 *
 * The development database is opened for exactly one purpose — reading its migration status, which
 * creates nothing — so a suite can prove before and after that it was untouched.
 *
 * `tests/integration-safety.test.ts` fails the build if any integration file reaches around this.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { Database } from '../../platform/db/client.ts';
import { loadEnvFile } from '../../platform/db/env-file.ts';
import { MIGRATIONS_DIR } from '../../platform/db/migrations.ts';
import { DATABASE_URL_ENV, PostgresDatabase } from '../../platform/db/postgres.ts';
import { migrateDown, migrationStatus, type StatusReport } from '../../platform/db/runner.ts';
import {
  assertSafeTestTarget,
  databaseNameOf,
  deriveTestDatabaseUrl,
  createTestDatabase,
  dropTestDatabase,
  maintenanceUrl,
} from '../../platform/db/test-database.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Repo-relative migrations directory, resolved once for every suite. */
export const MIGRATIONS_PATH = path.join(REPO_ROOT, MIGRATIONS_DIR);

// `cp .env.example .env` has to be sufficient, so the harness loads it. A shell export still wins.
loadEnvFile(REPO_ROOT);

const configuredUrl = process.env[DATABASE_URL_ENV];

/**
 * Why the live suites are not running, or undefined when they are.
 *
 * Honest skips matter more here than anywhere else: a suite that silently passed without a
 * database would be the most misleading green in the repository.
 */
export const skipReason: string | undefined =
  configuredUrl === undefined || configuredUrl.trim() === ''
    ? `${DATABASE_URL_ENV} is not set and no .env supplied it — run \`cp .env.example .env\`, ` +
      'then `npm run db:up && npm run db:ready`'
    : undefined;

/** Spread into every live `test(...)` call so an unconfigured environment skips, not fails. */
export const liveTestOptions: { skip?: string } =
  skipReason === undefined ? {} : { skip: skipReason };

/** The configured development URL. Configuration input only — never a migration target. */
function developmentUrl(): string {
  if (configuredUrl === undefined || configuredUrl.trim() === '') {
    throw new Error('the live suites are not configured; guard with liveTestOptions');
  }
  return configuredUrl.trim();
}

/** Name of the development database, for asserting the test database is not it. */
export function developmentDatabaseName(): string {
  return databaseNameOf(developmentUrl());
}

/**
 * Read the development database's migration status. `migrationStatus` creates nothing — this is
 * the one read a suite may make of the development database, so it can prove it was untouched.
 */
export async function developmentSnapshot(): Promise<StatusReport> {
  const development = new PostgresDatabase(developmentUrl());
  return migrationStatus(development, { directory: MIGRATIONS_PATH });
}

export interface TestDatabaseContext {
  /** A Database bound to the derived `_test` database. The only migration target a suite gets. */
  readonly database: Database;
  /** A Database bound to the maintenance database, for CREATE/DROP and catalogue queries. */
  readonly maintenance: Database;
  /** The derived, guard-approved connection string. */
  readonly url: string;
  /** Name of the derived database. */
  readonly name: string;
  /** Absolute migrations directory, so suites need not resolve it themselves. */
  readonly directory: string;
}

/**
 * Create the derived test database, run `body` against it, and drop it — whatever happens.
 *
 * Cleanup is in a `finally`, so a failing assertion still leaves the server clean; the next run
 * starts from nothing rather than from the wreckage of the last one. `createTestDatabase` also
 * drops any leftover first, which covers a process killed between the two.
 */
export async function withTestDatabase<T>(
  body: (context: TestDatabaseContext) => Promise<T>,
): Promise<T> {
  const url = deriveTestDatabaseUrl(developmentUrl());
  // Belt and braces: deriveTestDatabaseUrl already asserts, and so does every lifecycle call.
  // Asserting again here means a future refactor of either cannot quietly remove the guarantee.
  assertSafeTestTarget(url);

  const maintenance = new PostgresDatabase(maintenanceUrl(url));
  const database = new PostgresDatabase(url);
  const context: TestDatabaseContext = {
    database,
    maintenance,
    url,
    name: databaseNameOf(url),
    directory: MIGRATIONS_PATH,
  };

  await createTestDatabase(maintenance, url);
  try {
    return await body(context);
  } finally {
    await dropTestDatabase(maintenance, url);
  }
}

/** Does a database of this name exist on the server? For asserting cleanup actually happened. */
export async function databaseExists(maintenance: Database, name: string): Promise<boolean> {
  const client = await maintenance.connect();
  try {
    const result = await client.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present;',
      [name],
    );
    return result.rows[0]?.present === true;
  } finally {
    await client.release();
  }
}

/** A maintenance connection outside `withTestDatabase`, for lifecycle assertions. */
export function maintenanceDatabase(): Database {
  return new PostgresDatabase(maintenanceUrl(testDatabaseUrl()));
}

/** The derived, guard-approved test database URL. Nothing is created by asking for it. */
export function testDatabaseUrl(): string {
  const url = deriveTestDatabaseUrl(developmentUrl());
  // deriveTestDatabaseUrl already asserts. Repeated here so a future refactor of either cannot
  // quietly remove the guarantee from the one place callers reach for a target.
  assertSafeTestTarget(url);
  return url;
}

/** The derived test database name, without creating anything. */
export function testDatabaseName(): string {
  return databaseNameOf(testDatabaseUrl());
}

/**
 * A connection to the derived test database, creating and dropping nothing.
 *
 * For inspecting a database the caller has arranged to exist — a leftover from a killed run, say.
 * Any suite that wants a database to work in should use `withTestDatabase` instead.
 */
export function testDatabaseConnection(): Database {
  return new PostgresDatabase(testDatabaseUrl());
}

/** Table used to tell one instance of the test database from another. */
export const LEFTOVER_MARKER_TABLE = 'leftover_marker';

/**
 * Leave a database behind at the exact guarded `_test` name, carrying a marker object.
 *
 * This is what a run killed midway leaves on the server: not a copy under another name, but a
 * database occupying the very name the next run will ask for. Proving the next run *replaces* it
 * requires that, which is why the marker goes in here rather than inside `withTestDatabase` —
 * anything created inside that helper is dropped by it on the way out.
 *
 * Creation goes through the same guarded path as everything else, so this setup cannot land on a
 * database the guard would refuse.
 */
export async function seedLeftoverTestDatabase(): Promise<void> {
  const url = testDatabaseUrl();
  const maintenance = new PostgresDatabase(maintenanceUrl(url));
  await createTestDatabase(maintenance, url);

  const client = await new PostgresDatabase(url).connect();
  try {
    await client.query(`CREATE TABLE ${LEFTOVER_MARKER_TABLE} (id integer);`);
  } finally {
    await client.release();
  }
}

/** Is the leftover marker present in this database? */
export async function leftoverMarkerExists(database: Database): Promise<boolean> {
  const client = await database.connect();
  try {
    const result = await client.query<{ present: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS present;',
      [`public.${LEFTOVER_MARKER_TABLE}`],
    );
    return result.rows[0]?.present === true;
  } finally {
    await client.release();
  }
}

/**
 * Drop the derived test database, whatever state it is in. Idempotent, and guarded like every
 * other lifecycle call, so a suite can put it in a `finally` without thinking.
 */
export async function removeTestDatabase(): Promise<void> {
  const url = testDatabaseUrl();
  await dropTestDatabase(new PostgresDatabase(maintenanceUrl(url)), url);
}

/**
 * Roll back every applied migration down to and including `version`, newest first.
 *
 * The runner refuses to roll back anything but the most recently applied migration — correctly, and
 * for the reason its error says: rollbacks compose only in reverse order. That makes the obvious
 * form of a reversibility test — `migrateDown(db, { version: myVersion })` — quietly fragile. It
 * passes while the module under test owns the newest migration, and every module that lands after
 * it breaks a test that has nothing to do with the new work. This is GAP-INF-6 in
 * `docs/JAYA_FINAL_GAP_ANALYSIS.md`, and it caught M-02 the day M-04's migration landed.
 *
 * Rolling the whole tail back is what an operator would actually do, and it proves the stronger
 * property: the migration is reversible *given* everything built on top of it has been reversed
 * first, whatever that turns out to be.
 */
export async function rollBackTo(
  database: Database,
  directory: string,
  version: string,
): Promise<void> {
  const { applied } = await migrationStatus(database, { directory });
  const tail = applied
    .map((row) => row.version)
    .filter((candidate) => candidate >= version)
    .sort()
    .reverse();

  if (tail.at(-1) !== version) {
    throw new Error(
      `rollBackTo(${version}) found no applied migration with that version; applied are ` +
        applied.map((row) => row.version).join(', '),
    );
  }

  for (const candidate of tail) {
    await migrateDown(database, { directory, version: candidate });
  }
}
