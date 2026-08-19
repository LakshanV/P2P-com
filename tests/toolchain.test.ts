/**
 * The reproducibility contract.
 *
 * Two different claims live in package.json and .nvmrc, and they are easy to conflate:
 *
 *   - the **supported range** — `engines.node`, `engines.npm` — what the project will run on;
 *   - the **pinned development toolchain** — `.nvmrc`, `packageManager` — the exact Node and
 *     npm the project is actually developed and verified against.
 *
 * A pin outside its own supported range is a contradiction the repository would otherwise
 * carry silently, so these tests bind the two together. They read the real files rather than
 * restating their contents, which is what makes them catch drift instead of documenting it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseVersion, satisfiesMinimum } from '../platform/runtime/node-version.ts';
import { parsePackageManager } from '../platform/runtime/package-manager.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readNvmrc = (): string => fs.readFileSync(path.join(REPO_ROOT, '.nvmrc'), 'utf8').trim();

const readManifest = async (): Promise<{
  engines: { node: string; npm: string };
  packageManager: string;
}> => {
  const loaded = await import('../package.json', { with: { type: 'json' } });
  return loaded.default;
};

// --------------------------------------------------------------- parsePackageManager

test('parsePackageManager reads an exact name@version pin', () => {
  assert.deepEqual(parsePackageManager('npm@11.19.0'), { name: 'npm', version: '11.19.0' });
  assert.deepEqual(parsePackageManager('  pnpm@9.0.6  '), { name: 'pnpm', version: '9.0.6' });
});

test('parsePackageManager tolerates the Corepack integrity suffix', () => {
  assert.deepEqual(parsePackageManager('npm@11.19.0+sha512.abc123_-def'), {
    name: 'npm',
    version: '11.19.0',
  });
});

test('parsePackageManager rejects ranges and partial versions — a pin must be exact', () => {
  for (const bad of [
    'npm@^11.19.0',
    'npm@~11.19.0',
    'npm@>=11.19.0',
    'npm@11.19',
    'npm@11.x',
    'npm@*',
    'npm@latest',
    'npm',
    '11.19.0',
    '',
  ]) {
    assert.throws(
      () => parsePackageManager(bad),
      /Invalid packageManager/,
      `expected "${bad}" to be rejected`,
    );
  }
});

// --------------------------------------------------------------- pinned vs supported

test('.nvmrc pins an exact Node version, not a range or an alias', () => {
  const pinned = readNvmrc();
  assert.match(pinned, /^\d+\.\d+\.\d+$/, `.nvmrc must be an exact version, found "${pinned}"`);
  assert.doesNotThrow(() => parseVersion(pinned));
});

test('the exact .nvmrc runtime satisfies engines.node', async () => {
  const { engines } = await readManifest();
  const pinned = readNvmrc();
  assert.ok(
    satisfiesMinimum(pinned, engines.node),
    `.nvmrc pins Node ${pinned}, which does not satisfy engines.node ${engines.node} — ` +
      'the pinned development runtime must lie inside the supported range',
  );
});

test('packageManager pins an exact npm version that satisfies engines.npm', async () => {
  const { engines, packageManager } = await readManifest();
  const pin = parsePackageManager(packageManager);

  assert.equal(pin.name, 'npm', `packageManager must pin npm, found "${pin.name}"`);
  assert.ok(
    satisfiesMinimum(pin.version, engines.npm),
    `packageManager pins npm ${pin.version}, which does not satisfy engines.npm ${engines.npm}`,
  );
});

test('the supported ranges stay open while the pins stay exact', async () => {
  const { engines, packageManager } = await readManifest();

  // Ranges are minimums, deliberately: the project supports newer toolchains than it pins.
  assert.match(engines.node, /^>=/, 'engines.node must remain a minimum range');
  assert.match(engines.npm, /^>=/, 'engines.npm must remain a minimum range');

  // Pins are exact, deliberately: they name what CI and development actually use.
  assert.match(readNvmrc(), /^\d+\.\d+\.\d+$/);
  assert.match(packageManager, /^npm@\d+\.\d+\.\d+/);
});

// --------------------------------------------------------------- pin vs reality

test('the npm actually running the scripts matches the packageManager pin', async () => {
  const agent = process.env['npm_config_user_agent'];
  if (agent === undefined) {
    // Invoked directly via `node --test` rather than through an npm script: there is no npm
    // in the picture to compare against, so there is nothing to assert.
    return;
  }

  const found = /(?:^|\s)npm\/(\d+\.\d+\.\d+)/.exec(agent);
  assert.ok(found, `could not read an npm version from npm_config_user_agent "${agent}"`);

  const running = found[1];
  const { packageManager } = await readManifest();
  const pin = parsePackageManager(packageManager);

  assert.equal(
    running,
    pin.version,
    `npm ${running} is running the scripts but packageManager pins npm ${pin.version} — ` +
      'update the pin to the npm actually in use, or switch to the pinned npm',
  );
});
