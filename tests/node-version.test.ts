/**
 * Tests for the runtime version constraints, and the harness self-test.
 *
 * The last case is the one that earns its keep: it reads the real `engines.node` from
 * package.json and asserts the running Node satisfies it, so the pin cannot drift away from
 * the runtime the toolchain is actually exercised on.
 */

import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import {
  compareVersions,
  parseVersion,
  satisfiesMinimum,
} from '../platform/runtime/node-version.ts';

test('parseVersion reads major, minor and patch', () => {
  assert.deepEqual(parseVersion('22.18.0'), { major: 22, minor: 18, patch: 0 });
  assert.deepEqual(parseVersion('v26.7.0'), { major: 26, minor: 7, patch: 0 });
  assert.deepEqual(parseVersion('  1.2.3  '), { major: 1, minor: 2, patch: 3 });
});

test('parseVersion ignores prerelease and build metadata', () => {
  assert.deepEqual(parseVersion('23.0.0-nightly'), { major: 23, minor: 0, patch: 0 });
  assert.deepEqual(parseVersion('22.18.0+build.5'), { major: 22, minor: 18, patch: 0 });
});

test('parseVersion rejects malformed input rather than guessing', () => {
  for (const bad of ['22.18', '22.18.0.1', '22.x.0', '', 'latest', '-1.0.0']) {
    assert.throws(() => parseVersion(bad), /Invalid version/, `expected "${bad}" to be rejected`);
  }
});

test('compareVersions orders by major, then minor, then patch', () => {
  const v = parseVersion;
  assert.ok(compareVersions(v('22.18.0'), v('23.0.0')) < 0);
  assert.ok(compareVersions(v('23.0.0'), v('22.18.0')) > 0);
  assert.ok(compareVersions(v('22.18.0'), v('22.9.0')) > 0, 'numeric, not lexicographic');
  assert.equal(compareVersions(v('22.18.0'), v('22.18.0')), 0);
  assert.ok(compareVersions(v('22.18.1'), v('22.18.0')) > 0);
});

test('satisfiesMinimum accepts at or above the minimum, and rejects below', () => {
  assert.equal(satisfiesMinimum('22.18.0', '>=22.18.0'), true, 'boundary is inclusive');
  assert.equal(satisfiesMinimum('26.7.0', '>=22.18.0'), true);
  assert.equal(satisfiesMinimum('22.17.9', '>=22.18.0'), false);
  assert.equal(satisfiesMinimum('20.0.0', '>=22.18.0'), false);
  assert.equal(satisfiesMinimum('22.18.0', '>= 22.18.0'), true, 'whitespace tolerated');
});

test('satisfiesMinimum refuses ranges it does not understand', () => {
  for (const bad of ['^22.18.0', '~22.18.0', '22.18.0', '<23.0.0', '>=22.18.0 <23.0.0']) {
    assert.throws(
      () => satisfiesMinimum('22.18.0', bad),
      /Unsupported version range|Invalid version/,
      `expected range "${bad}" to be refused`,
    );
  }
});

test('the running Node satisfies the engines.node range declared in package.json', async () => {
  const manifest = await import('../package.json', { with: { type: 'json' } });
  const range = (manifest.default as { engines: { node: string } }).engines.node;

  assert.equal(range, '>=22.18.0', 'engines.node changed — update this assertion deliberately');
  assert.ok(
    satisfiesMinimum(process.versions.node, range),
    `Node ${process.versions.node} does not satisfy engines.node ${range}`,
  );
});
