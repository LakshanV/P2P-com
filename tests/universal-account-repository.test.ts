/**
 * M-01 Universal Account — the persistence port's reference implementation.
 *
 * The in-memory repository is not a stub. It is the specification of what the PostgreSQL adapter
 * must do, written in a form the suite can drive without a database: uniqueness checked **at commit
 * against the store as it stands**, not against the snapshot the transaction opened with, and a
 * failed transaction leaving nothing at all — no capability, no transition, no outbox entry.
 *
 * The properties here are the ones that only show up under interleaving. A repository that checks
 * uniqueness when it reads, and writes when it is told, passes every single-caller test and still
 * lets two callers both create the same capability.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryUniversalAccountRepository,
  UniversalAccountError,
} from '../modules/universal-account/index.ts';

import {
  ACCOUNT,
  capabilityRecord,
  stateRecord,
} from './helpers/universal-account-fixtures.ts';

/** The refusal code, or a rethrow when it is not one of M-01's. */
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
// Reads
// ---------------------------------------------------------------------------

test('a committed capability is found by id, by idempotency key and by account', async () => {
  const repository = new InMemoryUniversalAccountRepository();
  const capability = capabilityRecord({ capability: 'seller' });

  await repository.withTransaction(async (tx) => {
    await tx.insertCapability(capability);
  });

  await repository.withTransaction(async (tx) => {
    assert.deepEqual(await tx.findCapabilityById(capability.capabilityId), capability);
    assert.deepEqual(
      await tx.findCapabilityByIdempotencyKey(capability.idempotencyKey),
      capability,
    );
    assert.deepEqual(await tx.findCapabilitiesByAccountId(ACCOUNT), [capability]);

    assert.equal(await tx.findCapabilityById('cap_01HQZW00404'), null);
    assert.equal(await tx.findCapabilityByIdempotencyKey('idem_absent_0001'), null);
    assert.deepEqual(await tx.findCapabilitiesByAccountId('acct_01HQZW00404'), []);
  });
});

test('a committed transition is found by id, by idempotency key and by capability', async () => {
  const repository = new InMemoryUniversalAccountRepository();
  const state = stateRecord();

  await repository.withTransaction(async (tx) => {
    await tx.insertState(state);
  });

  await repository.withTransaction(async (tx) => {
    assert.deepEqual(await tx.findStateById(state.stateId), state);
    assert.deepEqual(await tx.findStateByIdempotencyKey(state.idempotencyKey), state);
    assert.deepEqual(await tx.findStatesByCapabilityId(state.capabilityId), [state]);
    assert.equal(await tx.findStateById('state_01HQZW00404'), null);
  });
});

test('reads inside a transaction see that transaction’s own uncommitted writes', async () => {
  const repository = new InMemoryUniversalAccountRepository();
  const capability = capabilityRecord();

  await repository.withTransaction(async (tx) => {
    assert.equal(await tx.findCapabilityById(capability.capabilityId), null);
    await tx.insertCapability(capability);
    assert.deepEqual(
      await tx.findCapabilityById(capability.capabilityId),
      capability,
      'a transaction that cannot read its own write forces the service to track state itself',
    );
  });
});

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

test('a failed transaction leaves no capability, no transition and no outbox entry', async () => {
  const repository = new InMemoryUniversalAccountRepository();
  const capability = capabilityRecord();

  await assert.rejects(
    repository.withTransaction(async (tx) => {
      await tx.insertCapability(capability);
      await tx.insertState(stateRecord({ capabilityId: capability.capabilityId }));
      await tx.insertOutbox({
        outboxId: 'M-01:rolled-back',
        idempotencyKey: 'M-01:rolled-back',
        kind: 'event',
        payload: {},
        recordedAt: '2026-04-01T12:00:00Z',
        producer: 'M-01',
        correlationId: 'corr_01HQZW00001',
        causationId: null,
        processedAt: null,
        retryCount: 0,
        lastError: null,
      });
      throw new Error('the caller changed its mind');
    }),
    /changed its mind/,
  );

  assert.deepEqual(repository.capabilities(), []);
  assert.deepEqual(repository.states(), []);
  assert.deepEqual(repository.outbox().entries(), []);
  assert.equal(repository.transactionsRolledBack, 1);
  assert.equal(repository.transactionsCommitted, 0);
});

// ---------------------------------------------------------------------------
// Conflict detection at commit, not at read
// ---------------------------------------------------------------------------

test('two transactions that both read "no such capability" do not both win', async () => {
  const repository = new InMemoryUniversalAccountRepository();
  const capability = capabilityRecord({ capabilityId: 'cap_01HQZW10001' });

  const code = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      // Slow caller: reads first, and finds nothing.
      assert.equal(await tx.findCapabilityById(capability.capabilityId), null);

      // Fast caller commits the same id while the slow one is still open.
      await repository.withTransaction(async (other) => {
        await other.insertCapability(capability);
      });

      // Slow caller now writes what it decided on stale information.
      await tx.insertCapability(capability);
    }),
  );

  assert.equal(code, 'duplicate-capability-id');
  assert.equal(repository.capabilities().length, 1, 'the fast caller’s row is the only one');
});

test('an idempotency key taken by another transaction is refused at commit', async () => {
  const repository = new InMemoryUniversalAccountRepository();
  const key = 'idem_contested_0001';

  const code = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findCapabilityByIdempotencyKey(key), null);

      await repository.withTransaction(async (other) => {
        await other.insertCapability(
          capabilityRecord({ capabilityId: 'cap_01HQZW20001', idempotencyKey: key }),
        );
      });

      await tx.insertCapability(
        capabilityRecord({ capabilityId: 'cap_01HQZW20002', idempotencyKey: key }),
      );
    }),
  );

  assert.equal(code, 'idempotency-key-reuse');
  assert.equal(repository.capabilities().length, 1);
});

test('a transition id taken by another transaction is refused at commit', async () => {
  const repository = new InMemoryUniversalAccountRepository();
  const stateId = 'state_01HQZW30001';

  const code = await codeOf(() =>
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findStateById(stateId), null);

      await repository.withTransaction(async (other) => {
        await other.insertState(stateRecord({ stateId }));
      });

      await tx.insertState(stateRecord({ stateId }));
    }),
  );

  assert.equal(code, 'duplicate-state-id');
  assert.equal(repository.states().length, 1);
});

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

test('updateCapability replaces the row rather than appending a second one', async () => {
  const repository = new InMemoryUniversalAccountRepository();
  const capability = capabilityRecord({ capability: 'driver' });

  await repository.withTransaction(async (tx) => {
    await tx.insertCapability(capability);
  });

  await repository.withTransaction(async (tx) => {
    await tx.updateCapability({
      ...capability,
      status: 'deactivated',
      deactivatedAt: '2026-04-02T12:00:00Z',
      updatedAt: '2026-04-02T12:00:00Z',
    });
  });

  const held = repository.capabilities();
  assert.equal(held.length, 1);
  assert.equal(held[0]?.status, 'deactivated');
  assert.equal(held[0]?.deactivatedAt, '2026-04-02T12:00:00Z');
});

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

test('records handed out by the repository are sealed and severed from the store', async () => {
  const repository = new InMemoryUniversalAccountRepository();
  const capability = capabilityRecord();

  await repository.withTransaction(async (tx) => {
    await tx.insertCapability(capability);
  });

  const held = repository.capabilities();
  assert.throws(() => {
    (held[0] as unknown as { status: string }).status = 'suspended';
  }, TypeError);

  await repository.withTransaction(async (tx) => {
    const found = await tx.findCapabilityById(capability.capabilityId);
    assert.notEqual(found, null);
    assert.throws(() => {
      (found as unknown as { status: string }).status = 'suspended';
    }, TypeError);
  });
});

test('seed accepts a starting point without going through a transaction', () => {
  const repository = new InMemoryUniversalAccountRepository();
  const capability = capabilityRecord();
  const state = stateRecord({ capabilityId: capability.capabilityId });

  repository.seed({ capabilities: [capability], states: [state] });

  assert.deepEqual(repository.capabilities(), [capability]);
  assert.deepEqual(repository.states(), [state]);
  assert.equal(
    repository.transactionsCommitted,
    0,
    'seeding is not a transaction, and must not be counted as one',
  );
});
