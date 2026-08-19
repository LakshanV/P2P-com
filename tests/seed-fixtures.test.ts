/**
 * The fixture-manifest contract (FND-002d).
 *
 * Two halves, and the second is the one that matters. The first asserts the real datasets in
 * `db/fixtures` are valid — necessary, but it would pass equally well against a validator that
 * checked nothing. The second plants one file per rule and requires the validator to reject each
 * with that rule's check id: a check with no planted violation is a check nobody has ever seen
 * fail, which is indistinguishable from a check that does not work.
 *
 * Planting is done by copying a file into a temporary directory rather than by editing the real
 * set, so a test that dies halfway through cannot leave a broken fixture behind.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KERNEL_COMPONENTS } from '../platform/architecture/manifest.ts';
import { ownerOfSchema } from '../platform/db/schema-namespaces.ts';
import {
  FIXTURES_DIR,
  FIXTURE_CHECK_IDS,
  MANIFEST_VERSION,
  discoverFixtureFiles,
  loadOrder,
  severityOf,
  validateFixtures,
  type FixtureCheckId,
} from '../platform/fixtures/manifest.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_DIR = path.join(REPO_ROOT, FIXTURES_DIR);
const PLANTED_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'seed');

/** Validate a set built from named planted files, in a directory of its own. */
function validatePlanted(...names: readonly string[]): ReturnType<typeof validateFixtures> {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jaya-fixtures-'));
  try {
    for (const name of names) {
      fs.copyFileSync(
        path.join(PLANTED_DIR, `${name}.fixture.json`),
        path.join(temporary, `${name}.fixture.json`),
      );
    }
    return validateFixtures(temporary);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const checksRaised = (validation: ReturnType<typeof validateFixtures>): ReadonlySet<string> =>
  new Set(validation.violations.map((violation) => violation.check));

// ---------------------------------------------------------------------------
// The real datasets
// ---------------------------------------------------------------------------

test('every real fixture passes the contract', () => {
  const validation = validateFixtures(REAL_DIR);
  assert.deepEqual(
    validation.violations.map((violation) => `${violation.file}: ${violation.message}`),
    [],
  );
  assert.ok(validation.filesScanned >= 2, 'there are fixtures to validate');
  assert.equal(validation.manifests.length, validation.filesScanned);
});

test('the real datasets seed only the implemented kernel foundations', () => {
  const { manifests } = validateFixtures(REAL_DIR);
  const owners = new Set(manifests.map((manifest) => manifest.owner));

  assert.deepEqual([...owners].sort(), ['K-05', 'K-08'], 'K-05 and K-08, and nothing else');

  for (const manifest of manifests) {
    const owner = ownerOfSchema(manifest.schema);
    assert.equal(owner?.id, manifest.owner, `${manifest.dataset} writes outside its owner`);
    assert.ok(
      manifest.schema.startsWith('kernel_'),
      'a business module has no implementation to seed data for, so no module_* schema may appear',
    );
  }

  // No business module, and no unimplemented kernel component, may be seeded: there is nothing to
  // seed *for*, and inventing its data would be inventing its contract.
  const implemented = new Set(
    KERNEL_COMPONENTS.filter((component) =>
      fs.existsSync(path.join(REPO_ROOT, 'kernel', component.dir, 'CONTRACT.md')),
    ).map((component) => component.id),
  );
  for (const owner of owners) {
    assert.ok(
      implemented.has(owner),
      `${owner} has no implemented contract, so it has no fixtures`,
    );
  }
});

test('the real datasets declare no financial policy value', () => {
  // Financial policy belongs to K-06, which does not exist. A fixture that seeded a commission
  // rate would be inventing a policy contract nobody has agreed.
  const financial = [
    'commission',
    'fee',
    'price',
    'payout',
    'settlement',
    'tax',
    'refund',
    'interest',
  ];
  const text = discoverFixtureFiles(REAL_DIR)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

  for (const word of financial) {
    assert.ok(
      !new RegExp(`"[^"]*\\b${word}\\b[^"]*"\\s*:`, 'i').test(text) &&
        !new RegExp(`"config_key"\\s*:\\s*"[^"]*${word}`, 'i').test(text),
      `a fixture mentions "${word}" as a key; financial policy is K-06's and K-06 does not exist`,
    );
  }
});

test('load order is deterministic and respects declared dependencies', () => {
  const { manifests } = validateFixtures(REAL_DIR);
  const order = loadOrder(manifests).map((manifest) => manifest.dataset);

  assert.equal(order.length, manifests.length, 'every dataset is placed');

  for (const manifest of manifests) {
    for (const dependency of manifest.dependsOn) {
      assert.ok(
        order.indexOf(dependency) < order.indexOf(manifest.dataset),
        `${dependency} must load before ${manifest.dataset}`,
      );
    }
  }

  // Same input, same plan — and the same plan whatever order the manifests arrive in, because a
  // load that depended on directory-listing order would fail differently on another machine.
  const reversed = loadOrder([...manifests].reverse()).map((manifest) => manifest.dataset);
  assert.deepEqual(reversed, order, 'ordering must not depend on input order');
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(
      loadOrder(manifests).map((m) => m.dataset),
      order,
    );
  }
});

test('every declared identity is present in every row of its table', () => {
  for (const manifest of validateFixtures(REAL_DIR).manifests) {
    for (const table of manifest.tables) {
      for (const [index, row] of table.rows.entries()) {
        for (const column of table.identity) {
          assert.ok(
            column in row,
            `${manifest.dataset} ${table.table} row ${index} lacks identity column ${column}`,
          );
        }
      }
    }
  }
});

test('every instant in the real fixtures is a fixed UTC literal', () => {
  // Not merely "no now()": an instant that is a literal but not canonical would still load, and
  // then two fixtures written on different days would sort differently for no visible reason.
  const instantColumn = /_at$|^effective_from$/;
  const literal = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

  for (const manifest of validateFixtures(REAL_DIR).manifests) {
    for (const table of manifest.tables) {
      for (const [index, row] of table.rows.entries()) {
        for (const [column, value] of Object.entries(row)) {
          if (!instantColumn.test(column) || value === null) continue;
          assert.ok(
            typeof value === 'string' && literal.test(value),
            `${manifest.dataset} ${table.table} row ${index} column ${column} is ` +
              `${JSON.stringify(value)}, which is not a fixed ISO-8601 UTC instant`,
          );
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Planted violations — one per check
// ---------------------------------------------------------------------------

test('every check has a planted fixture that it rejects', () => {
  const covered = new Set<FixtureCheckId>();

  const cases: ReadonlyArray<{ readonly check: FixtureCheckId; readonly files: string[] }> = [
    { check: 'malformed-manifest', files: ['malformed-manifest'] },
    { check: 'unknown-owner', files: ['unknown-owner'] },
    { check: 'cross-owner-table', files: ['cross-owner-table'] },
    { check: 'duplicate-identity', files: ['duplicate-identity'] },
    { check: 'dependency-cycle', files: ['dependency-cycle-a', 'dependency-cycle-b'] },
    { check: 'malformed-record', files: ['malformed-record'] },
    { check: 'nondeterministic-value', files: ['nondeterministic-value'] },
    { check: 'credential-in-fixture', files: ['credential-in-fixture'] },
    { check: 'personal-data', files: ['personal-data'] },
    { check: 'fingerprint-mismatch', files: ['fingerprint-mismatch'] },
  ];

  for (const scenario of cases) {
    const validation = validatePlanted(...scenario.files);
    assert.ok(
      checksRaised(validation).has(scenario.check),
      `${scenario.files.join(' + ')} must raise ${scenario.check}, raised ` +
        `[${[...checksRaised(validation)].join(', ')}]`,
    );
    covered.add(scenario.check);
  }

  assert.deepEqual(
    [...FIXTURE_CHECK_IDS].filter((check) => !covered.has(check)),
    [],
    'every check id must have a planted fixture; one without is a check nobody has seen fail',
  );
});

test('the planted directory holds a fixture for every check and nothing stale', () => {
  const planted = fs
    .readdirSync(PLANTED_DIR)
    .filter((file) => file.endsWith('.fixture.json'))
    .map((file) => file.replace('.fixture.json', ''));

  for (const check of FIXTURE_CHECK_IDS) {
    assert.ok(
      planted.some((name) => name.startsWith(check)),
      `no planted fixture for ${check}`,
    );
  }
  for (const name of planted) {
    assert.ok(
      FIXTURE_CHECK_IDS.some((check) => name.startsWith(check)),
      `${name}.fixture.json corresponds to no check; a stale plant proves nothing`,
    );
  }
});

test('a planted fixture never reaches the manifest list it fails on', () => {
  // A rejected file must not be loadable. Reporting a violation and returning the manifest anyway
  // would let the runner seed exactly the data the validator refused.
  const validation = validatePlanted('malformed-manifest');
  assert.equal(validation.violations.length, 1);
  assert.deepEqual(validation.manifests, [], 'an unparseable manifest is not returned as loadable');
});

test('data-safety violations are P0 and the rest are P1', () => {
  // Severity is a claim about consequence: a credential or a real person's data in a fixture is a
  // disclosure, and writing into another unit's schema corrupts a boundary. Those stop progression.
  for (const check of [
    'unknown-owner',
    'cross-owner-table',
    'nondeterministic-value',
    'credential-in-fixture',
    'personal-data',
    'fingerprint-mismatch',
  ] as const) {
    assert.equal(severityOf(check), 'P0', `${check} must be P0`);
  }
  for (const check of [
    'malformed-manifest',
    'duplicate-identity',
    'dependency-cycle',
    'malformed-record',
  ] as const) {
    assert.equal(severityOf(check), 'P1', `${check} must be P1`);
  }
});

test('the manifest version is checked rather than assumed', () => {
  assert.equal(MANIFEST_VERSION, 1);
  const validation = validatePlanted('malformed-manifest');
  assert.match(
    validation.violations[0]?.message ?? '',
    /manifestVersion/,
    'the refusal must name the field, so the fix is obvious',
  );
});

test('an empty directory is valid, and a missing one does not throw', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jaya-fixtures-empty-'));
  try {
    const validation = validateFixtures(temporary);
    assert.deepEqual(validation.violations, []);
    assert.deepEqual(validation.manifests, []);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  assert.deepEqual(discoverFixtureFiles(path.join(REPO_ROOT, 'no', 'such', 'directory')), []);
});
