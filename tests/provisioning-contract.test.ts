/**
 * Provisioning-contract tests (FND-002c).
 *
 * The first case asserts the real compose.yaml, .env.example, package.json, provisioning CLI and
 * test-database guard satisfy every guarantee. On its own that proves nothing — a contract that
 * returned no violations for any input would pass it too. So each case below plants one weakened
 * variant of a real artifact and requires the contract to catch it: a deleted health check, a
 * floating image tag, a credential moved into a committed file, a guard that accepts an unsafe
 * target, a destroy that no longer asks.
 *
 * The behavioural half of the target guard is tested directly, because "rejects a non-local host"
 * is a property of the function, not of its source text.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COMPOSE_PATH,
  ENV_EXAMPLE_PATH,
  MINIMUM_POSTGRES_MAJOR,
  PLACEHOLDER_PASSWORD,
  PROVISIONING_CONTRACT_IDS,
  REQUIRED_SCRIPTS,
  checkProvisioningContract,
} from '../platform/checks/provisioning-contract.ts';
import type {
  ProvisioningArtifacts,
  ProvisioningContractId,
} from '../platform/checks/provisioning-contract.ts';
import {
  FORBIDDEN_NAME_MARKERS,
  TEST_DATABASE_SUFFIX,
  UnsafeTestTargetError,
  assertSafeTestTarget,
  databaseNameOf,
  deriveTestDatabaseUrl,
  isSafeTestTarget,
  maintenanceUrl,
} from '../platform/db/test-database.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string): string => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

/** Paths git actually tracks, so a committed .env is caught by evidence rather than by belief. */
const trackedPaths = (): readonly string[] => {
  try {
    return execFileSync('git', ['ls-files'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .filter((line) => line !== '');
  } catch {
    // Not a git checkout (an exported tarball, say). The other credential checks still apply.
    return [];
  }
};

const artifacts = (): ProvisioningArtifacts => ({
  compose: read(COMPOSE_PATH),
  envExample: read(ENV_EXAMPLE_PATH),
  gitignore: read('.gitignore'),
  packageJson: read('package.json'),
  provisionCli: read('platform/db/provision-cli.ts'),
  migrateCli: read('platform/db/migrate-cli.ts'),
  testDatabase: read('platform/db/test-database.ts'),
  trackedPaths: trackedPaths(),
});

/** Replace one artifact with a weakened variant, asserting the mutation matched something. */
const weaken = (
  key: Exclude<keyof ProvisioningArtifacts, 'trackedPaths'>,
  find: string | RegExp,
  replace: string,
): ProvisioningArtifacts => {
  const base = artifacts();
  const original = base[key];
  const mutated =
    typeof find === 'string' ? original.split(find).join(replace) : original.replace(find, replace);
  assert.notEqual(
    mutated,
    original,
    `the mutation ${String(find)} matched nothing — test is stale`,
  );
  return { ...base, [key]: mutated };
};

const idsFrom = (input: ProvisioningArtifacts): ProvisioningContractId[] =>
  checkProvisioningContract(input).map((violation) => violation.id);

// --------------------------------------------------------------- the artifacts as delivered

test('the real provisioning artifacts satisfy every guarantee', () => {
  const violations = checkProvisioningContract(artifacts());
  assert.deepEqual(
    violations,
    [],
    `provisioning contract violations:\n${violations
      .map((v) => `  [${v.id}] ${v.message}`)
      .join('\n')}`,
  );
});

test('every provisioning artifact exists on disk', () => {
  for (const relative of [
    COMPOSE_PATH,
    ENV_EXAMPLE_PATH,
    'platform/db/provision-cli.ts',
    'platform/db/test-database.ts',
  ]) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, relative)), `${relative} is missing`);
  }
});

test('no .env file is tracked by git', () => {
  const committed = trackedPaths().filter(
    (tracked) => /^\.env($|\.)/.test(tracked) && tracked !== ENV_EXAMPLE_PATH,
  );
  assert.deepEqual(committed, [], 'a credential file is committed');
});

test('every provisioning command is declared', () => {
  const scripts = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  for (const script of REQUIRED_SCRIPTS) {
    assert.ok(script in scripts.scripts, `\`${script}\` is not a declared script`);
  }
});

test('the pinned PostgreSQL is an exact version at or above the selected major', () => {
  const image = /image:\s*postgres:(\S+)/.exec(read(COMPOSE_PATH));
  assert.ok(image, 'no postgres image declared');
  const tag = image[1] ?? '';
  assert.match(tag, /^\d+\.\d+/, `image tag "${tag}" is not an exact version`);
  assert.ok(Number.parseInt(tag.split('.')[0] ?? '0', 10) >= MINIMUM_POSTGRES_MAJOR);
});

// --------------------------------------------------------------- planted weakenings

const WEAKENINGS: ReadonlyArray<{
  readonly name: string;
  readonly id: ProvisioningContractId;
  readonly mutate: () => ProvisioningArtifacts;
}> = [
  {
    name: 'the health check is deleted',
    id: 'health-check',
    mutate: () => weaken('compose', /^\s*healthcheck:\s*$/m, '    # healthcheck removed'),
  },
  {
    name: 'the health check no longer uses pg_isready',
    id: 'health-check',
    mutate: () => weaken('compose', 'pg_isready', 'true'),
  },
  {
    name: 'the health check loses its retry policy',
    id: 'health-check',
    mutate: () => weaken('compose', /^\s*retries:.*$/m, '      # retries removed'),
  },
  {
    name: 'the PostgreSQL version floats to a major tag',
    id: 'pinned-version',
    mutate: () => weaken('compose', /image:\s*postgres:\S+/, 'image: postgres:16'),
  },
  {
    name: 'the PostgreSQL version floats to latest',
    id: 'pinned-version',
    mutate: () => weaken('compose', /image:\s*postgres:\S+/, 'image: postgres:latest'),
  },
  {
    name: 'the pinned PostgreSQL predates the selected major',
    id: 'pinned-version',
    mutate: () => weaken('compose', /image:\s*postgres:\S+/, 'image: postgres:14.11-alpine'),
  },
  {
    name: 'a password is hardcoded into the service definition',
    id: 'no-committed-secrets',
    mutate: () =>
      weaken(
        'compose',
        /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD[^}]*\}/,
        'POSTGRES_PASSWORD: hunter2SuperSecret',
      ),
  },
  {
    name: 'the committed example carries a real-looking credential',
    id: 'no-committed-secrets',
    mutate: () => weaken('envExample', PLACEHOLDER_PASSWORD, 'Xk92mQz7LpR4vTwe'),
  },
  {
    name: 'the ignore rule for .env is removed',
    id: 'no-committed-secrets',
    mutate: () => weaken('gitignore', /^\.env$/m, '# .env'),
  },
  {
    name: 'a .env file is committed',
    id: 'no-committed-secrets',
    mutate: () => ({ ...artifacts(), trackedPaths: [...artifacts().trackedPaths, '.env'] }),
  },
  {
    name: 'the data volume is no longer named',
    id: 'persistent-data',
    mutate: () => weaken('compose', /^volumes:\s*$/m, '# volumes removed'),
  },
  {
    name: 'the data directory is no longer mounted',
    id: 'persistent-data',
    mutate: () => weaken('compose', '/var/lib/postgresql/data', '/tmp/scratch'),
  },
  {
    name: 'the port is published on every interface',
    id: 'loopback-only',
    mutate: () =>
      weaken('compose', "'127.0.0.1:${POSTGRES_PORT:-5432}:5432'", "'${POSTGRES_PORT:-5432}:5432'"),
  },
  {
    name: 'the postgres service is renamed away',
    id: 'service-definition',
    mutate: () => weaken('compose', /^ {2}postgres:\s*$/m, '  database:'),
  },
  {
    name: 'the example stops documenting a required variable',
    id: 'env-example',
    mutate: () => weaken('envExample', /^POSTGRES_PORT=.*$/m, '# POSTGRES_PORT removed'),
  },
  {
    name: 'a provisioning command is dropped from package.json',
    id: 'commands',
    mutate: () => weaken('packageJson', '"db:destroy"', '"db:obliterate"'),
  },
  {
    name: 'destructive commands no longer require --yes',
    id: 'destructive-confirmation',
    mutate: () =>
      weaken(
        'provisionCli',
        /DESTRUCTIVE_COMMANDS\.includes\(command\) && !flag\('yes'\)/,
        'false',
      ),
  },
  {
    name: 'the destructive command list is emptied',
    id: 'destructive-confirmation',
    mutate: () => weaken('provisionCli', 'DESTRUCTIVE_COMMANDS', 'COMMANDS_THAT_ARE_FINE'),
  },
  {
    name: 'the test-target guard is removed',
    id: 'safe-target-guard',
    mutate: () =>
      weaken('testDatabase', 'export function assertSafeTestTarget', 'function unusedGuard'),
  },
  {
    name: 'a lifecycle function stops calling the guard',
    id: 'safe-target-guard',
    mutate: () =>
      weaken(
        'testDatabase',
        /export async function dropTestDatabase\([^)]*\): Promise<void> \{\n {2}assertSafeTestTarget\(testUrl\);/,
        'export async function dropTestDatabase(maintenance: Database, testUrl: string): Promise<void> {',
      ),
  },
  {
    name: 'the local-host allowlist is removed',
    id: 'safe-target-guard',
    mutate: () => weaken('testDatabase', 'export const LOCAL_HOSTS', 'const LOCAL_HOSTS'),
  },
  {
    name: 'the provisioning CLI stops loading .env',
    id: 'env-autoload',
    mutate: () => weaken('provisionCli', /loadEnvFile\(repoRoot\);/, ';'),
  },
  {
    name: 'the migration CLI stops loading .env',
    id: 'env-autoload',
    mutate: () => weaken('migrateCli', /loadEnvFile\(repoRoot\);/, ';'),
  },
  {
    name: 'the development-only statement is deleted from the service definition',
    id: 'development-only',
    mutate: () => weaken('compose', 'DEVELOPMENT ONLY', 'Production ready'),
  },
];

for (const weakening of WEAKENINGS) {
  test(`rejects weakened provisioning: ${weakening.name}`, () => {
    const ids = idsFrom(weakening.mutate());
    assert.ok(
      ids.includes(weakening.id),
      `expected a "${weakening.id}" violation, got ${JSON.stringify(ids)}`,
    );
  });
}

test('every declared provisioning guarantee is exercised by a planted weakening', () => {
  const covered = new Set(WEAKENINGS.map((weakening) => weakening.id));
  const uncovered = PROVISIONING_CONTRACT_IDS.filter((id) => !covered.has(id));
  assert.deepEqual(uncovered, [], `guarantees with no planted weakening: ${uncovered.join(', ')}`);
});

// --------------------------------------------------------------- the guard itself

test('the target guard accepts a derived local test database', () => {
  const derived = deriveTestDatabaseUrl('postgres://jaya_dev:pw@127.0.0.1:5432/jaya_dev');
  assert.equal(derived, 'postgres://jaya_dev:pw@127.0.0.1:5432/jaya_dev_test');
  assert.doesNotThrow(() => {
    assertSafeTestTarget(derived);
  });
  assert.equal(databaseNameOf(derived), 'jaya_dev_test');
});

test('derivation is idempotent, so a test URL stays one database', () => {
  const once = deriveTestDatabaseUrl('postgres://u:p@localhost:5432/jaya_dev');
  assert.equal(deriveTestDatabaseUrl(once), once);
});

test('the maintenance connection targets the server, not the database under test', () => {
  const maintenance = maintenanceUrl('postgres://u:p@127.0.0.1:5432/jaya_dev_test');
  assert.equal(maintenance, 'postgres://u:p@127.0.0.1:5432/postgres');
});

test('the target guard refuses a host that is not this machine', () => {
  for (const host of ['db.internal', 'jaya.example.com', '10.0.0.7', '192.168.1.20']) {
    assert.throws(
      () => {
        assertSafeTestTarget(`postgres://u:p@${host}:5432/jaya_dev_test`);
      },
      UnsafeTestTargetError,
      `${host} must be refused`,
    );
  }
});

test('the target guard refuses a database that is not named as a test database', () => {
  assert.throws(() => {
    assertSafeTestTarget('postgres://u:p@127.0.0.1:5432/jaya_dev');
  }, UnsafeTestTargetError);
  assert.throws(() => {
    assertSafeTestTarget('postgres://u:p@127.0.0.1:5432/');
  }, UnsafeTestTargetError);
});

test('the target guard refuses shared-environment names even on a loopback host', () => {
  // A port-forward to a shared database looks local. The name is the only remaining signal.
  for (const marker of FORBIDDEN_NAME_MARKERS) {
    const url = `postgres://u:p@127.0.0.1:5432/jaya_${marker}${TEST_DATABASE_SUFFIX}`;
    assert.throws(
      () => {
        assertSafeTestTarget(url);
      },
      UnsafeTestTargetError,
      `"${marker}" must disqualify a target however local it looks`,
    );
  }
});

test('the target guard fails closed on anything it cannot parse', () => {
  for (const bad of ['', 'not a url', 'jaya_dev_test']) {
    assert.equal(isSafeTestTarget(bad), false, `"${bad}" must not be treated as safe`);
  }
});

test('an unsafe target is never echoed back with its credentials', () => {
  try {
    assertSafeTestTarget('postgres://u:hunter2@db.internal:5432/prod');
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof UnsafeTestTargetError);
    assert.equal(error.message.includes('hunter2'), false, 'the password must not appear');
  }
});

test('deriving from an unsafe development URL is refused, not silently corrected', () => {
  assert.throws(
    () => deriveTestDatabaseUrl('postgres://u:p@db.internal:5432/jaya'),
    UnsafeTestTargetError,
  );
  assert.throws(
    () => deriveTestDatabaseUrl('postgres://u:p@127.0.0.1:5432/jaya_production'),
    UnsafeTestTargetError,
  );
});
