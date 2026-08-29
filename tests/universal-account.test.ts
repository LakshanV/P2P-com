/**
 * M-01 Universal Account — service behaviour.
 *
 * The first business module, so these cases carry a little more weight than usual: they are the
 * evidence that the kernel's disciplines — caller-supplied identifiers and instants, refusal by
 * name, sealed records, one transaction per fact — survive the move out of `kernel/` and into a
 * module that owns business meaning.
 *
 * Everything here runs against the in-memory reference repository. The live-PostgreSQL properties —
 * the append-only trigger, the `UNIQUE (account_id, capability)` constraint, the status/timestamp
 * CHECK — are in `tests/integration/universal-account.integration.ts`, because a constraint that has
 * never refused anything is not evidence of anything.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CAPABILITIES,
  CAPABILITY_STATUSES,
  FOREIGN_FIELDS,
  UniversalAccountError,
} from '../modules/universal-account/index.ts';

import {
  ACCOUNT,
  activateRequest,
  build,
  deactivateRequest,
  entriesOfKind,
} from './helpers/universal-account-fixtures.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_DIR = path.join(REPO_ROOT, 'modules', 'universal-account');

/** The refusal code, or the whole error when it is not one of M-01's. */
const codeOf = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (error instanceof UniversalAccountError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal, and the call succeeded');
};

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

test('activating a capability writes the row, the transition and both outbox entries', async () => {
  const { service, repository } = build();
  const request = activateRequest({ capability: 'seller' });

  const result = await service.activateCapability(request);

  assert.equal(result.replayed, false);
  assert.equal(result.capability.capabilityId, request.capabilityId);
  assert.equal(result.capability.accountId, ACCOUNT);
  assert.equal(result.capability.capability, 'seller');
  assert.equal(result.capability.status, 'active');
  assert.equal(result.capability.deactivatedAt, null);

  // The transition that created it comes from nowhere, which is what fromStatus: null means.
  assert.notEqual(result.state, null);
  assert.equal(result.state?.fromStatus, null);
  assert.equal(result.state?.toStatus, 'active');
  assert.equal(result.state?.reason, request.reason);

  assert.equal(repository.capabilities().length, 1);
  assert.equal(repository.states().length, 1);
  assert.equal(repository.transactionsCommitted, 1);

  // One event and one audit record, and the event carries the fact rather than a reference to it.
  const events = entriesOfKind(repository, 'event');
  const audits = entriesOfKind(repository, 'audit');
  assert.equal(events.length, 1);
  assert.equal(audits.length, 1);

  const envelope = events[0]?.payload as { type: string; payload: Record<string, unknown> };
  assert.equal(envelope.type, 'capability.activated');
  assert.deepEqual(envelope.payload, {
    capability_id: request.capabilityId,
    account_id: ACCOUNT,
    capability: 'seller',
    status: 'active',
    activated_at: request.activatedAt,
    idempotency_key: request.idempotencyKey,
  });
});

test('every capability in the vocabulary can be activated for one account', async () => {
  const { service, repository } = build();

  for (const capability of CAPABILITIES) {
    await service.activateCapability(activateRequest({ capability }));
  }

  const held = await service.listCapabilities(ACCOUNT);
  assert.equal(held.length, CAPABILITIES.length);
  assert.deepEqual(
    held.map((capability) => capability.capability),
    [...CAPABILITIES].sort(),
    'listCapabilities orders by capability, so a caller can diff two accounts without sorting',
  );
  assert.equal(repository.states().length, CAPABILITIES.length);
});

test('a replay with the same key and the same content changes nothing', async () => {
  const { service, repository } = build();
  const request = activateRequest();

  const first = await service.activateCapability(request);
  const second = await service.activateCapability(request);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.capability, first.capability);
  assert.equal(repository.capabilities().length, 1);
  assert.equal(repository.states().length, 1);
  assert.equal(
    entriesOfKind(repository, 'event').length,
    1,
    'a replay that emitted a second event would make one activation look like two',
  );
});

test('a replay with the same key and different content is refused', async () => {
  const { service } = build();
  const request = activateRequest({ capability: 'seller' });
  await service.activateCapability(request);

  const code = await codeOf(() =>
    service.activateCapability({
      ...request,
      capabilityId: 'cap_01HQZUX9999',
      capability: 'driver',
    }),
  );
  assert.equal(code, 'idempotency-key-reuse');
});

test('an account may hold one active capability of a role, not two', async () => {
  const { service, repository } = build();
  await service.activateCapability(activateRequest({ capability: 'host' }));

  const code = await codeOf(() =>
    service.activateCapability(
      activateRequest({ capability: 'host', capabilityId: 'cap_01HQZUY0002' }),
    ),
  );
  assert.equal(code, 'capability-already-active');
  assert.equal(repository.capabilities().length, 1);
});

test('two accounts may each hold the same role', async () => {
  const { service } = build();
  await service.activateCapability(activateRequest({ capability: 'driver' }));
  await service.activateCapability(
    activateRequest({ capability: 'driver', accountId: 'acct_01HQZUB0002' }),
  );

  assert.equal((await service.listCapabilities(ACCOUNT)).length, 1);
  assert.equal((await service.listCapabilities('acct_01HQZUB0002')).length, 1);
});

// ---------------------------------------------------------------------------
// Deactivation and reactivation
// ---------------------------------------------------------------------------

test('deactivating sets the status, the instant and the transition, and emits', async () => {
  const { service, repository } = build();
  const activated = await service.activateCapability(activateRequest({ capability: 'provider' }));
  const request = deactivateRequest(activated.capability.capabilityId);

  const result = await service.deactivateCapability(request);

  assert.equal(result.replayed, false);
  assert.equal(result.capability.status, 'deactivated');
  assert.equal(result.capability.deactivatedAt, request.deactivatedAt);
  assert.equal(result.state?.fromStatus, 'active');
  assert.equal(result.state?.toStatus, 'deactivated');

  const events = entriesOfKind(repository, 'event');
  assert.equal(events.length, 2);
  const envelope = events[1]?.payload as { type: string; payload: Record<string, unknown> };
  assert.equal(envelope.type, 'capability.deactivated');
  assert.deepEqual(envelope.payload, {
    capability_id: activated.capability.capabilityId,
    account_id: ACCOUNT,
    capability: 'provider',
    deactivated_at: request.deactivatedAt,
    reason: request.reason,
    idempotency_key: request.idempotencyKey,
  });
});

test('deactivating an unknown capability, and one already deactivated, are different refusals', async () => {
  const { service } = build();
  assert.equal(
    await codeOf(() => service.deactivateCapability(deactivateRequest('cap_01HQZUZ0001'))),
    'capability-not-found',
  );

  const activated = await service.activateCapability(activateRequest());
  await service.deactivateCapability(deactivateRequest(activated.capability.capabilityId));

  assert.equal(
    await codeOf(() =>
      service.deactivateCapability(deactivateRequest(activated.capability.capabilityId)),
    ),
    'capability-not-active',
  );
});

test('reactivation keeps the capability id and appends a third transition', async () => {
  const { service, repository } = build();
  const first = await service.activateCapability(activateRequest({ capability: 'introducer' }));
  const capabilityId = first.capability.capabilityId;

  await service.deactivateCapability(deactivateRequest(capabilityId));

  const again = await service.activateCapability(
    activateRequest({
      capabilityId,
      capability: 'introducer',
      activatedAt: '2026-04-03T09:00:00Z',
      updatedAt: '2026-04-03T09:00:00Z',
      reason: 'the seller reopened their storefront',
    }),
  );

  assert.equal(again.capability.capabilityId, capabilityId, 'a stored handle stays valid');
  assert.equal(again.capability.status, 'active');
  assert.equal(again.capability.deactivatedAt, null);
  assert.equal(again.replayed, false);

  const history = await service.getCapabilityHistory(capabilityId);
  assert.deepEqual(
    history.map((state) => [state.fromStatus, state.toStatus]),
    [
      [null, 'active'],
      ['active', 'deactivated'],
      ['deactivated', 'active'],
    ],
    'the history is the whole life of the capability, oldest first',
  );

  // Three facts happened, so three events exist. Two of them are activations of the same
  // capability — the case an outbox id derived from the capability id alone cannot express, and
  // the one that made the first draft of this module collide with itself on `outbox_pkey`. The
  // ids are derived from the transition instead, so this is the regression that keeps them so.
  const events = entriesOfKind(repository, 'event');
  assert.equal(events.length, 3);
  const ids = repository
    .outbox()
    .entries()
    .map((entry) => entry.outboxId);
  assert.equal(
    new Set(ids).size,
    ids.length,
    'two outbox entries share an id, so the second would be refused by outbox_pkey in PostgreSQL',
  );
});

test('reactivating an already-active capability is a replay, not a second activation', async () => {
  const { service, repository } = build();
  const request = activateRequest({ capability: 'buyer' });
  await service.activateCapability(request);

  const again = await service.activateCapability({
    ...request,
    idempotencyKey: 'idem_act_repeat',
    stateId: 'state_01HQZV00001',
  });

  assert.equal(again.replayed, true);
  assert.equal(again.state, null);
  assert.equal(repository.states().length, 1);
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test('listCapabilities returns only that account, and getCapabilityHistory only that capability', async () => {
  const { service } = build();
  const mine = await service.activateCapability(activateRequest({ capability: 'seller' }));
  await service.activateCapability(
    activateRequest({ capability: 'seller', accountId: 'acct_01HQZUB0003' }),
  );

  const held = await service.listCapabilities(ACCOUNT);
  assert.equal(held.length, 1);
  assert.equal(held[0]?.capabilityId, mine.capability.capabilityId);

  const history = await service.getCapabilityHistory(mine.capability.capabilityId);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.capabilityId, mine.capability.capabilityId);
});

test('an unknown account and an unknown capability read as empty, not as a refusal', async () => {
  const { service } = build();
  assert.deepEqual(await service.listCapabilities('acct_01HQZUB0404'), []);
  assert.deepEqual(await service.getCapabilityHistory('cap_01HQZUB0404'), []);
});

test('returned records are sealed', async () => {
  const { service } = build();
  const result = await service.activateCapability(activateRequest());

  assert.throws(() => {
    (result.capability as { status: string }).status = 'deactivated';
  }, TypeError);
  assert.throws(() => {
    (result.state as unknown as { reason: string }).reason = 'rewritten';
  }, TypeError);
});

// ---------------------------------------------------------------------------
// Refusal by name
// ---------------------------------------------------------------------------

test('every field belonging to another unit is refused, by name, with its owner', async () => {
  const { service } = build();

  for (const [field, owner] of Object.entries(FOREIGN_FIELDS)) {
    // `deactivatedAt` is M-01's own field on a deactivation request; it is foreign only on
    // activation, which is the operation tested here.
    const request = { ...activateRequest(), [field]: 'anything' };
    const code = await codeOf(() =>
      service.activateCapability(request as ReturnType<typeof activateRequest>),
    );
    assert.equal(code, 'foreign-concern', `${field} was not refused as a foreign concern`);
    assert.match(
      owner,
      /K-\d\d|M-\d\d|profile core/,
      `FOREIGN_FIELDS["${field}"] must name the unit that owns it, and says "${owner}"`,
    );
  }
});

test('an unknown field is refused rather than ignored', async () => {
  const { service } = build();
  const code = await codeOf(() =>
    service.activateCapability({
      ...activateRequest(),
      wingspan: 3,
    } as ReturnType<typeof activateRequest>),
  );
  assert.notEqual(code, undefined);
  assert.match(code, /foreign-concern|malformed-record/);
});

test('identifiers that are natural keys, credentials or malformed are each refused', async () => {
  const { service } = build();

  const cases: readonly (readonly [string, Partial<ReturnType<typeof activateRequest>>])[] = [
    ['natural-identifier', { accountId: 'someone@example.com' }],
    ['natural-identifier', { accountId: '94771234567890' }],
    ['secret-bearing-input', { accountId: 'api_key_9f2b7c1d4e' }],
    ['malformed-identifier', { capabilityId: 'short' }],
    ['malformed-identifier', { correlationId: '' }],
  ];

  for (const [expected, overrides] of cases) {
    assert.equal(
      await codeOf(() => service.activateCapability(activateRequest(overrides))),
      expected,
      `${JSON.stringify(overrides)} should be refused with ${expected}`,
    );
  }
});

test('a malformed instant is refused', async () => {
  const { service } = build();
  assert.equal(
    await codeOf(() => service.activateCapability(activateRequest({ activatedAt: 'yesterday' }))),
    'malformed-instant',
  );
  assert.equal(
    await codeOf(() =>
      service.activateCapability(activateRequest({ activatedAt: '2026-04-01 12:00:00' })),
    ),
    'malformed-instant',
    'a canonical UTC instant is not a space-separated local timestamp',
  );
});

test('a capability outside the vocabulary is refused, and so is a status', async () => {
  const { service } = build();
  assert.equal(
    await codeOf(() => service.activateCapability(activateRequest({ capability: 'landlord' }))),
    'unknown-capability',
  );
  assert.deepEqual(
    [...CAPABILITY_STATUSES],
    ['active', 'suspended', 'deactivated'],
    'the status vocabulary is closed, and the migration CHECK lists exactly these three',
  );
});

test('a reason that is empty, blank or too long is refused', async () => {
  const { service } = build();
  for (const reason of ['', '   ', 'x'.repeat(501)]) {
    assert.equal(
      await codeOf(() => service.activateCapability(activateRequest({ reason }))),
      'malformed-reason',
      `reason of length ${reason.length} should be refused`,
    );
  }
  // 500 is inside the bound the migration declares.
  await build().service.activateCapability(activateRequest({ reason: 'x'.repeat(500) }));
});

// ---------------------------------------------------------------------------
// Atomicity and determinism
// ---------------------------------------------------------------------------

test('a refused activation leaves no row, no transition and no outbox entry', async () => {
  const { service, repository } = build();

  await assert.rejects(() => service.activateCapability(activateRequest({ reason: '' })));

  assert.deepEqual(repository.capabilities(), []);
  assert.deepEqual(repository.states(), []);
  assert.deepEqual(repository.outbox().entries(), []);
});

test('a refusal inside the transaction rolls back the whole fact', async () => {
  const { service, repository } = build();
  await service.activateCapability(activateRequest({ capability: 'seller' }));
  const before = repository.outbox().entries().length;

  await assert.rejects(() =>
    service.activateCapability(
      activateRequest({ capability: 'seller', capabilityId: 'cap_01HQZV10002' }),
    ),
  );

  assert.equal(repository.capabilities().length, 1);
  assert.equal(repository.states().length, 1);
  assert.equal(repository.outbox().entries().length, before);
  assert.equal(repository.transactionsRolledBack, 1);
});

test('the module reads no clock and generates no randomness', () => {
  const offenders: string[] = [];
  for (const file of readdirSync(MODULE_DIR).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
    if (/\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bcrypto\.randomUUID\b/.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the caller supplies every identifier and every instant; a clock read here would make a ' +
      'replayed request produce a different record',
  );
});
