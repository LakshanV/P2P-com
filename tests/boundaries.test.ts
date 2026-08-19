/**
 * Enforcement tests for the four architectural boundary checks.
 *
 * Every check gets both halves of the proof:
 *   - a positive case, where conforming source produces no violation, and
 *   - a planted-violation case, where deliberately non-conforming source IS rejected.
 *
 * The second half is the point. A check that runs but cannot fail is a placeholder
 * (JAYA_MASTER_AUTONOMOUS_DEV_GUIDE_v3 §54), so each planted fixture is asserted to produce a
 * violation of a specific check, at a specific file, with a specific severity. The fixtures are
 * committed files, not generated at test time, so the proof survives in the repository.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHECK_IDS,
  checkBoundaries,
  classify,
  extractImports,
  type CheckId,
  type Violation,
} from '../platform/checks/boundaries.ts';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, '..');
const FIXTURES = path.join(TESTS_DIR, 'fixtures');

const fixture = (name: string): string => path.join(FIXTURES, name);

const of = (violations: readonly Violation[], check: CheckId): Violation[] =>
  violations.filter((v) => v.check === check);

// --------------------------------------------------------------------- positive

test('the real source tree has no boundary violations', () => {
  const result = checkBoundaries(REPO_ROOT);
  assert.deepEqual(
    result.violations,
    [],
    `the working tree must satisfy its own rules, found:\n${result.violations
      .map((v) => `${v.check} ${v.file}:${v.line}`)
      .join('\n')}`,
  );
  // Guard against a vacuous pass: the scan must actually have read the platform sources.
  assert.ok(result.filesScanned >= 4, `expected files to be scanned, got ${result.filesScanned}`);
});

test('a conforming tree exercising every allowed edge produces no violations', () => {
  const result = checkBoundaries(fixture('clean'));
  assert.equal(result.violations.length, 0, JSON.stringify(result.violations, null, 2));
  assert.equal(result.filesScanned, 9);
  assert.ok(
    result.importsScanned >= 9,
    `expected imports to be scanned, got ${result.importsScanned}`,
  );
});

// ------------------------------------------------------------ planted violations

test('layer-direction rejects an upward import and a sibling call', () => {
  const { violations } = checkBoundaries(fixture('violation-layer-direction'));
  const found = of(violations, 'layer-direction');
  assert.equal(found.length, 2, JSON.stringify(violations, null, 2));

  const upward = found.find((v) => v.file === 'modules/product-catalog/index.ts');
  assert.ok(upward, 'expected the L2 -> L5 upward import to be rejected');
  assert.equal(upward.severity, 'P1');
  assert.equal(upward.line, 2);
  assert.match(upward.message, /only point downward/);

  const sibling = found.find((v) => v.file === 'modules/returns/index.ts');
  assert.ok(sibling, 'expected the L7 -> L7 sibling call to be rejected');
  assert.match(sibling.message, /Same-layer modules must communicate by event/);
});

test('kernel-purity rejects a kernel component importing a business module', () => {
  const { violations } = checkBoundaries(fixture('violation-kernel-purity'));
  const found = of(violations, 'kernel-purity');
  assert.equal(found.length, 1, JSON.stringify(violations, null, 2));
  assert.equal(found[0]?.file, 'kernel/audit-foundation/index.ts');
  assert.equal(found[0]?.severity, 'P1');
  assert.match(found[0]?.message ?? '', /never depend on a business module/);
});

test('financial-zone-ai rejects zone code importing K-13, at P0', () => {
  const { violations } = checkBoundaries(fixture('violation-financial-zone-ai'));
  const found = of(violations, 'financial-zone-ai');
  assert.equal(found.length, 2, JSON.stringify(violations, null, 2));

  assert.deepEqual(found.map((v) => v.file).sort(), [
    'modules/payments/index.ts',
    'modules/rewards/ledger/entries.ts',
  ]);

  // A financial-authority breach is catastrophic, not merely major (v3 §52).
  for (const v of found) assert.equal(v.severity, 'P0');

  // Control: the zone is a path prefix, so Rewards code outside the ledger core is untouched.
  assert.equal(
    violations.filter((v) => v.file === 'modules/rewards/ui/panel.ts').length,
    0,
    'modules/rewards/ui is outside the ledger core and must not be restricted',
  );
});

test('provider-import rejects any provider SDK outside K-13', () => {
  const { violations } = checkBoundaries(fixture('violation-provider-import'));
  const found = of(violations, 'provider-import');
  assert.equal(found.length, 2, JSON.stringify(violations, null, 2));

  assert.deepEqual(found.map((v) => v.specifier).sort(), ['@anthropic-ai/sdk', 'openai']);

  // The restriction binds the kernel too — being kernel code is not an exemption.
  assert.ok(
    found.some((v) => v.file === 'kernel/policy-engine/index.ts'),
    'a non-gateway kernel component must not be exempt from the provider restriction',
  );
});

test('an unregistered unit is rejected because its layer is unknown', () => {
  const { violations } = checkBoundaries(fixture('violation-unregistered-unit'));
  assert.equal(violations.length, 1, JSON.stringify(violations, null, 2));
  assert.equal(violations[0]?.check, 'layer-direction');
  assert.match(
    violations[0]?.message ?? '',
    /not registered in platform\/architecture\/manifest\.ts/,
  );
});

test('every declared check id is covered by a planted-violation fixture', () => {
  const covered = new Set<CheckId>();
  for (const name of [
    'violation-layer-direction',
    'violation-kernel-purity',
    'violation-financial-zone-ai',
    'violation-provider-import',
  ]) {
    for (const v of checkBoundaries(fixture(name)).violations) covered.add(v.check);
  }
  assert.deepEqual([...covered].sort(), [...CHECK_IDS].sort());
});

// ------------------------------------------------------------------- unit level

test('import extraction handles multi-line, dynamic, re-export and require forms', () => {
  const source = [
    'import {',
    '  a,',
    '  b,',
    "} from './multi-line.ts';",
    "export * from './re-export.ts';",
    "const c = await import('./dynamic.ts');",
    "const d = require('./legacy.cjs');",
    "// import './commented-out.ts';",
    'const s = "./not-an-import.ts";',
  ].join('\n');

  assert.deepEqual(
    extractImports('sample.ts', source).map((i) => i.specifier),
    ['./multi-line.ts', './re-export.ts', './dynamic.ts', './legacy.cjs'],
  );
});

test('classify maps paths onto owning units and flags unknown directories', () => {
  assert.equal(classify('kernel/ai-gateway/adapters/openai.ts')?.id, 'kernel/ai-gateway');
  assert.equal(classify('modules/orders/api/create.ts')?.id, 'modules/orders');
  assert.equal(classify('modules/orders/api/create.ts')?.unregistered, false);
  assert.equal(classify('modules/nope/index.ts')?.unregistered, true);
  assert.equal(classify('kernel/nope/index.ts')?.unregistered, true);
  assert.equal(classify('docs/MODULE_MAP.md'), null, 'ungoverned paths are not classified');

  // Layer ordering must place the financial core above negotiation and below settlement.
  const catalog = classify('modules/product-catalog/x.ts')?.depth ?? 0;
  const orders = classify('modules/orders/x.ts')?.depth ?? 0;
  const settlements = classify('modules/settlements/x.ts')?.depth ?? 0;
  assert.ok(catalog < orders && orders < settlements);
});
