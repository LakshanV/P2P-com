/**
 * The migration runner (FND-002b).
 *
 * FND-002a proved a migration file cannot be structurally unsafe. This applies them, and the
 * properties that matter are the ones that only show up on the worst day:
 *
 *   - **Atomicity with the ledger.** A migration and the row recording it commit together or not
 *     at all. Anything else produces a database whose schema and whose history disagree, which is
 *     the state that takes a human hours to untangle at 3am.
 *   - **One runner at a time.** Two deploys racing apply the same DDL twice. A session-level
 *     advisory lock, taken with `try` rather than `wait`, makes the second one fail loudly and
 *     immediately instead of interleaving.
 *   - **Fail closed.** A checksum that has drifted, a ledger row with no file, a version that
 *     arrives out of order — each means the operator's model of the database is wrong. The runner
 *     refuses to proceed rather than guessing which way the truth lies.
 *
 * Reconciling the self-wrapped SQL. FND-002a requires every migration file to carry its own
 * `BEGIN; … COMMIT;` so it can be applied by hand with psql. That is incompatible with recording
 * the ledger row inside the same transaction — the file would commit first. So the runner strips
 * exactly the outer transaction and re-wraps the body together with the ledger INSERT. The files
 * stay independently runnable, the validator rule stays as it is, and nothing commits before its
 * ledger row. If the outer transaction is not exactly where the contract says it is, the runner
 * refuses the file rather than executing an unwrapped body.
 *
 * Bootstrap. On an empty database the ledger does not exist yet, so it cannot record migration
 * 0001 — a ledger created by a migration cannot record the migration that created it. The runner
 * therefore owns the schema and the ledger, and creates them **inside the first migration's own
 * transaction**. Either the schema, the ledger and the first history row all commit together, or
 * none of them do; there is no window in which the objects exist with no history to explain them.
 * The bootstrap DDL is the same `IF NOT EXISTS` definition migrations 0001 and 0002 carry, so
 * applying the set by hand with psql produces the same result.
 *
 * Read-only means read-only. `status` and a refused rollback never create anything. They ask
 * whether the ledger exists and treat its absence as "nothing applied", because a command that
 * reports on a database must not be the thing that changes it.
 *
 * Owned by: FND-002b (data foundation). Talks to the injected Database interface only; contains
 * no driver import and no business logic.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Database, DatabaseClient } from './client.ts';
import { stripNoise, validateMigrations } from './migrations.ts';
import { PLATFORM_SCHEMA } from './schema-namespaces.ts';

/** Fully-qualified ledger table. */
export const LEDGER_TABLE = `${PLATFORM_SCHEMA}.schema_migrations`;

/**
 * Advisory lock key. Session-level and constant, so every runner against a given database
 * competes for the same lock. Derived once from a fixed string and then frozen here as a literal:
 * a key that changed with a refactor would silently stop excluding older runners still deploying.
 * `advisoryLockKey()` recomputes it and a test asserts the two agree.
 */
export const ADVISORY_LOCK_KEY = 5_573_680_152_581_085n;

/** The derivation, kept executable so the constant above can be checked rather than trusted. */
export function advisoryLockKey(): bigint {
  const digest = createHash('sha256').update('jaya.migrations.runner').digest();
  // 53 bits: comfortably inside bigint, and inside a signed bigint PostgreSQL accepts.
  let key = 0n;
  for (let index = 0; index < 7; index += 1) key = (key << 8n) | BigInt(digest[index] ?? 0);
  return key >> 3n;
}

export type FailureCode =
  | 'invalid-migration-set'
  | 'concurrent-run'
  | 'checksum-drift'
  | 'unknown-applied-version'
  | 'out-of-order-version'
  | 'malformed-transaction'
  | 'missing-rollback-file'
  | 'rollback-not-latest'
  | 'rollback-unapplied'
  | 'sql-failed';

/** A refusal the operator needs to act on, as distinct from an unexpected crash. */
export class MigrationError extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

export interface LedgerRow {
  readonly version: string;
  readonly slug: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly slug: string;
  readonly checksum: string;
  readonly durationMs: number;
}

export interface RunReport {
  readonly target: string;
  readonly alreadyApplied: readonly string[];
  readonly applied: readonly AppliedMigration[];
  readonly pendingBefore: readonly string[];
}

export interface RollbackReport {
  readonly target: string;
  readonly rolledBack: string;
}

export interface StatusReport {
  readonly target: string;
  readonly applied: readonly LedgerRow[];
  readonly pending: readonly string[];
}

export interface RunnerOptions {
  /** Absolute path to the migrations directory. */
  readonly directory: string;
  /** Progress sink. Never receives credentials — the runner has none to give it. */
  readonly log?: (message: string) => void;
  /**
   * Apply migrations only up to and including this version. Useful for tests that need to roll back
   * a specific migration without first having to roll back everything that came after it.
   */
  readonly target?: string;
}

interface DiscoveredMigration {
  readonly version: string;
  readonly slug: string;
  readonly upFile: string;
  readonly downFile: string;
  readonly upSql: string;
  readonly checksum: string;
}

/** SHA-256 of the forward file exactly as it sits on disk. */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Remove the outer `BEGIN;` / `COMMIT;` so the body can be re-wrapped with the ledger write.
 *
 * Deliberately strict. If the file is not wrapped exactly as the contract requires, the runner
 * refuses it: executing a body whose transaction boundaries it has not understood is precisely
 * the failure this whole design exists to prevent.
 */
export function unwrapTransaction(sql: string, file: string): string {
  // Locate the boundaries in comment- and string-blanked text, so a BEGIN quoted in a comment
  // cannot be mistaken for the real one. stripNoise preserves length, so the indices it yields
  // address the raw SQL directly.
  const code = stripNoise(sql);

  const begin = /\bBEGIN\s*;/i.exec(code);
  if (begin === null) {
    throw new MigrationError(
      'malformed-transaction',
      `${file} has no BEGIN; — the runner will not execute a body whose transaction boundaries ` +
        'it cannot identify',
    );
  }

  const commits = [...code.matchAll(/\bCOMMIT\s*;/gi)];
  const lastCommit = commits.at(-1);
  if (lastCommit === undefined || lastCommit.index === undefined) {
    throw new MigrationError(
      'malformed-transaction',
      `${file} has no COMMIT; — refusing to execute a partially-delimited body`,
    );
  }
  if (code.slice(lastCommit.index + lastCommit[0].length).trim() !== '') {
    throw new MigrationError(
      'malformed-transaction',
      `${file} has statements after its final COMMIT; — they would run outside the transaction ` +
        'the runner controls',
    );
  }

  const bodyStart = begin.index + begin[0].length;
  const bodyEnd = lastCommit.index;
  if (bodyEnd < bodyStart) {
    throw new MigrationError(
      'malformed-transaction',
      `${file} closes its transaction before opening it`,
    );
  }

  if (/\b(?:BEGIN|COMMIT|ROLLBACK)\s*;/i.test(code.slice(bodyStart, bodyEnd))) {
    throw new MigrationError(
      'malformed-transaction',
      `${file} contains a nested transaction statement — the runner owns the transaction, so an ` +
        'inner COMMIT would let the migration commit before its ledger row',
    );
  }

  return sql.slice(bodyStart, bodyEnd);
}

/** Read and pair the migration files, refusing the whole set if the FND-002a contract fails. */
export function discover(directory: string): readonly DiscoveredMigration[] {
  const validation = validateMigrations(directory);
  if (validation.violations.length > 0) {
    const detail = validation.violations
      .map((v) => `  ${v.severity} [${v.check}] ${v.file} ${v.message}`)
      .join('\n');
    throw new MigrationError(
      'invalid-migration-set',
      `the migration set does not satisfy the contract, so nothing was applied:\n${detail}`,
    );
  }

  return validation.migrations
    .filter((migration) => migration.direction === 'up')
    .map((migration) => {
      const upFile = migration.file;
      const downFile = `${migration.version}_${migration.slug}.down.sql`;
      const upSql = fs.readFileSync(path.join(directory, upFile), 'utf8');
      return {
        version: migration.version,
        slug: migration.slug,
        upFile,
        downFile,
        upSql,
        checksum: checksumOf(upSql),
      };
    })
    .sort((a, b) => a.version.localeCompare(b.version));
}

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS ${PLATFORM_SCHEMA};

CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  version      text        NOT NULL,
  slug         text        NOT NULL,
  checksum     text        NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  applied_by   text        NOT NULL DEFAULT current_user,
  duration_ms  integer     NULL,
  CONSTRAINT schema_migrations_pkey PRIMARY KEY (version),
  CONSTRAINT schema_migrations_version_format CHECK (version ~ '^[0-9]{4}$'),
  CONSTRAINT schema_migrations_slug_format CHECK (slug ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  CONSTRAINT schema_migrations_duration_nonnegative CHECK (duration_ms IS NULL OR duration_ms >= 0)
);
`;

/**
 * Does the ledger exist? Asked with to_regclass, which returns NULL rather than raising, so the
 * question can be put to a completely empty database without creating anything or handling an
 * error as control flow.
 */
async function ledgerExists(client: DatabaseClient): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present;',
    [LEDGER_TABLE],
  );
  return result.rows[0]?.present === true;
}

async function acquireLock(client: DatabaseClient): Promise<void> {
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS locked;',
    [ADVISORY_LOCK_KEY.toString()],
  );
  if (result.rows[0]?.locked !== true) {
    throw new MigrationError(
      'concurrent-run',
      'another migration run holds the advisory lock — refusing to run concurrently, because two ' +
        'runners applying the same DDL is not a recoverable state',
    );
  }
}

async function releaseLock(client: DatabaseClient): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1);', [ADVISORY_LOCK_KEY.toString()]);
}

async function readLedger(client: DatabaseClient): Promise<readonly LedgerRow[]> {
  const result = await client.query<LedgerRow>(
    `SELECT version, slug, checksum FROM ${LEDGER_TABLE} ORDER BY version ASC;`,
  );
  return result.rows;
}

/**
 * Compare the ledger against the files on disk. Every disagreement is fatal — this is the point
 * at which the runner decides whether the operator's model of the database is still true.
 */
function reconcile(
  applied: readonly LedgerRow[],
  discovered: readonly DiscoveredMigration[],
): readonly DiscoveredMigration[] {
  const byVersion = new Map(discovered.map((migration) => [migration.version, migration]));

  for (const row of applied) {
    const migration = byVersion.get(row.version);
    if (migration === undefined) {
      throw new MigrationError(
        'unknown-applied-version',
        `the ledger records version ${row.version} (${row.slug}) but no such migration exists on ` +
          'disk — this database was migrated by a different revision of the repository',
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(
        'checksum-drift',
        `${migration.upFile} has changed since it was applied (ledger ${row.checksum.slice(0, 12)}…, ` +
          `file ${migration.checksum.slice(0, 12)}…) — an applied migration is immutable; correct ` +
          'it with a new migration instead',
      );
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = discovered.filter((migration) => !appliedVersions.has(migration.version));

  const highestApplied = applied.reduce((max, row) => (row.version > max ? row.version : max), '');
  for (const migration of pending) {
    if (highestApplied !== '' && migration.version < highestApplied) {
      throw new MigrationError(
        'out-of-order-version',
        `${migration.upFile} is unapplied but sorts before applied version ${highestApplied} — ` +
          'applying it now would produce a schema no other environment can reproduce',
      );
    }
  }
  return pending;
}

/**
 * Apply one migration and its ledger row in a single transaction.
 *
 * On a fresh database the bootstrap DDL joins that same transaction, so the schema, the ledger and
 * the first history row become visible together or not at all.
 */
async function applyOne(
  client: DatabaseClient,
  migration: DiscoveredMigration,
  now: () => number,
  includeBootstrap: boolean,
): Promise<AppliedMigration> {
  const body = unwrapTransaction(migration.upSql, migration.upFile);
  const startedAt = now();

  await client.query('BEGIN;');
  try {
    if (includeBootstrap) await client.query(BOOTSTRAP_SQL);
    await client.query(body);
    const durationMs = Math.max(0, now() - startedAt);
    await client.query(
      `INSERT INTO ${LEDGER_TABLE} (version, slug, checksum, duration_ms) VALUES ($1, $2, $3, $4);`,
      [migration.version, migration.slug, migration.checksum, durationMs],
    );
    await client.query('COMMIT;');
    return {
      version: migration.version,
      slug: migration.slug,
      checksum: migration.checksum,
      durationMs,
    };
  } catch (error) {
    await client.query('ROLLBACK;');
    throw new MigrationError(
      'sql-failed',
      `${migration.upFile} failed and was rolled back; the ledger records no row for it. ` +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Run every session against a fresh connection, holding the advisory lock for the whole run and
 * releasing it on every exit path.
 */
async function withLockedSession<T>(
  db: Database,
  action: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  let locked = false;
  try {
    await acquireLock(client);
    locked = true;
    return await action(client);
  } finally {
    // Release before closing, and never let a release failure mask the original error.
    if (locked) {
      try {
        await releaseLock(client);
      } catch {
        /* the session is ending anyway; PostgreSQL drops session locks on disconnect */
      }
    }
    await client.release();
  }
}

/** Apply every pending forward migration, in version order, optionally stopping at target. */
export async function migrateUp(
  db: Database,
  options: RunnerOptions,
  now: () => number = () => Date.now(),
): Promise<RunReport> {
  const log = options.log ?? ((): void => {});
  const discovered = discover(options.directory);

  if (options.target !== undefined) {
    const target = discovered.find((migration) => migration.version === options.target);
    if (target === undefined) {
      throw new MigrationError(
        'unknown-applied-version',
        `target migration ${options.target} does not exist in ${options.directory}`,
      );
    }
  }

  return withLockedSession(db, async (client) => {
    const bootstrapped = await ledgerExists(client);
    const applied = bootstrapped ? await readLedger(client) : [];
    const pending = reconcile(applied, discovered);

    log(`target: ${db.description}`);
    log(`applied: ${applied.length}, pending: ${pending.length}`);
    if (!bootstrapped && pending.length === 0) {
      // Nothing to apply and nothing to record. Creating the ledger here would leave objects
      // behind for a command that did no work.
      log('no migrations to apply; nothing created');
    }

    const results: AppliedMigration[] = [];
    for (const [index, migration] of pending.entries()) {
      if (options.target !== undefined && migration.version.localeCompare(options.target) > 0) {
        log(`stopping at ${options.target}; ${migration.upFile} remains pending`);
        break;
      }
      log(`applying ${migration.upFile}`);
      results.push(await applyOne(client, migration, now, !bootstrapped && index === 0));
    }

    return {
      target: db.description,
      alreadyApplied: applied.map((row) => row.version),
      applied: results,
      pendingBefore: pending.map((migration) => migration.version),
    };
  });
}

/** Report what is applied and what is pending, changing nothing. */
export async function migrationStatus(db: Database, options: RunnerOptions): Promise<StatusReport> {
  const discovered = discover(options.directory);
  return withLockedSession(db, async (client) => {
    // Strictly read-only: an absent ledger means nothing has been applied, not that something
    // needs creating.
    const applied = (await ledgerExists(client)) ? await readLedger(client) : [];
    const pending = reconcile(applied, discovered);
    return {
      target: db.description,
      applied,
      pending: pending.map((migration) => migration.version),
    };
  });
}

/**
 * Roll one migration back. **Operator-invoked only** — nothing calls this automatically, and the
 * CLI requires the version to be named explicitly.
 *
 * Fails closed on any inconsistency: a drifted checksum, a ledger row with no file, a request for
 * anything other than the most recently applied version, or a missing rollback file. Rolling back
 * out of order, or on evidence the runner cannot verify, is how a recovery turns into an outage.
 */
export async function migrateDown(
  db: Database,
  options: RunnerOptions & { readonly version: string },
): Promise<RollbackReport> {
  const log = options.log ?? ((): void => {});
  const discovered = discover(options.directory);

  return withLockedSession(db, async (client) => {
    // A refused rollback must change nothing, including creating a ledger to refuse against.
    const applied = (await ledgerExists(client)) ? await readLedger(client) : [];

    // Reconcile first: a rollback decided on unverified history is worse than no rollback.
    reconcile(applied, discovered);

    if (applied.length === 0) {
      throw new MigrationError(
        'rollback-unapplied',
        'no migration has been applied to this database, so there is nothing to roll back',
      );
    }
    const latest = applied[applied.length - 1];
    if (latest === undefined || latest.version !== options.version) {
      throw new MigrationError(
        'rollback-not-latest',
        `refusing to roll back ${options.version}: the most recently applied migration is ` +
          `${latest?.version ?? 'none'}. Roll back in reverse order, one version at a time`,
      );
    }

    const migration = discovered.find((candidate) => candidate.version === options.version);
    if (migration === undefined) {
      throw new MigrationError(
        'unknown-applied-version',
        `no migration on disk for version ${options.version}`,
      );
    }

    const downPath = path.join(options.directory, migration.downFile);
    if (!fs.existsSync(downPath)) {
      throw new MigrationError(
        'missing-rollback-file',
        `${migration.downFile} does not exist — refusing to roll back a migration whose reversal ` +
          'is undefined',
      );
    }

    const body = unwrapTransaction(fs.readFileSync(downPath, 'utf8'), migration.downFile);
    log(`rolling back ${migration.downFile}`);

    await client.query('BEGIN;');
    try {
      // The history row goes first. A rollback that drops something the DELETE depends on would
      // otherwise fail against a relation it had just removed — which is exactly how the original
      // 0002 rollback became unexecutable. Order inside the transaction costs nothing and removes
      // a whole class of self-referential failure.
      await client.query(`DELETE FROM ${LEDGER_TABLE} WHERE version = $1;`, [migration.version]);
      await client.query(body);
      await client.query('COMMIT;');
    } catch (error) {
      await client.query('ROLLBACK;');
      throw new MigrationError(
        'sql-failed',
        `${migration.downFile} failed and was rolled back; the ledger row for ` +
          `${migration.version} is untouched. Underlying error: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return { target: db.description, rolledBack: migration.version };
  });
}
