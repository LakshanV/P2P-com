/**
 * The event inventory is complete, and stays complete.
 *
 * K-08 and K-09 refuse a type or an action they have not been told about. That refusal is right, and
 * it means the application's inventory is load-bearing in a way nothing points at until somebody
 * runs the relay: a module that adds an event and forgets to register it does not fail at build
 * time, does not fail at request time, and fails at the moment the relay tries to publish it — in
 * production, quietly, as a dead letter.
 *
 * So the check is here instead, and it reads the modules from **disk** rather than from imports. An
 * inventory checked against a list somebody wrote is a list checked against itself.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PLATFORM_AUDIT_ACTIONS,
  PLATFORM_EVENT_TYPES,
  PLATFORM_OUTBOX_SCHEMAS,
} from '../apps/api/platform-events.ts';
import { AuditActionRegistry } from '../kernel/audit-foundation/index.ts';
import { EventTypeRegistry } from '../kernel/event-infrastructure/index.ts';
import { BUSINESS_MODULES } from '../platform/architecture/manifest.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES_DIR = path.join(REPO_ROOT, 'modules');

/** Every `export const NAME_EVENT` / `NAME_ACTION` a module's outbox declares, by module. */
function declaredIn(directory: string, suffix: 'EVENT' | 'ACTION'): readonly string[] {
  const file = path.join(MODULES_DIR, directory, 'outbox.ts');
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    // A module with no outbox declares nothing, which is a legitimate state for one that has not
    // been built yet.
    return [];
  }
  return [...source.matchAll(new RegExp(`^export const ([A-Z_0-9]+_${suffix})\\b`, 'gm'))].map(
    (match) => match[1] ?? '',
  );
}

/** The directories that actually hold an implementation. */
function builtModules(): readonly string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        readFileSync(path.join(MODULES_DIR, name, 'outbox.ts'), 'utf8');
        return true;
      } catch {
        return false;
      }
    });
}

test('every registered type and action is one K-08 and K-09 will actually accept', () => {
  // The check that would have caught M-03 shipping `commerce_request.captured`: K-08's rule is that
  // a type reads as a subject and a fact, and the subject carries no underscore. Nothing enforced it
  // until something tried to publish, which is to say until the first end-to-end journey ran.
  //
  // Constructing the registries is the assertion: both refuse a definition they could never
  // validate, and refusing at build time is the difference between a rename and an outage.
  assert.doesNotThrow(() => new EventTypeRegistry(PLATFORM_EVENT_TYPES));
  assert.doesNotThrow(() => new AuditActionRegistry(PLATFORM_AUDIT_ACTIONS));
});

test('every event a module declares is registered with the platform', () => {
  const registered = new Set(PLATFORM_EVENT_TYPES.map((definition) => definition.type));

  for (const directory of builtModules()) {
    const source = readFileSync(path.join(MODULES_DIR, directory, 'outbox.ts'), 'utf8');
    // The `type:` line of each definition, which is what K-08 actually matches on. Read from the
    // source rather than from the constant name, because the two need not agree and it is the
    // string that has to be registered.
    const types = [...source.matchAll(/^\s*type:\s*'([a-z0-9_.-]+)'/gm)].map((match) => match[1]);

    for (const type of types) {
      assert.ok(
        registered.has(type ?? ''),
        `modules/${directory} publishes "${String(type)}" and apps/api/platform-events.ts does ` +
          'not register it. The relay would dead-letter every one of them, in production, quietly',
      );
    }
  }
});

test('every audit action a module declares is registered with the platform', () => {
  const registered = new Set(PLATFORM_AUDIT_ACTIONS.map((definition) => definition.action));

  for (const directory of builtModules()) {
    const source = readFileSync(path.join(MODULES_DIR, directory, 'outbox.ts'), 'utf8');
    const actions = [...source.matchAll(/^\s*action:\s*'([a-z0-9_.-]+)'/gm)].map(
      (match) => match[1],
    );

    for (const action of actions) {
      assert.ok(
        registered.has(action ?? ''),
        `modules/${directory} records "${String(action)}" and apps/api/platform-events.ts does ` +
          'not register it',
      );
    }
  }
});

test('the inventory names no event or action that does not exist', () => {
  // The other direction. An entry for a type nobody publishes is not dangerous, but it is a claim
  // about the platform that has stopped being true, and this file is read as documentation.
  const declaredEvents = new Set(
    builtModules().flatMap((directory) => {
      const source = readFileSync(path.join(MODULES_DIR, directory, 'outbox.ts'), 'utf8');
      return [...source.matchAll(/^\s*type:\s*'([a-z0-9_.-]+)'/gm)].map((match) => match[1] ?? '');
    }),
  );

  for (const definition of PLATFORM_EVENT_TYPES) {
    assert.ok(
      declaredEvents.has(definition.type),
      `the inventory registers "${definition.type}" and no module publishes it`,
    );
  }
});

test('every outbox schema the relay polls belongs to a registered module', () => {
  // A schema name that does not match a manifest directory is a relay polling a table that does not
  // exist, which `runOutboxRelay` reports as a source failure rather than as nothing to do.
  const owned = new Set(
    BUSINESS_MODULES.map((entry) => `module_${entry.dir.replaceAll('-', '_')}`),
  );

  for (const schema of PLATFORM_OUTBOX_SCHEMAS) {
    assert.ok(owned.has(schema), `${schema} is not a schema any manifest module owns`);
  }
});

test('every module with an outbox table has its schema polled', () => {
  // The direction that loses events. A module whose outbox nobody polls writes rows that are never
  // published, and reports nothing wrong: its own transaction committed.
  const polled = new Set(PLATFORM_OUTBOX_SCHEMAS);

  for (const directory of builtModules()) {
    const schema = `module_${directory.replaceAll('-', '_')}`;
    const events = declaredIn(directory, 'EVENT');
    const actions = declaredIn(directory, 'ACTION');
    if (events.length === 0 && actions.length === 0) continue;

    assert.ok(
      polled.has(schema),
      `modules/${directory} writes to ${schema}.outbox and the relay does not poll it. Its events ` +
        'would sit unpublished for ever, and nothing would report a problem',
    );
  }
});
