/**
 * Migration runner CLI (FND-002b).
 *
 *   node platform/db/migrate-cli.ts status              what is applied, what is pending
 *   node platform/db/migrate-cli.ts up                  apply every pending migration
 *   node platform/db/migrate-cli.ts rollback --version NNNN --yes
 *
 * Reads its target from DATABASE_URL. A connection string is never accepted as an argument, so it
 * cannot land in shell history or a process listing, and it is never printed — only the redacted
 * description is.
 *
 * Rollback is operator-invoked by construction: it requires both an explicit `--version` and
 * `--yes`, and it refuses anything other than the most recently applied migration.
 *
 * Exit 0 = success. Exit 1 = a refusal the operator must act on. Exit 2 = misuse.
 *
 * Owned by: FND-002b (data foundation).
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from './env-file.ts';
import { MIGRATIONS_DIR } from './migrations.ts';
import { PostgresDatabase, connectionStringFromEnv } from './postgres.ts';
import { MigrationError, migrateDown, migrateUp, migrationStatus } from './runner.ts';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'status';

const flag = (name: string): boolean => argv.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// `cp .env.example .env` supplies DATABASE_URL. A shell export still takes precedence.
loadEnvFile(repoRoot);
const directory = path.resolve(option('dir') ?? path.join(repoRoot, MIGRATIONS_DIR));

const log = (message: string): void => {
  console.log(message);
};

const fail = (message: string, code: number): never => {
  console.error(message);
  process.exit(code);
};

async function main(): Promise<void> {
  if (!['status', 'up', 'rollback'].includes(command)) {
    fail(`unknown command "${command}". Expected: status | up | rollback`, 2);
  }

  const db = new PostgresDatabase(connectionStringFromEnv());

  console.log('JAYA migration runner');
  console.log('=====================');
  console.log(`target     : ${db.description}`);
  console.log(`directory  : ${directory}`);
  console.log('');

  if (command === 'status') {
    const report = await migrationStatus(db, { directory });
    console.log(`applied    : ${report.applied.length}`);
    for (const row of report.applied) {
      console.log(`  ${row.version} ${row.slug.padEnd(32)} ${row.checksum.slice(0, 12)}…`);
    }
    console.log(`pending    : ${report.pending.length}`);
    for (const version of report.pending) console.log(`  ${version}`);
    console.log('');
    console.log(report.pending.length === 0 ? 'RESULT: UP TO DATE' : 'RESULT: PENDING MIGRATIONS');
    return;
  }

  if (command === 'up') {
    const report = await migrateUp(db, { directory, log });
    console.log('');
    console.log(`already applied : ${report.alreadyApplied.length}`);
    console.log(`applied now     : ${report.applied.length}`);
    for (const applied of report.applied) {
      console.log(`  ${applied.version} ${applied.slug} (${applied.durationMs}ms)`);
    }
    console.log('');
    console.log('RESULT: PASS');
    return;
  }

  // rollback
  const version = option('version');
  if (version === undefined || !/^\d{4}$/.test(version)) {
    fail('rollback requires --version NNNN (four digits), naming the migration to reverse', 2);
  }
  if (!flag('yes')) {
    fail(
      `refusing to roll back ${String(version)} without --yes. Rollback is destructive and is ` +
        'operator-invoked only; nothing in this repository calls it automatically.',
      2,
    );
  }

  const report = await migrateDown(db, { directory, log, version: String(version) });
  console.log('');
  console.log(`rolled back: ${report.rolledBack}`);
  console.log('RESULT: PASS');
}

main().catch((error: unknown) => {
  if (error instanceof MigrationError) {
    console.error('');
    console.error(`RESULT: FAIL [${error.code}]`);
    console.error(error.message);
    process.exit(1);
  }
  console.error('');
  console.error('RESULT: FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
