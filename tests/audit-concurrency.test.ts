/**
 * K-09 Audit Foundation — concurrency, immutability and query determinism (FND-003c).
 *
 * The cases here are the ones that decide whether an audit trail can be relied on:
 *
 *   - two recorders retrying the same action at the same moment must produce **one** record, and
 *     neither of them should be told it failed — a caller retrying after a timeout has done nothing
 *     wrong;
 *   - the same key used for genuinely different content must fail closed, because returning the
 *     earlier record would attest to something that was never recorded;
 *   - a record already written must be unreachable by anything that could change it;
 *   - equal instants must not make a paginated read skip or repeat a row, which is the failure that
 *     turns "the log has 400 records" into "the log showed me 397 of them".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AuditError, InMemoryAuditRepository } from '../kernel/audit-foundation/index.ts';
import type { AuditCursor, AuditRecord } from '../kernel/audit-foundation/index.ts';

import { OPERATOR, build, recordRequest } from './helpers/audit-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AuditError ? error.code : undefined;

const reasons = (results: PromiseSettledResult<unknown>[]): unknown[] =>
  results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result): unknown => result.reason);

// ---------------------------------------------------------------------------
// Concurrent recording
// ---------------------------------------------------------------------------

test('two concurrent identical retries both return the original record', async () => {
  const { service, repository } = build();
  const request = recordRequest({ recordId: 'aud-1', idempotencyKey: 'idem-1' });

  const [a, b] = await Promise.all([
    service.record({ ...request }),
    service.record({ ...request }),
  ]);

  // Neither caller failed: the recording they were both retrying succeeded, and each is told so.
  assert.equal(a.record.recordId, 'aud-1');
  assert.equal(b.record.recordId, 'aud-1');
  assert.equal(a.record.contentFingerprint, b.record.contentFingerprint);
  assert.ok(a.deduplicated || b.deduplicated, 'one converged on the other');
  assert.equal(repository.records().length, 1, 'one action, one record');
});

test('three concurrent identical retries still produce exactly one record', async () => {
  const { service, repository } = build();
  const request = recordRequest({ recordId: 'aud-1', idempotencyKey: 'idem-1' });

  const results = await Promise.all([
    service.record({ ...request }),
    service.record({ ...request }),
    service.record({ ...request }),
  ]);

  assert.equal(new Set(results.map((result) => result.record.recordId)).size, 1);
  assert.equal(
    results.filter((result) => !result.deduplicated).length,
    1,
    'exactly one did the work',
  );
  assert.equal(repository.records().length, 1);
});

test('concurrent reuse of one key for different content still fails closed', async () => {
  const { service, repository } = build();
  const base = recordRequest({ recordId: 'aud-1', idempotencyKey: 'idem-1' });

  const outcomes = await Promise.allSettled([
    service.record({ ...base }),
    // Same key, different record. Convergence must not answer this with somebody else's record:
    // that would attest to an action that was never recorded.
    service.record({ ...base, recordId: 'aud-2', outcome: 'denied', reason: 'refused by policy' }),
  ]);

  const failures = reasons(outcomes);
  assert.equal(failures.length, 1, 'one succeeded, one was refused');
  assert.equal(codeOf(failures[0]), 'idempotency-key-reuse');
  assert.equal(repository.records().length, 1);
});

test('two concurrent recordings under one record id: one wins, one is refused', async () => {
  const repository = new InMemoryAuditRepository();

  const write = (idempotencyKey: string): Promise<void> =>
    repository.withTransaction(async (tx) => {
      assert.equal(await tx.findRecordById('aud-1'), null, 'both see an empty store');
      await tx.insertRecord({
        recordId: 'aud-1',
        action: 'configuration.version_published',
        recordedAt: '2026-04-01T12:00:00Z',
        actor: { kind: 'system', id: 'K-05', authentication: 'unauthenticated', sessionId: null },
        resource: { owner: 'K-05', type: 'configuration_version', id: 'ver-1' },
        outcome: 'succeeded',
        reason: 'published',
        correlationId: 'corr-1',
        causationId: null,
        evidence: {},
        contentFingerprint: 'a'.repeat(64),
        idempotencyKey,
      });
    });

  const outcomes = await Promise.allSettled([write('idem-a'), write('idem-b')]);

  assert.equal(reasons(outcomes).length, 1, 'a record id identifies one record');
  assert.equal(codeOf(reasons(outcomes)[0]), 'duplicate-record-id');
  assert.equal(repository.records().length, 1);
  assert.equal(repository.transactionsRolledBack, 1);
});

test('a losing recorder writes nothing at all, not merely nothing conflicting', async () => {
  const { service, repository } = build();
  const base = recordRequest({ recordId: 'aud-1', idempotencyKey: 'idem-1' });

  await Promise.allSettled([
    service.record({ ...base }),
    service.record({ ...base, recordId: 'aud-2', reason: 'a different reason entirely' }),
  ]);

  assert.equal(repository.records().length, 1);
  assert.equal(
    repository.records()[0]?.recordId,
    'aud-1',
    'the winner is the one that got there first, and the loser left nothing behind',
  );
});

// ---------------------------------------------------------------------------
// Immutability
// ---------------------------------------------------------------------------

test('a recorded record cannot be changed through anything the service returns', async () => {
  const { service, repository } = build();
  const result = await service.record(recordRequest({ recordId: 'aud-1', idempotencyKey: 'k-1' }));

  // The evidence handed back is frozen, so a caller cannot edit the object it was given and
  // believe it changed the log.
  assert.throws(() => {
    (result.record.evidence as Record<string, unknown>).config_key = 'tampered';
  }, TypeError);

  // And the store returns copies, so mutating a read cannot reach into it either.
  const read = repository.records()[0] as AuditRecord;
  (read as unknown as Record<string, unknown>).reason = 'tampered';
  assert.equal(repository.records()[0]?.reason, 'published by the configuration service');
});

test('the stored record is unchanged by any number of retries', async () => {
  const { service, repository } = build();
  const request = recordRequest({ recordId: 'aud-1', idempotencyKey: 'k-1' });
  const first = await service.record(request);
  const before = structuredClone(repository.records()[0]);

  for (let i = 0; i < 5; i += 1) await service.record({ ...request });

  assert.deepEqual(repository.records()[0], before, 'byte for byte');
  assert.equal(repository.records().length, 1);
  assert.equal(repository.records()[0]?.contentFingerprint, first.record.contentFingerprint);
});

test('the service exposes no operation that could change or remove a record', () => {
  const { service } = build();
  const operations = new Set<string>();

  let proto: object | null = Object.getPrototypeOf(service) as object | null;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  const mutators = [...operations].filter((operation) =>
    /update|delete|remove|amend|redact|purge|expire|revise|correct/i.test(operation),
  );
  assert.deepEqual(mutators, [], 'an audit trail that can be amended is not evidence');
  assert.deepEqual([...operations].filter((name) => name !== 'constructor').sort(), [
    'query',
    'queryAll',
    'record',
    'recordById',
  ]);
});

// ---------------------------------------------------------------------------
// Query determinism and pagination
// ---------------------------------------------------------------------------

async function seedRecords(
  count: number,
  at: (index: number) => string,
): Promise<ReturnType<typeof build>> {
  const harness = build();
  for (let index = 0; index < count; index += 1) {
    await harness.service.record(
      recordRequest({
        recordId: `aud-${String(index).padStart(3, '0')}`,
        idempotencyKey: `k-${index}`,
        correlationId: 'corr-shared',
        recordedAt: at(index),
      }),
    );
  }
  return harness;
}

test('a page walk over records sharing one instant returns each exactly once', async () => {
  // The failure this prevents: with equal instants and an order on time alone, a cursor cannot say
  // where it got to, and a walk silently drops or repeats rows.
  const { service } = await seedRecords(7, () => '2026-04-01T12:00:00Z');

  const seen: string[] = [];
  let after: AuditCursor | undefined;
  let pages = 0;

  do {
    const page = await service.query({ limit: 2, ...(after === undefined ? {} : { after }) });
    seen.push(...page.records.map((record) => record.recordId));
    after = page.next ?? undefined;
    pages += 1;
    assert.ok(pages < 20, 'the walk terminated');
  } while (after !== undefined);

  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7, 'nothing repeated');
  assert.deepEqual([...seen].sort(), seen, 'and the order is the record id, ascending');
});

test('a page walk over distinct instants is chronological', async () => {
  const { service } = await seedRecords(5, (index) => `2026-04-0${String(index + 1)}T12:00:00Z`);

  const all = await service.queryAll({ limit: 2 });
  assert.deepEqual(
    all.map((record) => record.recordedAt),
    [
      '2026-04-01T12:00:00Z',
      '2026-04-02T12:00:00Z',
      '2026-04-03T12:00:00Z',
      '2026-04-04T12:00:00Z',
      '2026-04-05T12:00:00Z',
    ],
  );
});

test('the last page reports no cursor, so a walk knows to stop', async () => {
  const { service } = await seedRecords(3, () => '2026-04-01T12:00:00Z');

  const page = await service.query({ limit: 10 });
  assert.equal(page.records.length, 3);
  assert.equal(page.next, null, 'a full result set is not a page boundary');

  const exact = await service.query({ limit: 3 });
  assert.equal(exact.records.length, 3);
  assert.equal(exact.next, null, 'nor is a page that happens to be exactly full');
});

test('a query is repeatable: same filters, same page, every time', async () => {
  const { service } = await seedRecords(6, (index) =>
    index % 2 === 0 ? '2026-04-01T12:00:00Z' : '2026-04-02T12:00:00Z',
  );

  const first = await service.query({ limit: 4 });
  for (let i = 0; i < 5; i += 1) {
    const again = await service.query({ limit: 4 });
    assert.deepEqual(
      again.records.map((record) => record.recordId),
      first.records.map((record) => record.recordId),
    );
    assert.deepEqual(again.next, first.next);
  }
});

test('an out-of-range limit and a malformed query are refused', async () => {
  const { service } = build();

  for (const limit of [0, -1, 1.5, 1001, Number.NaN]) {
    await assert.rejects(
      service.query({ limit }),
      (error: unknown) => codeOf(error) === 'invalid-query',
      `limit ${String(limit)} must be refused`,
    );
  }

  await assert.rejects(
    service.query({ action: 'inventory.item_reserved' }),
    (error: unknown) => codeOf(error) === 'unknown-action',
    'filtering on an unregistered action is a typo, not an empty result',
  );
  await assert.rejects(
    service.query({ outcome: 'partially' }),
    (error: unknown) => codeOf(error) === 'invalid-query',
  );
  await assert.rejects(
    service.query({ from: 'yesterday' }),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
  await assert.rejects(
    service.query({ after: { recordedAt: '2026-02-30T00:00:00Z', recordId: 'aud-1' } }),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
});

test('filters find the record an investigation would start from', async () => {
  const { service } = build();

  await service.record(
    recordRequest({
      recordId: 'aud-1',
      idempotencyKey: 'k-1',
      correlationId: 'corr-incident',
      outcome: 'denied',
      actor: OPERATOR,
      reason: 'not permitted at global scope',
    }),
  );
  await service.record(
    recordRequest({ recordId: 'aud-2', idempotencyKey: 'k-2', correlationId: 'corr-other' }),
  );

  const denied = await service.query({ outcome: 'denied' });
  assert.deepEqual(
    denied.records.map((record) => record.recordId),
    ['aud-1'],
  );

  const byActor = await service.query({ actorId: 'ops-alice' });
  assert.deepEqual(
    byActor.records.map((record) => record.recordId),
    ['aud-1'],
  );

  const chain = await service.query({ correlationId: 'corr-incident' });
  assert.deepEqual(
    chain.records.map((record) => record.recordId),
    ['aud-1'],
    'the correlation id is what ties an incident together across units',
  );

  const resource = await service.query({
    resourceOwner: 'K-05',
    resourceType: 'configuration_version',
    resourceId: 'ver-1',
  });
  assert.equal(resource.records.length, 2, 'both records touched the same resource');
});

test('queryAll stops at its bound rather than reading the whole log', async () => {
  const { service } = await seedRecords(10, () => '2026-04-01T12:00:00Z');

  const bounded = await service.queryAll({ limit: 3 }, 4);
  assert.equal(
    bounded.length,
    4,
    'an unbounded audit query is how one investigation takes a database down',
  );

  const everything = await service.queryAll({ limit: 3 });
  assert.equal(everything.length, 10);
});

test('recordById returns the exact record, and refuses an unknown id', async () => {
  const { service } = build();
  const written = await service.record(recordRequest({ recordId: 'aud-1', idempotencyKey: 'k-1' }));

  const read = await service.recordById('aud-1');
  assert.deepEqual(read, written.record);

  await assert.rejects(
    service.recordById('aud-nope'),
    (error: unknown) => codeOf(error) === 'no-such-record',
  );
});
