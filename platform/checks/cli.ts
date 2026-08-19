/**
 * CLI wrapper for the architectural boundary checks.
 *
 *   node platform/checks/cli.ts              check the repository
 *   node platform/checks/cli.ts --root DIR   check an arbitrary tree (used by the tests)
 *   node platform/checks/cli.ts --json       machine-readable output
 *   node platform/checks/cli.ts --quiet      print only the result line
 *
 * Exit 0 = no violations. Exit 1 = at least one violation.
 *
 * Owned by: FND-001b (platform substrate).
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { CHECK_IDS, checkBoundaries, type CheckId } from './boundaries.ts';

const argv = process.argv.slice(2);

const flag = (name: string): boolean => argv.includes(`--${name}`);

const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};

/** Repository root: two levels up from platform/checks, whether run as .ts or as built .js. */
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = path.resolve(option('root') ?? defaultRoot);

const result = checkBoundaries(root);

if (flag('json')) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  if (!flag('quiet')) {
    console.log('JAYA architectural boundary checks');
    console.log('==================================');
    console.log(`root           : ${root}`);
    console.log(`files scanned  : ${result.filesScanned}`);
    console.log(`imports scanned: ${result.importsScanned}`);
    console.log('checks         :');
    const counts = new Map<CheckId, number>(CHECK_IDS.map((id) => [id, 0]));
    for (const v of result.violations) counts.set(v.check, (counts.get(v.check) ?? 0) + 1);
    for (const id of CHECK_IDS) {
      const n = counts.get(id) ?? 0;
      console.log(`  ${id.padEnd(20)} ${n === 0 ? 'PASS' : `FAIL (${n})`}`);
    }
  }

  if (result.violations.length > 0) {
    console.log('');
    for (const v of result.violations) {
      console.log(`  ${v.severity} [${v.check}] ${v.file}:${v.line}`);
      console.log(`      ${v.message}`);
    }
  }
  console.log('');
  console.log(
    result.violations.length === 0
      ? `RESULT: PASS — ${result.filesScanned} files, ${result.importsScanned} imports, 0 violations`
      : `RESULT: FAIL — ${result.violations.length} violation(s)`,
  );
}

process.exit(result.violations.length === 0 ? 0 : 1);
