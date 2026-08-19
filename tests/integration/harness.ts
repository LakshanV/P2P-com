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
import { migrationStatus, type StatusReport } from '../../platform/db/runner.ts';
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
  const url = deriveTestDatabaseUrl(developmentUrl());
  assertSafeTestTarget(url);
  return new PostgresDatabase(maintenanceUrl(url));
}

/** The derived test database name, without creating anything. */
export function testDatabaseName(): string {
  return databaseNameOf(deriveTestDatabaseUrl(developmentUrl()));
}
