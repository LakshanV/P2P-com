/**
 * The fixture CLI (FND-002d).
 *
 *   node platform/fixtures/cli.ts validate            # the contract, no database needed
 *   node platform/fixtures/cli.ts list                # datasets and load order
 *   node platform/fixtures/cli.ts load                # additive, idempotent, local targets only
 *   node platform/fixtures/cli.ts reset --confirm=<db>  # destructive, guarded _test database only
 *
 * `validate` is the one wired into `npm run verify`, because it needs nothing but the files. The
 * others take their target from `DATABASE_URL` and never from an argument, so a connection string
 * cannot end up in shell history or a process listing — the same rule the migration CLI follows.
 *
 * Owned by: FND-002d (data foundation).
 */

import path from 'node:path';
import process from 'node:process';

import { loadEnvFile } from '../db/env-file.ts';
import { PostgresDatabase, connectionStringFromEnv } from '../db/postgres.ts';

import {
  FIXTURES_DIR,
  loadOrder,
  severityOf,
  validateFixtures,
  type FixtureValidation,
} from './manifest.ts';
import { SeedError, assertReplaceable, assertSeedableTarget, seed, unseed } from './runner.ts';

const repoRoot = process.cwd();
const directory = path.join(repoRoot, FIXTURES_DIR);

function reportValidation(validation: FixtureValidation, quiet: boolean): number {
  if (!quiet) {
    process.stdout.write('JAYA fixture contract\n');
    process.stdout.write('====================\n');
    process.stdout.write(`directory      : ${directory}\n`);
    process.stdout.write(`files scanned  : ${validation.filesScanned}\n`);
    process.stdout.write(`datasets       : ${validation.manifests.length}\n`);
  }

  if (validation.violations.length === 0) {
    if (!quiet) {
      const rows = validation.manifests
        .flatMap((manifest) => manifest.tables)
        .reduce((total, table) => total + table.rows.length, 0);
      process.stdout.write(`rows declared  : ${rows}\n\n`);
      process.stdout.write(
        `RESULT: PASS — ${validation.filesScanned} files, ${validation.manifests.length} datasets, 0 violations\n`,
      );
    }
    return 0;
  }

  process.stderr.write('\n');
  for (const violation of validation.violations) {
    process.stderr.write(
      `${severityOf(violation.check)} ${violation.check}  ${violation.file}\n` +
        `   ${violation.dataset}: ${violation.message}\n`,
    );
  }
  process.stderr.write(`\nRESULT: FAIL — ${validation.violations.length} violation(s)\n`);
  return 1;
}

function argumentValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((argument) => argument.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'validate';
  const quiet = process.argv.includes('--quiet');
  const validation = validateFixtures(directory);

  if (command === 'validate') return reportValidation(validation, quiet);

  if (command === 'list') {
    const code = reportValidation(validation, true);
    if (code !== 0) return code;
    process.stdout.write('load order\n==========\n');
    for (const [index, manifest] of loadOrder(validation.manifests).entries()) {
      const rows = manifest.tables.reduce((total, table) => total + table.rows.length, 0);
      process.stdout.write(
        `${index + 1}. ${manifest.dataset}  [${manifest.owner} -> ${manifest.schema}]  ` +
          `${manifest.purpose}, ${rows} row(s)\n`,
      );
      if (manifest.dependsOn.length > 0) {
        process.stdout.write(`   after: ${manifest.dependsOn.join(', ')}\n`);
      }
    }
    return 0;
  }

  if (command !== 'load' && command !== 'reset') {
    process.stderr.write(`unknown command "${command}"; expected validate, list, load or reset\n`);
    return 2;
  }

  // Invalid fixtures never reach a database. Validation is cheap and a partially-valid set is not
  // a thing worth loading.
  const invalid = reportValidation(validation, true);
  if (invalid !== 0) {
    process.stderr.write('refusing to touch the database while the fixture set is invalid\n');
    return invalid;
  }

  loadEnvFile(repoRoot);
  const connectionString = connectionStringFromEnv();
  const database = new PostgresDatabase(connectionString);

  if (command === 'load') {
    assertSeedableTarget(connectionString);
    const report = await seed(database, { manifests: validation.manifests });
    process.stdout.write(`target        : ${database.description}\n`);
    for (const dataset of report.datasets) {
      for (const table of dataset.tables) {
        process.stdout.write(
          `${dataset.dataset}  ${table.table}: ${table.rowsInserted} inserted, ` +
            `${table.rowsSkipped} already present\n`,
        );
      }
    }
    process.stdout.write(
      `\nRESULT: ${report.rowsInserted} row(s) inserted, ${report.rowsSkipped} already present` +
        `${report.idempotent ? ' (rerun: nothing changed)' : ''}\n`,
    );
    return 0;
  }

  // reset: destructive, and refused anywhere but the guarded derived _test database.
  assertReplaceable(connectionString, argumentValue('confirm'));
  const removed = await unseed(database, { manifests: validation.manifests });
  const report = await seed(database, { manifests: validation.manifests });
  process.stdout.write(`target        : ${database.description}\n`);
  process.stdout.write(
    `RESULT: ${removed.rowsInserted} row(s) removed, ${report.rowsInserted} re-inserted\n`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof SeedError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
