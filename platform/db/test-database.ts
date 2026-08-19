/**
 * Isolated integration-test database lifecycle (FND-002c).
 *
 * The live migration suite has to apply, roll back and re-apply migrations, which means it needs a
 * database it is allowed to destroy. Pointing it at the development database would make a test run
 * indistinguishable from an accident; pointing it at anything shared would make it a disaster.
 *
 * So the test database is *derived* from local configuration rather than configured separately —
 * one fewer variable to set, and therefore one fewer variable to set wrongly — and every derived
 * target is checked before it is used:
 *
 *   - the host must be loopback. A test that can reach another machine can destroy another
 *     machine's data.
 *   - the database name must carry the test suffix. A name without it is not a test database, no
 *     matter what the caller believes.
 *   - names that read like a shared environment are refused outright, because the cost of being
 *     wrong is unbounded and the cost of a false refusal is renaming a database.
 *
 * The guard fails closed on anything it cannot parse. An unparseable connection string is not a
 * safe one.
 *
 * Owned by: FND-002c (data foundation — local provisioning).
 */

import type { Database } from './client.ts';

/** Suffix that marks a database as disposable. */
export const TEST_DATABASE_SUFFIX = '_test';

/** Hostnames that count as this machine. */
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * Substrings that disqualify a target however local it looks. Someone running a port-forward to a
 * shared database sees `127.0.0.1` too, and the name is the only remaining signal.
 */
export const FORBIDDEN_NAME_MARKERS: readonly string[] = [
  'prod',
  'production',
  'live',
  'staging',
  'stage',
  'uat',
  'preprod',
];

export class UnsafeTestTargetError extends Error {
  constructor(reason: string) {
    super(
      `refusing to use this database for integration tests: ${reason}. The suite creates and ` +
        'drops databases, so it will only ever act on a loopback host with a name ending in ' +
        `"${TEST_DATABASE_SUFFIX}".`,
    );
    this.name = 'UnsafeTestTargetError';
  }
}

interface ParsedTarget {
  readonly url: URL;
  readonly host: string;
  readonly database: string;
}

function parse(connectionString: string): ParsedTarget {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Deliberately not echoing the string: an unparseable connection string is still likely to
    // contain a password.
    throw new UnsafeTestTargetError('the connection string could not be parsed');
  }
  const database = url.pathname.replace(/^\//, '');
  if (database === '') throw new UnsafeTestTargetError('the connection string names no database');
  return { url, host: url.hostname, database };
}

/**
 * Throw unless this target is safe to create, fill and drop. Called by every lifecycle function
 * below, so no caller can skip it by using a different entry point.
 */
export function assertSafeTestTarget(connectionString: string): void {
  const { host, database } = parse(connectionString);

  if (!LOCAL_HOSTS.includes(host.toLowerCase())) {
    throw new UnsafeTestTargetError(`host "${host}" is not this machine`);
  }
  if (!database.toLowerCase().endsWith(TEST_DATABASE_SUFFIX)) {
    throw new UnsafeTestTargetError(
      `database "${database}" does not end in "${TEST_DATABASE_SUFFIX}"`,
    );
  }
  const lowered = database.toLowerCase();
  const marker = FORBIDDEN_NAME_MARKERS.find((candidate) => lowered.includes(candidate));
  if (marker !== undefined) {
    throw new UnsafeTestTargetError(`database "${database}" contains "${marker}"`);
  }
}

/** Is this target safe? The predicate form, for reporting rather than enforcing. */
export function isSafeTestTarget(connectionString: string): boolean {
  try {
    assertSafeTestTarget(connectionString);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive the test database URL from the development one: same server, same credentials, a
 * database named after the development one with the test suffix appended.
 *
 * Derivation rather than configuration is the point. A separately-configured test URL is a URL
 * someone can point somewhere else.
 */
export function deriveTestDatabaseUrl(developmentUrl: string): string {
  const { url, database } = parse(developmentUrl);
  const derived = new URL(url.toString());
  derived.pathname = `/${database.endsWith(TEST_DATABASE_SUFFIX) ? database : `${database}${TEST_DATABASE_SUFFIX}`}`;
  const result = derived.toString();
  assertSafeTestTarget(result);
  return result;
}

/** The maintenance database used to create and drop others. */
const MAINTENANCE_DATABASE = 'postgres';

/** A connection to the same server, pointed at the maintenance database. */
export function maintenanceUrl(connectionString: string): string {
  const { url } = parse(connectionString);
  const maintenance = new URL(url.toString());
  maintenance.pathname = `/${MAINTENANCE_DATABASE}`;
  return maintenance.toString();
}

/** Database name from a connection string, for the CREATE/DROP statements. */
export function databaseNameOf(connectionString: string): string {
  return parse(connectionString).database;
}

/**
 * Create the test database, dropping any leftover from an interrupted run first. The caller
 * supplies a Database bound to the *maintenance* connection, because CREATE DATABASE cannot run
 * inside the database being created.
 */
export async function createTestDatabase(maintenance: Database, testUrl: string): Promise<void> {
  assertSafeTestTarget(testUrl);
  const name = databaseNameOf(testUrl);

  const client = await maintenance.connect();
  try {
    // Identifiers cannot be parameterised, so the name is quoted — and it has already survived
    // assertSafeTestTarget, which is what makes that acceptable here.
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
    await client.query(`CREATE DATABASE "${name}";`);
  } finally {
    await client.release();
  }
}

/** Drop the test database. Safe to call when it does not exist. */
export async function dropTestDatabase(maintenance: Database, testUrl: string): Promise<void> {
  assertSafeTestTarget(testUrl);
  const name = databaseNameOf(testUrl);

  const client = await maintenance.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
  } finally {
    await client.release();
  }
}
