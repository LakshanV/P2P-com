/**
 * The seed runner (FND-002d).
 *
 * Written against the injected `Database` interface for the same reason the migration runner is:
 * the behaviour worth asserting is the failure behaviour — a row that violates a constraint halfway
 * through a load, a rerun that must change nothing, a target that must be refused — and all of it
 * is deterministic against a fake and slow and conditional against a server.
 *
 * Three guarantees, and each is a decision rather than a default:
 *
 *   - **Atomic.** One transaction for the whole load, across every dataset. A partial seed is worse
 *     than no seed: it looks loaded, and whichever half is missing surfaces as an unrelated test
 *     failure days later.
 *   - **Idempotent.** Every insert is `ON CONFLICT (identity) DO NOTHING`, so a second run inserts
 *     nothing and reports that it inserted nothing. Loading twice is loading once.
 *   - **Fail-closed on the target.** A load refuses any host that is not this machine and any
 *     database whose name suggests it is shared. Replacing data outright refuses anything but the
 *     guarded derived `_test` database, and demands an explicit confirmation on top.
 *
 * Owned by: FND-002d (data foundation).
 */

import type { Database, DatabaseClient } from '../db/client.ts';
import {
  FORBIDDEN_NAME_MARKERS,
  LOCAL_HOSTS,
  TEST_DATABASE_SUFFIX,
  assertSafeTestTarget,
  databaseNameOf,
} from '../db/test-database.ts';

import {
  loadOrder,
  severityOf,
  validateManifests,
  type FixtureManifest,
  type FixtureJson,
} from './manifest.ts';

export type SeedErrorCode =
  'unsafe-target' | 'confirmation-required' | 'invalid-fixtures' | 'sql-failed';

export class SeedError extends Error {
  readonly code: SeedErrorCode;

  constructor(code: SeedErrorCode, message: string) {
    super(message);
    this.name = 'SeedError';
    this.code = code;
  }
}

export class UnsafeSeedTargetError extends SeedError {
  constructor(reason: string) {
    super(
      'unsafe-target',
      `refusing to seed: ${reason}. Fixtures are development and test data; a seed run that can ` +
        'reach a shared or remote database is one that eventually will',
    );
    this.name = 'UnsafeSeedTargetError';
  }
}

/**
 * Refuse a target that is not this machine's, or whose name suggests it is shared.
 *
 * Weaker than `assertSafeTestTarget`, deliberately: loading fixtures into the *development*
 * database is the ordinary case, and that database does not end in `_test`. The rules that matter
 * for an additive load are that the host is local and the name is not `production`, `staging`,
 * `live` or similar. Destructive replacement uses the stricter guard — see `assertReplaceable`.
 */
export function assertSeedableTarget(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Fail closed: an unparseable connection string is not evidence of safety.
    throw new UnsafeSeedTargetError('the connection string could not be parsed');
  }

  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.includes(host)) {
    throw new UnsafeSeedTargetError(`host "${host}" is not this machine`);
  }

  const name = databaseNameOf(connectionString).toLowerCase();
  if (name === '') throw new UnsafeSeedTargetError('the connection string names no database');

  const marker = FORBIDDEN_NAME_MARKERS.find((candidate) => name.includes(candidate));
  if (marker !== undefined) {
    throw new UnsafeSeedTargetError(`database "${name}" contains "${marker}"`);
  }
}

export function isSeedableTarget(connectionString: string): boolean {
  try {
    assertSeedableTarget(connectionString);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse destructive replacement anywhere but the guarded derived test database, and then only on
 * an explicit confirmation.
 *
 * Two gates rather than one because they refuse different mistakes. The target check refuses
 * "wrong database"; the confirmation refuses "right database, wrong intent" — an operator who
 * typed `reset` while thinking about something else. Neither substitutes for the other.
 */
export function assertReplaceable(
  connectionString: string,
  confirmation: string | undefined,
): void {
  // The strict guard: local host, name ends `_test`, no shared-environment markers.
  assertSafeTestTarget(connectionString);

  const name = databaseNameOf(connectionString);
  if (confirmation !== name) {
    throw new SeedError(
      'confirmation-required',
      `replacing fixture data deletes every seeded row in "${name}". Re-run with ` +
        `--confirm=${name} to say so explicitly. Only the derived ${TEST_DATABASE_SUFFIX} database ` +
        'may be replaced at all; the development database is never truncated by this tool',
    );
  }
}

/**
 * Validate, select and order — the one gate every public runner path goes through.
 *
 * The CLI validated before calling the runner, which meant the fixture contract was enforced by
 * *the route taken to the runner* rather than by the runner. A programmatic caller passing
 * hand-built manifests bypassed ownership, identity, determinism, credential, personal-data,
 * fingerprint and dependency checks entirely — and a guarantee that holds only for polite callers
 * is not a guarantee.
 *
 * Validation is complete rather than partial: the same `validateManifests` the CLI runs. Anything
 * less would leave a caller guessing which subset applied to them.
 */
function plan(options: SeedOptions): readonly FixtureManifest[] {
  const { manifests, violations } = validateManifests(options.manifests);

  if (violations.length > 0) {
    const detail = violations
      .map(
        (violation) =>
          `  ${severityOf(violation.check)} ${violation.check}  ${violation.dataset}: ` +
          violation.message,
      )
      .join('\n');
    throw new SeedError(
      'invalid-fixtures',
      `refusing to touch the database: ${violations.length} fixture violation(s)\n${detail}`,
    );
  }

  const selected =
    options.purpose === undefined
      ? manifests
      : manifests.filter((manifest) => manifest.purpose === options.purpose);

  const ordered = loadOrder(selected);
  if (ordered.length !== selected.length) {
    throw new SeedError(
      'invalid-fixtures',
      'the selected datasets contain a dependency cycle, so no load order exists. Run the ' +
        'fixture validator for the details',
    );
  }
  return ordered;
}

export interface SeedTableResult {
  readonly table: string;
  readonly rowsOffered: number;
  readonly rowsInserted: number;
  /** Offered minus inserted: rows that were already present, identity for identity. */
  readonly rowsSkipped: number;
}

export interface SeedDatasetResult {
  readonly dataset: string;
  readonly owner: string;
  readonly schema: string;
  readonly tables: readonly SeedTableResult[];
}

export interface SeedReport {
  readonly datasets: readonly SeedDatasetResult[];
  readonly rowsInserted: number;
  readonly rowsSkipped: number;
  /** True when every row was already present — the signature of a rerun. */
  readonly idempotent: boolean;
}

export interface SeedOptions {
  readonly manifests: readonly FixtureManifest[];
  /** Only datasets with this purpose are loaded. */
  readonly purpose?: 'development' | 'test';
}

/**
 * Load every dataset, in dependency order, in one transaction.
 *
 * The plan is computed before anything is written, so an unloadable set fails before it has touched
 * the database rather than halfway through.
 */
export async function seed(database: Database, options: SeedOptions): Promise<SeedReport> {
  const ordered = plan(options);

  const client = await database.connect();
  try {
    await client.query('BEGIN;');
    try {
      const datasets: SeedDatasetResult[] = [];
      for (const manifest of ordered) {
        datasets.push(await loadDataset(client, manifest));
      }
      await client.query('COMMIT;');
      return summarise(datasets, 'inserted');
    } catch (error) {
      // Every dataset shares one transaction, so this undoes all of them and not merely the one
      // that failed.
      await client.query('ROLLBACK;');
      throw asSeedError(error, 'seeding failed and the whole load was rolled back');
    }
  } finally {
    await client.release();
  }
}

async function loadDataset(
  client: DatabaseClient,
  manifest: FixtureManifest,
): Promise<SeedDatasetResult> {
  const tables: SeedTableResult[] = [];

  for (const table of manifest.tables) {
    const jsonColumns = new Set(table.jsonColumns ?? []);
    let inserted = 0;

    for (const row of table.rows) {
      const columns = Object.keys(row).sort();
      const placeholders = columns.map((column, index) =>
        jsonColumns.has(column) ? `$${index + 1}::jsonb` : `$${index + 1}`,
      );
      const values = columns.map((column) => encode(row[column] ?? null, jsonColumns.has(column)));

      // ON CONFLICT DO NOTHING against the declared identity is what makes a rerun a no-op. It
      // also means a fixture cannot overwrite a row somebody changed by hand while debugging —
      // which is the right way round: the database is authoritative during a debugging session.
      const result = await client.query(
        `INSERT INTO ${table.table} (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT (${table.identity.join(', ')}) DO NOTHING;`,
        values,
      );
      inserted += result.rowCount;
    }

    tables.push({
      table: table.table,
      rowsOffered: table.rows.length,
      rowsInserted: inserted,
      rowsSkipped: table.rows.length - inserted,
    });
  }

  return { dataset: manifest.dataset, owner: manifest.owner, schema: manifest.schema, tables };
}

function encode(value: FixtureJson, isJson: boolean): unknown {
  if (isJson) return JSON.stringify(value);
  return value;
}

/**
 * Delete every seeded row, in reverse load order, in one transaction.
 *
 * Reverse order because a dataset that depends on another may hold foreign keys into it. Deleting
 * only the declared identities rather than truncating: a truncate would remove rows this tool never
 * created, and the fixture set does not own the tables it writes into.
 */
export async function unseed(database: Database, options: SeedOptions): Promise<SeedReport> {
  const ordered = [...plan(options)].reverse();

  const client = await database.connect();
  try {
    await client.query('BEGIN;');
    try {
      const datasets: SeedDatasetResult[] = [];
      for (const manifest of ordered) {
        datasets.push(await deleteDataset(client, manifest));
      }
      await client.query('COMMIT;');
      return summarise(datasets, 'removed');
    } catch (error) {
      await client.query('ROLLBACK;');
      throw asSeedError(error, 'unseeding failed and was rolled back');
    }
  } finally {
    await client.release();
  }
}

export interface ReplaceReport {
  /** What was deleted, in reverse load order. */
  readonly removed: SeedReport;
  /** What was inserted afterwards, in load order. */
  readonly loaded: SeedReport;
  readonly rowsRemoved: number;
  readonly rowsInserted: number;
}

/**
 * Delete the declared rows and load them again — one transaction, one commit.
 *
 * Previously the CLI called `unseed` and then `seed`. Each was individually atomic, which sounds
 * like enough and is not: between the two commits the database held *no* fixture data, and if the
 * reload failed there — a constraint the edited fixtures now violate, a connection dropped — the
 * rows were already gone and the operator was left with an empty database and an error message.
 * The operation says "replace"; a replacement that can leave nothing behind is not one.
 *
 * So the delete and the load share a transaction. Any failure in either half rolls the whole thing
 * back and the original rows are still there. Deleting in reverse load order and inserting in load
 * order keeps foreign keys satisfied at every point in between.
 */
export async function replace(database: Database, options: SeedOptions): Promise<ReplaceReport> {
  const ordered = plan(options);

  const client = await database.connect();
  try {
    await client.query('BEGIN;');
    try {
      const removed: SeedDatasetResult[] = [];
      for (const manifest of [...ordered].reverse()) {
        removed.push(await deleteDataset(client, manifest));
      }

      const loaded: SeedDatasetResult[] = [];
      for (const manifest of ordered) {
        loaded.push(await loadDataset(client, manifest));
      }

      await client.query('COMMIT;');

      const removedReport = summarise(removed, 'removed');
      const loadedReport = summarise(loaded, 'inserted');
      return {
        removed: removedReport,
        loaded: loadedReport,
        rowsRemoved: removedReport.rowsInserted,
        rowsInserted: loadedReport.rowsInserted,
      };
    } catch (error) {
      // One rollback for both halves. The alternative — two transactions — leaves the database
      // empty when the second one fails.
      await client.query('ROLLBACK;');
      throw asSeedError(
        error,
        'replacement failed and was rolled back; the original rows are unchanged',
      );
    }
  } finally {
    await client.release();
  }
}

/** Delete one dataset's declared rows, children first. */
async function deleteDataset(
  client: DatabaseClient,
  manifest: FixtureManifest,
): Promise<SeedDatasetResult> {
  const tables: SeedTableResult[] = [];

  for (const table of [...manifest.tables].reverse()) {
    let removed = 0;
    for (const row of table.rows) {
      const predicate = table.identity
        .map((column, index) => `${column} = $${index + 1}`)
        .join(' AND ');
      const result = await client.query(
        `DELETE FROM ${table.table} WHERE ${predicate};`,
        table.identity.map((column) => row[column] ?? null),
      );
      removed += result.rowCount;
    }
    tables.push({
      table: table.table,
      rowsOffered: table.rows.length,
      rowsInserted: removed,
      rowsSkipped: table.rows.length - removed,
    });
  }

  return { dataset: manifest.dataset, owner: manifest.owner, schema: manifest.schema, tables };
}

function summarise(
  datasets: readonly SeedDatasetResult[],
  kind: 'inserted' | 'removed',
): SeedReport {
  const rowsInserted = datasets
    .flatMap((dataset) => dataset.tables)
    .reduce((total, table) => total + table.rowsInserted, 0);
  const rowsSkipped = datasets
    .flatMap((dataset) => dataset.tables)
    .reduce((total, table) => total + table.rowsSkipped, 0);

  return {
    datasets,
    rowsInserted,
    rowsSkipped: kind === 'inserted' ? rowsSkipped : 0,
    idempotent: kind === 'inserted' ? rowsInserted === 0 && rowsSkipped > 0 : rowsInserted === 0,
  };
}

/** A domain refusal passes through; anything else becomes `sql-failed` with the context attached. */
function asSeedError(error: unknown, context: string): SeedError {
  if (error instanceof SeedError) return error;
  return new SeedError(
    'sql-failed',
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
