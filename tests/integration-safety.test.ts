/**
 * Integration-suite safety tests (FND-002c correction).
 *
 * The first case asserts the real tests/integration directory satisfies the contract. Alone that
 * would be a check that cannot fail, so each case below plants the mistake the previous revision
 * actually made — a suite building its own connection, reading DATABASE_URL, or migrating outside
 * the guarded lifecycle — and requires the contract to catch it.
 *
 * These run in `npm run verify`, with no database anywhere near them. That is the point: the
 * mistake they prevent is invisible until someone runs the live suites, and by then their local
 * database is already gone.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HARNESS_FILE,
  INTEGRATION_DIR,
  INTEGRATION_SAFETY_IDS,
  checkIntegrationSafety,
} from '../platform/checks/integration-safety.ts';
import type {
  IntegrationFile,
  IntegrationSafetyId,
} from '../platform/checks/integration-safety.ts';
import { loadEnvFile, missingEnvMessage, parseEnvFile } from '../platform/db/env-file.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INTEGRATION_PATH = path.join(REPO_ROOT, INTEGRATION_DIR);

const realFiles = (): IntegrationFile[] =>
  fs
    .readdirSync(INTEGRATION_PATH, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({
      name: entry.name,
      source: fs.readFileSync(path.join(INTEGRATION_PATH, entry.name), 'utf8'),
    }));

/** Replace one file's source with a weakened variant, asserting the mutation matched. */
const weaken = (name: string, find: string | RegExp, replace: string): IntegrationFile[] => {
  const files = realFiles();
  const index = files.findIndex((file) => file.name === name);
  assert.notEqual(index, -1, `${name} is not present — test is stale`);
  const target = files[index];
  assert.ok(target);
  const mutated =
    typeof find === 'string'
      ? target.source.split(find).join(replace)
      : target.source.replace(find, replace);
  assert.notEqual(mutated, target.source, `the mutation ${String(find)} matched nothing`);
  files[index] = { name, source: mutated };
  return files;
};

/** Add a fabricated suite, for the mistakes that arrive as a new file rather than an edit. */
const withExtraFile = (name: string, source: string): IntegrationFile[] => [
  ...realFiles(),
  { name, source },
];

const idsFrom = (files: readonly IntegrationFile[]): IntegrationSafetyId[] =>
  checkIntegrationSafety(files).map((violation) => violation.id);

// --------------------------------------------------------------- the suites as delivered

test('no integration suite can reach the development database', () => {
  const violations = checkIntegrationSafety(realFiles());
  assert.deepEqual(
    violations,
    [],
    `integration-safety violations:\n${violations
      .map((v) => `  [${v.id}] ${v.file}:${v.line} ${v.message}`)
      .join('\n')}`,
  );
});

test('the harness exists and every other integration file is a suite', () => {
  const names = realFiles().map((file) => file.name);
  assert.ok(names.includes(HARNESS_FILE), `${HARNESS_FILE} is missing`);
  assert.ok(names.length > 1, 'there are no integration suites to protect');
});

test('every live suite enters the guarded lifecycle', () => {
  for (const file of realFiles()) {
    if (file.name === HARNESS_FILE) continue;
    assert.match(
      file.source,
      /withTestDatabase|assertSafeTestTarget/,
      `${file.name} touches a database without the harness`,
    );
  }
});

// ------------------------------------------------ discovered, and honestly skipped

/**
 * The glob `npm run test:integration` actually runs, read from package.json rather than restated.
 *
 * A suite that does not match this is not "not run yet" — it is invisible. It passes `npm run
 * verify` by never executing, and the component it belongs to looks proven when nothing about it
 * against a server has been checked at all.
 */
function integrationGlob(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = manifest.scripts?.['test:integration'];
  assert.ok(script !== undefined, 'package.json has no test:integration script');
  const glob = /"([^"]+)"/.exec(script)?.[1];
  assert.ok(glob !== undefined, `test:integration runs no glob: ${script}`);
  return glob;
}

/** Every live suite a kernel contract points at, derived from the contracts themselves. */
function suitesNamedByContracts(): { component: string; suite: string }[] {
  const kernel = path.join(REPO_ROOT, 'kernel');
  return fs
    .readdirSync(kernel, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(kernel, entry.name, 'CONTRACT.md')))
    .flatMap((entry) => {
      const contract = fs.readFileSync(path.join(kernel, entry.name, 'CONTRACT.md'), 'utf8');
      return [...contract.matchAll(/tests\/integration\/([\w.-]+\.integration\.ts)/g)].map(
        (match) => ({ component: entry.name, suite: String(match[1]) }),
      );
    });
}

test('every live suite a contract names is discovered by npm run test:integration', () => {
  // The failure this prevents is silent by construction: a suite in the wrong directory, or named
  // `.test.ts`, or `.integration.mts`, is never run by either command. `npm run verify` stays green
  // and the contract still says the live claims are covered — so the component reads as proven
  // against a server it has never touched.
  const glob = integrationGlob();
  const [globDir, globFile] = [
    path.posix.dirname(glob).replace('/**', ''),
    path.posix.basename(glob),
  ];
  assert.equal(globDir, INTEGRATION_DIR, `the glob no longer covers ${INTEGRATION_DIR}`);

  const suffix = globFile.replace('*', '');
  const named = suitesNamedByContracts();
  assert.ok(named.length > 0, 'no kernel contract names a live suite; the convention moved');

  for (const { component, suite } of named) {
    assert.ok(
      suite.endsWith(suffix),
      `kernel/${component} names ${suite}, which does not match ${glob} and would never run`,
    );
    assert.ok(
      fs.existsSync(path.join(INTEGRATION_PATH, suite)),
      `kernel/${component} names ${suite}, which is not in ${INTEGRATION_DIR}`,
    );
    assert.ok(
      realFiles().some((file) => file.name === suite),
      `${suite} is not one of the files the safety contract checks`,
    );
  }
});

test('every live suite skips honestly rather than passing without a database', () => {
  // The other half. A suite that is discovered but does not gate on `liveTestOptions` would either
  // fail the whole run wherever no database is configured, or — worse — quietly pass while
  // asserting nothing, which is the shape of evidence that is not evidence.
  for (const file of realFiles()) {
    if (file.name === HARNESS_FILE) continue;
    assert.match(
      file.source,
      /liveTestOptions/,
      `${file.name} does not gate on liveTestOptions, so it cannot skip with a stated reason`,
    );
  }
});

// --------------------------------------------------------------- planted mistakes

const PLANTED: ReadonlyArray<{
  readonly name: string;
  readonly id: IntegrationSafetyId;
  readonly mutate: () => IntegrationFile[];
}> = [
  {
    name: 'a suite builds its own connection',
    id: 'harness-only-connections',
    mutate: () =>
      withExtraFile(
        'rogue.integration.ts',
        [
          "import { PostgresDatabase } from '../../platform/db/postgres.ts';",
          "const db = new PostgresDatabase('postgres://u:p@127.0.0.1:5432/jaya_dev');",
        ].join('\n'),
      ),
  },
  {
    name: 'a suite reads the configured DATABASE_URL through the constant',
    id: 'harness-only-configuration',
    mutate: () =>
      withExtraFile(
        'rogue.integration.ts',
        [
          "import { DATABASE_URL_ENV } from '../../platform/db/postgres.ts';",
          'const url = process.env[DATABASE_URL_ENV];',
        ].join('\n'),
      ),
  },
  {
    name: 'a suite reads DATABASE_URL by literal name',
    id: 'harness-only-configuration',
    mutate: () => withExtraFile('rogue.integration.ts', "const url = process.env['DATABASE_URL'];"),
  },
  {
    name: 'a suite reads DATABASE_URL by property access',
    id: 'harness-only-configuration',
    mutate: () => withExtraFile('rogue.integration.ts', 'const url = process.env.DATABASE_URL;'),
  },
  {
    name: 'a suite migrates outside the guarded lifecycle',
    id: 'guarded-lifecycle',
    mutate: () =>
      withExtraFile(
        'rogue.integration.ts',
        [
          "import { migrateUp } from '../../platform/db/runner.ts';",
          'await migrateUp(somethingElse, { directory });',
        ].join('\n'),
      ),
  },
  {
    name: 'an existing suite drops out of withTestDatabase but keeps migrating',
    id: 'guarded-lifecycle',
    mutate: () => weaken('migrations.integration.ts', /withTestDatabase/g, 'runDirectly'),
  },
  {
    name: 'a suite plants a leftover database but only cleans up on success',
    id: 'seeded-cleanup',
    mutate: () =>
      weaken(
        'test-database-lifecycle.integration.ts',
        /} finally \{\n {6}\/\/ Runs even if an assertion above throws[\s\S]*?await removeTestDatabase\(\);\n {4}}/,
        '}\n    await removeTestDatabase();',
      ),
  },
  {
    name: 'a suite plants a leftover database and never removes it',
    id: 'seeded-cleanup',
    mutate: () =>
      withExtraFile(
        'rogue.integration.ts',
        [
          "import { seedLeftoverTestDatabase, withTestDatabase } from './harness.ts';",
          'await seedLeftoverTestDatabase();',
          'await withTestDatabase(async () => {});',
        ].join('\n'),
      ),
  },
  {
    name: 'the harness stops asserting the target is safe',
    id: 'harness-guards',
    mutate: () => weaken(HARNESS_FILE, /assertSafeTestTarget\(/g, 'noop('),
  },
  {
    name: 'the harness stops dropping the test database in a finally block',
    id: 'harness-guards',
    mutate: () =>
      weaken(
        HARNESS_FILE,
        /finally \{\n {4}await dropTestDatabase\(/,
        'finally {\n    await Promise.resolve(',
      ),
  },
  {
    name: 'the harness stops loading .env',
    id: 'harness-guards',
    mutate: () => weaken(HARNESS_FILE, /loadEnvFile\(REPO_ROOT\);/, ';'),
  },
  {
    name: 'the harness stops offering an honest skip',
    id: 'harness-guards',
    mutate: () => weaken(HARNESS_FILE, 'export const liveTestOptions', 'const liveTestOptions'),
  },
  {
    name: 'the harness is deleted',
    id: 'harness-guards',
    mutate: () => realFiles().filter((file) => file.name !== HARNESS_FILE),
  },
];

for (const planted of PLANTED) {
  test(`rejects an unsafe integration suite: ${planted.name}`, () => {
    const ids = idsFrom(planted.mutate());
    assert.ok(
      ids.includes(planted.id),
      `expected a "${planted.id}" violation, got ${JSON.stringify(ids)}`,
    );
  });
}

test('every declared integration-safety guarantee is exercised', () => {
  const covered = new Set(PLANTED.map((planted) => planted.id));
  const uncovered = INTEGRATION_SAFETY_IDS.filter((id) => !covered.has(id));
  assert.deepEqual(uncovered, [], `guarantees with no planted mistake: ${uncovered.join(', ')}`);
});

test('a rule cannot be satisfied by a comment mentioning it', () => {
  const commented = withExtraFile(
    'rogue.integration.ts',
    [
      '// This file uses withTestDatabase, honestly it does.',
      '/* withTestDatabase( */',
      "import { migrateUp } from '../../platform/db/runner.ts';",
      'await migrateUp(somethingElse, { directory });',
    ].join('\n'),
  );
  assert.ok(
    idsFrom(commented).includes('guarded-lifecycle'),
    'a comment naming the helper must not satisfy the rule',
  );
});

// --------------------------------------------------------------- .env is sufficient on its own

test('the env file parser reads the shape .env.example actually uses', () => {
  const parsed = parseEnvFile(fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8'));
  assert.equal(parsed['POSTGRES_USER'], 'jaya_dev');
  assert.equal(parsed['POSTGRES_PORT'], '5432');
  assert.match(String(parsed['DATABASE_URL']), /^postgres:\/\/.+@127\.0\.0\.1:5432\/jaya_dev$/);
});

test('the parser ignores comments and blank lines, and unwraps quotes', () => {
  const parsed = parseEnvFile(
    [
      '# a comment',
      '',
      'PLAIN=value',
      'QUOTED="quoted value"',
      "SINGLE='single'",
      'TRAILING=v # note',
      'export EXPORTED=e',
      'nonsense line',
    ].join('\n'),
  );
  assert.deepEqual(parsed, {
    PLAIN: 'value',
    QUOTED: 'quoted value',
    SINGLE: 'single',
    TRAILING: 'v',
    EXPORTED: 'e',
  });
});

test('a value already in the environment always wins over the file', () => {
  const scratch = fs.mkdtempSync(path.join(REPO_ROOT, 'tmp-env-'));
  try {
    fs.writeFileSync(path.join(scratch, '.env'), 'ALREADY_SET=from-file\nNOT_SET=from-file\n');
    const env: NodeJS.ProcessEnv = { ALREADY_SET: 'from-shell' };

    const result = loadEnvFile(scratch, env);

    assert.equal(env['ALREADY_SET'], 'from-shell', 'a shell export is the more specific intent');
    assert.equal(env['NOT_SET'], 'from-file', 'an unset variable is filled from the file');
    assert.deepEqual(result.applied, ['NOT_SET']);
    assert.deepEqual(result.skipped, ['ALREADY_SET']);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a missing .env is reported, not invented', () => {
  const scratch = fs.mkdtempSync(path.join(REPO_ROOT, 'tmp-env-'));
  try {
    const result = loadEnvFile(scratch, {});
    assert.equal(result.file, null);
    assert.deepEqual(result.applied, []);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('the missing-variable message names the one command that fixes it', () => {
  const message = missingEnvMessage('DATABASE_URL');
  assert.match(message, /cp \.env\.example \.env/);
  assert.match(message, /DATABASE_URL is not set/);
});
