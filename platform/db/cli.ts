/**
 * CLI wrapper for the migration contract.
 *
 *   node platform/db/cli.ts               validate db/migrations
 *   node platform/db/cli.ts --dir DIR     validate an arbitrary directory (used by the tests)
 *   node platform/db/cli.ts --json        machine-readable output
 *   node platform/db/cli.ts --quiet       print only the result line
 *
 * Exit 0 = no violations. Exit 1 = at least one violation.
 *
 * This opens no database connection. It reads SQL files and checks their structure, which is why
 * it runs inside `npm run verify` on a machine with no PostgreSQL installed.
 *
 * Owned by: FND-002a (data foundation).
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MIGRATIONS_DIR, MIGRATION_CHECK_IDS, validateMigrations } from './migrations.ts';
import type { MigrationCheckId } from './migrations.ts';
import { knownSchemas } from './schema-namespaces.ts';

const argv = process.argv.slice(2);

const flag = (name: string): boolean => argv.includes(`--${name}`);

const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

/** Repository root: two levels up from platform/db, whether run as .ts or as built .js. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.resolve(option('dir') ?? path.join(repoRoot, MIGRATIONS_DIR));

const result = validateMigrations(dir);

if (flag('json')) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  if (!flag('quiet')) {
    console.log('JAYA migration contract');
    console.log('=======================');
    console.log(`directory      : ${dir}`);
    console.log(`files scanned  : ${result.filesScanned}`);
    console.log(`forward        : ${result.migrations.filter((m) => m.direction === 'up').length}`);
    console.log(
      `rollback       : ${result.migrations.filter((m) => m.direction === 'down').length}`,
    );
    console.log(`owned schemas  : ${knownSchemas().length} (from the architecture manifest)`);
    console.log('checks         :');
    const counts = new Map<MigrationCheckId, number>(MIGRATION_CHECK_IDS.map((id) => [id, 0]));
    for (const v of result.violations) counts.set(v.check, (counts.get(v.check) ?? 0) + 1);
    for (const id of MIGRATION_CHECK_IDS) {
      const n = counts.get(id) ?? 0;
      console.log(`  ${id.padEnd(20)} ${n === 0 ? 'PASS' : `FAIL (${n})`}`);
    }
  }

  if (result.violations.length > 0) {
    console.log('');
    for (const v of result.violations) {
      console.log(`  ${v.severity} [${v.check}] ${v.file}${v.line > 0 ? `:${v.line}` : ''}`);
      console.log(`      ${v.message}`);
    }
  }
  console.log('');
  console.log(
    result.violations.length === 0
      ? `RESULT: PASS — ${result.filesScanned} files, 0 violations`
      : `RESULT: FAIL — ${result.violations.length} violation(s)`,
  );
}

process.exit(result.violations.length === 0 ? 0 : 1);
