/**
 * Integrity tests for platform/architecture/manifest.ts, the machine-readable encoding of
 * docs/MODULE_MAP.md. These assert the structural facts the boundary checks depend on, so a
 * careless edit to the manifest fails the build rather than silently weakening a rule.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_GATEWAY_PATH,
  BUSINESS_MODULES,
  FINANCIAL_ZONE_PREFIXES,
  KERNEL_COMPONENTS,
  MODULE_LAYER_DEPTH,
  isInFinancialZone,
  isProviderPackage,
} from '../platform/architecture/manifest.ts';

test('the manifest carries all 15 kernel components and 48 business modules', () => {
  assert.equal(KERNEL_COMPONENTS.length, 15);
  assert.equal(BUSINESS_MODULES.length, 49);
});

test('identifiers and directory slugs are unique and well formed', () => {
  const kernelIds = KERNEL_COMPONENTS.map((c) => c.id);
  const kernelDirs = KERNEL_COMPONENTS.map((c) => c.dir);
  const moduleIds = BUSINESS_MODULES.map((m) => m.id);
  const moduleDirs = BUSINESS_MODULES.map((m) => m.dir);

  assert.equal(new Set(kernelIds).size, kernelIds.length, 'duplicate kernel id');
  assert.equal(new Set(kernelDirs).size, kernelDirs.length, 'duplicate kernel directory');
  assert.equal(new Set(moduleIds).size, moduleIds.length, 'duplicate module id');
  assert.equal(new Set(moduleDirs).size, moduleDirs.length, 'duplicate module directory');

  for (const dir of [...kernelDirs, ...moduleDirs]) {
    assert.match(dir, /^[a-z0-9]+(-[a-z0-9]+)*$/, `directory slug must be kebab-case: ${dir}`);
  }
  for (const [index, component] of KERNEL_COMPONENTS.entries()) {
    assert.equal(component.id, `K-${String(index + 1).padStart(2, '0')}`);
  }
  for (const [index, mod] of BUSINESS_MODULES.entries()) {
    assert.equal(mod.id, `M-${String(index + 1).padStart(2, '0')}`);
  }
});

test('every module layer is known, and layer depths are distinct and ascending', () => {
  for (const mod of BUSINESS_MODULES) {
    assert.ok(mod.layer in MODULE_LAYER_DEPTH, `${mod.id} has an unknown layer ${mod.layer}`);
  }
  const depths = Object.values(MODULE_LAYER_DEPTH);
  assert.equal(new Set(depths).size, depths.length, 'layer depths must be distinct');
  assert.deepEqual(
    depths,
    [...depths].sort((a, b) => a - b),
    'L1..L8 must ascend',
  );
});

test('the AI Gateway is a registered kernel component', () => {
  assert.equal(AI_GATEWAY_PATH, 'kernel/ai-gateway');
  assert.ok(
    KERNEL_COMPONENTS.some((c) => `kernel/${c.dir}` === AI_GATEWAY_PATH),
    'the provider boundary must exist in the kernel registry',
  );
});

test('every financial-zone prefix names a registered kernel component or module', () => {
  const known = new Set<string>([
    ...KERNEL_COMPONENTS.map((c) => `kernel/${c.dir}`),
    ...BUSINESS_MODULES.map((m) => `modules/${m.dir}`),
  ]);
  for (const prefix of FINANCIAL_ZONE_PREFIXES) {
    const unitRoot = prefix.split('/').slice(0, 2).join('/');
    assert.ok(known.has(unitRoot), `financial zone names an unregistered unit: ${prefix}`);
  }
});

test('the financial zone matches on path boundaries, not on string prefixes', () => {
  assert.equal(isInFinancialZone('modules/orders'), true);
  assert.equal(isInFinancialZone('modules/orders/api/create.ts'), true);
  assert.equal(isInFinancialZone('modules/rewards/ledger/entries.ts'), true);
  assert.equal(isInFinancialZone('modules/rewards/ui/panel.ts'), false);
  assert.equal(isInFinancialZone('modules/orders-archive/index.ts'), false);
  assert.equal(isInFinancialZone('modules/matching/index.ts'), false);
});

test('provider detection covers exact names, subpaths and scopes but not lookalikes', () => {
  assert.equal(isProviderPackage('openai'), true);
  assert.equal(isProviderPackage('openai/resources'), true);
  assert.equal(isProviderPackage('@anthropic-ai/sdk'), true);
  assert.equal(isProviderPackage('@anthropic-ai/some-future-package'), true);
  assert.equal(isProviderPackage('@google/genai'), true);
  assert.equal(isProviderPackage('openai-schema-validator'), false);
  assert.equal(isProviderPackage('node:fs'), false);
  assert.equal(isProviderPackage('typescript'), false);
  assert.equal(isProviderPackage('./local-openai.ts'), false);
});
