/**
 * K-09 — the immutability boundary and persisted integrity (FND-003c correction).
 *
 * Three gaps, none visible from the tests that shipped with the slice:
 *
 *   - **`actor` and `resource` were reachable and writable.** Only the evidence map was frozen. A
 *     caller holding a returned record could write `record.actor.id` and change the two fields that
 *     say *who did it* — in a component whose entire value is that a record cannot be changed.
 *   - **A shallow copy shares its children.** `{ ...record }` gives a new top level over the *same*
 *     nested objects, so storing a caller's record and then letting the caller edit its actor
 *     edited what was stored, after the fact, with nothing to see.
 *   - **The stored fingerprint was trusted on read.** Every other decode check asks whether a field
 *     is well formed; none asked whether the record still said what it said when written. A row
 *     altered by something that reached the table another way — a doctored backup, a connection
 *     that got past the trigger — decoded cleanly and was read as fact.
 *
 * The tests below attack each from every direction a record can be handed across a boundary:
 * service results, repository reads, seeded inputs, query pages, and PostgreSQL decoding.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuditError,
  InMemoryAuditRepository,
  PostgresAuditRepository,
  fingerprintRecord,
  isSealed,
  sealRecord,
  toRecord,
} from '../kernel/audit-foundation/index.ts';
import type { AuditRecord, AuditTransaction } from '../kernel/audit-foundation/index.ts';

import { build, recordRequest } from './helpers/audit-fixtures.ts';
import { RecordingDatabase } from './helpers/recording-database.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AuditError ? error.code : undefined;

/** The record type with every `readonly` stripped, so a test can attempt what a caller would. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

/** Mutable by construction, so a test can hand the component something it still holds a handle to. */
const mutableRecord = (overrides: Partial<AuditRecord> = {}): Mutable<AuditRecord> => {
  const draft = {
    recordId: 'aud-1',
    action: 'configuration.version_published',
    recordedAt: '2026-04-01T12:00:00Z',
    actor: {
      kind: 'system' as const,
      id: 'K-05',
      authentication: 'unauthenticated' as const,
      sessionId: null,
    },
    resource: { owner: 'K-05', type: 'configuration_version', id: 'ver-1' },
    outcome: 'succeeded' as const,
    reason: 'published',
    correlationId: 'corr-1',
    causationId: null,
    evidence: { config_key: 'session.timeout_seconds' },
    idempotencyKey: 'idem-1',
    ...overrides,
  };
  return { ...draft, contentFingerprint: fingerprintRecord(draft) };
};

/** Every nested write a caller could attempt, with the field each one would have changed. */
const MUTATIONS: ReadonlyArray<{
  readonly why: string;
  readonly mutate: (record: AuditRecord) => void;
}> = [
  {
    why: 'the actor id',
    mutate: (r) => void ((r.actor as unknown as Record<string, unknown>).id = 'someone-else'),
  },
  {
    why: 'the actor kind',
    mutate: (r) => void ((r.actor as unknown as Record<string, unknown>).kind = 'ai'),
  },
  {
    why: 'the actor authentication',
    mutate: (r) =>
      void ((r.actor as unknown as Record<string, unknown>).authentication = 'session'),
  },
  {
    why: 'the actor session',
    mutate: (r) => void ((r.actor as unknown as Record<string, unknown>).sessionId = 'sess-1'),
  },
  {
    why: 'the resource owner',
    mutate: (r) => void ((r.resource as unknown as Record<string, unknown>).owner = 'K-08'),
  },
  {
    why: 'the resource id',
    mutate: (r) => void ((r.resource as unknown as Record<string, unknown>).id = 'ver-999'),
  },
  {
    why: 'an evidence field',
    mutate: (r) =>
      void ((r.evidence as unknown as Record<string, unknown>).config_key = 'tampered'),
  },
  {
    why: 'a new evidence field',
    mutate: (r) => void ((r.evidence as unknown as Record<string, unknown>).smuggled = 'value'),
  },
  {
    why: 'the reason',
    mutate: (r) => void ((r as unknown as Record<string, unknown>).reason = 'tampered'),
  },
  {
    why: 'the outcome',
    mutate: (r) => void ((r as unknown as Record<string, unknown>).outcome = 'denied'),
  },
  {
    why: 'the instant',
    mutate: (r) =>
      void ((r as unknown as Record<string, unknown>).recordedAt = '2020-01-01T00:00:00Z'),
  },
  {
    why: 'the fingerprint',
    mutate: (r) =>
      void ((r as unknown as Record<string, unknown>).contentFingerprint = 'b'.repeat(64)),
  },
];

// ---------------------------------------------------------------------------
// 1. The seal boundary, at every crossing
// ---------------------------------------------------------------------------

test('sealRecord freezes the record and every nested object, and is idempotent', () => {
  const sealed = sealRecord(mutableRecord());

  assert.ok(isSealed(sealed));
  assert.ok(Object.isFrozen(sealed.actor), 'actor');
  assert.ok(Object.isFrozen(sealed.resource), 'resource');
  assert.ok(Object.isFrozen(sealed.evidence), 'evidence');

  const again = sealRecord(sealed);
  assert.deepEqual(again, sealed, 'sealing a sealed record changes nothing');
  assert.ok(isSealed(again));
});

test('sealRecord copies rather than freezing the caller’s objects', () => {
  // The severing half. Freezing the caller's own object would be a surprising side effect; copying
  // is what makes the store unreachable from a handle the caller kept.
  const original = mutableRecord();
  const sealed = sealRecord(original);

  assert.notEqual(sealed.actor, original.actor, 'a distinct actor object');
  assert.notEqual(sealed.resource, original.resource);
  assert.notEqual(sealed.evidence, original.evidence);
  assert.ok(!Object.isFrozen(original.actor), "the caller's own object is left alone");

  original.actor.id = 'changed-afterwards';
  assert.equal(sealed.actor.id, 'K-05', 'the seal did not follow the caller');
});

test('every nested mutation through a service result throws and changes nothing', async () => {
  for (const scenario of MUTATIONS) {
    const { service, repository } = build();
    const result = await service.record(
      recordRequest({ recordId: 'aud-1', idempotencyKey: 'k-1' }),
    );
    const before = structuredClone(repository.records()[0]);

    assert.throws(() => scenario.mutate(result.record), TypeError, `${scenario.why} was writable`);
    assert.deepEqual(repository.records()[0], before, `${scenario.why} changed stored state`);
  }
});

test('every nested mutation through a repository read throws and changes nothing', async () => {
  const { service, repository } = build();
  await service.record(recordRequest({ recordId: 'aud-1', idempotencyKey: 'k-1' }));
  const before = structuredClone(repository.records()[0]);

  for (const scenario of MUTATIONS) {
    const read = repository.records()[0] as AuditRecord;
    assert.throws(() => scenario.mutate(read), TypeError, `${scenario.why} was writable on a read`);
  }
  assert.deepEqual(repository.records()[0], before);
});

test('every nested mutation through a transaction read throws and changes nothing', async () => {
  const repository = new InMemoryAuditRepository();
  await repository.withTransaction((tx) => tx.insertRecord(mutableRecord()));
  const before = structuredClone(repository.records()[0]);

  for (const scenario of MUTATIONS) {
    const read = await repository.withTransaction((tx) => tx.findRecordById('aud-1'));
    assert.ok(read !== null);
    assert.ok(isSealed(read), `${scenario.why}: the read was not sealed`);
    assert.throws(() => scenario.mutate(read), TypeError, `${scenario.why} was writable`);

    const byKey = await repository.withTransaction((tx) => tx.findRecordByIdempotencyKey('idem-1'));
    assert.ok(byKey !== null && isSealed(byKey), 'the idempotency-key read is sealed too');
  }
  assert.deepEqual(repository.records()[0], before);
});

test('every nested mutation through a query page throws and changes nothing', async () => {
  const { service, repository } = build();
  await service.record(recordRequest({ recordId: 'aud-1', idempotencyKey: 'k-1' }));
  await service.record(recordRequest({ recordId: 'aud-2', idempotencyKey: 'k-2' }));
  const before = structuredClone(repository.records());

  for (const scenario of MUTATIONS) {
    const page = await service.query({ limit: 10 });
    for (const record of page.records) {
      assert.ok(isSealed(record), `${scenario.why}: a page record was not sealed`);
      assert.throws(() => scenario.mutate(record), TypeError, `${scenario.why} was writable`);
    }

    const all = await service.queryAll({ limit: 1 });
    for (const record of all) {
      assert.ok(isSealed(record), 'queryAll seals every record it accumulates');
    }
  }
  assert.deepEqual(repository.records(), before);
});

test('a caller that keeps its input cannot reach the stored record through it', async () => {
  // The severing half again, this time through the service. Before the boundary existed, the actor
  // object the caller passed *was* the actor object the store held.
  const { service, repository } = build();
  const actor = {
    kind: 'system' as const,
    id: 'K-05',
    authentication: 'unauthenticated' as const,
    sessionId: null,
  };
  const resource = { owner: 'K-05', type: 'configuration_version', id: 'ver-1' };
  const evidence: Record<string, string> = { config_key: 'session.timeout_seconds' };

  await service.record(
    recordRequest({ recordId: 'aud-1', idempotencyKey: 'k-1', actor, resource, evidence }),
  );
  const before = structuredClone(repository.records()[0]);

  // The caller still holds all three, and they are still its own objects to edit.
  actor.id = 'someone-else';
  resource.id = 'ver-999';
  evidence.config_key = 'tampered';

  assert.deepEqual(repository.records()[0], before, 'none of it reached the log');
  assert.equal(repository.records()[0]?.actor.id, 'K-05');
  assert.equal(repository.records()[0]?.resource.id, 'ver-1');
  assert.equal(repository.records()[0]?.evidence.config_key, 'session.timeout_seconds');
});

test('a seeded record is severed from the array the test still holds', () => {
  const repository = new InMemoryAuditRepository();
  const seeded = mutableRecord();
  repository.seed([seeded]);
  const before = structuredClone(repository.records()[0]);

  seeded.actor.id = 'someone-else';
  seeded.resource.owner = 'K-08';
  (seeded.evidence as Record<string, unknown>).config_key = 'tampered';
  (seeded as unknown as Record<string, unknown>).reason = 'tampered';

  assert.deepEqual(repository.records()[0], before, 'seeding copied rather than borrowed');
  assert.ok(isSealed(repository.records()[0] as AuditRecord));
});

test('an inserted record is severed from the object the caller inserted', async () => {
  const repository = new InMemoryAuditRepository();
  const inserted = mutableRecord();
  await repository.withTransaction((tx) => tx.insertRecord(inserted));
  const before = structuredClone(repository.records()[0]);

  inserted.actor.id = 'someone-else';
  (inserted.evidence as Record<string, unknown>).config_key = 'tampered';

  assert.deepEqual(repository.records()[0], before);
});

// ---------------------------------------------------------------------------
// 2. Persisted integrity: the fingerprint is recomputed, never trusted
// ---------------------------------------------------------------------------

/**
 * The instant the adapter decodes from a projected column: trailing zeros in the fraction are not
 * part of the value. A fixture has to fingerprint what the decoder will recompute from, so it
 * canonicalises the same way rather than assuming one spelling.
 */
const canonicalInstant = (stored: string): string =>
  stored.replace(/\.(\d*[1-9])?0*Z$/, (_full, digits: string | undefined) =>
    digits === undefined ? 'Z' : `.${digits}Z`,
  );

/** A stored row whose fingerprint matches its own decoded content. */
const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const columns: Record<string, unknown> = {
    record_id: 'aud-1',
    action: 'configuration.version_published',
    recorded_at: '2026-04-01T12:00:00.000000Z',
    actor_kind: 'system',
    actor_id: 'K-05',
    actor_authentication: 'unauthenticated',
    actor_session_id: null,
    resource_owner: 'K-05',
    resource_type: 'configuration_version',
    resource_id: 'ver-1',
    outcome: 'succeeded',
    reason: 'published',
    correlation_id: 'corr-1',
    causation_id: null,
    evidence: { config_key: 'session.timeout_seconds' },
    idempotency_key: 'idem-1',
    ...overrides,
  };
  if ('content_fingerprint' in overrides) return columns;

  return {
    ...columns,
    content_fingerprint: fingerprintRecord({
      recordId: String(columns.record_id),
      action: String(columns.action),
      recordedAt: canonicalInstant(String(columns.recorded_at)),
      actor: {
        kind: columns.actor_kind as AuditRecord['actor']['kind'],
        id: String(columns.actor_id),
        authentication: columns.actor_authentication as AuditRecord['actor']['authentication'],
        sessionId: (columns.actor_session_id ?? null) as string | null,
      },
      resource: {
        owner: String(columns.resource_owner),
        type: String(columns.resource_type),
        id: String(columns.resource_id),
      },
      outcome: columns.outcome as AuditRecord['outcome'],
      reason: String(columns.reason),
      correlationId: String(columns.correlation_id),
      causationId: (columns.causation_id ?? null) as string | null,
      evidence: columns.evidence as AuditRecord['evidence'],
      idempotencyKey: String(columns.idempotency_key),
    }),
  };
};

const decode = (columns: Record<string, unknown>): AuditRecord =>
  toRecord(columns as unknown as Parameters<typeof toRecord>[0]);

test('a consistent row decodes, and comes back sealed', () => {
  const decoded = decode(row());

  assert.equal(decoded.recordId, 'aud-1');
  assert.ok(isSealed(decoded), 'a decoded record is sealed like every other crossing');
  assert.throws(() => {
    (decoded.actor as unknown as Record<string, unknown>).id = 'tampered';
  }, TypeError);
});

test('a well-formed row whose fingerprint does not match its content is refused', () => {
  // Every column is valid. The schema would accept it, the trigger never saw it, and every other
  // decode check passes. Only recomputation catches it.
  const tampered = row({ content_fingerprint: 'a'.repeat(64) });

  assert.throws(
    () => decode(tampered),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as AuditError).message, /hashes to/);
      assert.match((error as AuditError).message, /altered since it was written/);
      return true;
    },
  );
});

test('every field is covered by the recomputation', () => {
  // A row is built consistent, then one column is edited without recomputing — which is exactly
  // what an alteration looks like. If any field were left out of the canonical form, its case here
  // would decode cleanly.
  const alterations: ReadonlyArray<{
    readonly why: string;
    readonly column: Record<string, unknown>;
  }> = [
    { why: 'the record id', column: { record_id: 'aud-2' } },
    { why: 'the action', column: { action: 'events.replay_ordered' } },
    { why: 'the instant', column: { recorded_at: '2020-01-01T00:00:00.000000Z' } },
    { why: 'the actor kind', column: { actor_kind: 'human' } },
    { why: 'the actor id', column: { actor_id: 'someone-else' } },
    { why: 'the resource owner', column: { resource_owner: 'K-08' } },
    { why: 'the resource type', column: { resource_type: 'event_delivery' } },
    { why: 'the resource id', column: { resource_id: 'ver-999' } },
    { why: 'the outcome', column: { outcome: 'denied' } },
    { why: 'the reason', column: { reason: 'rewritten afterwards' } },
    { why: 'the correlation id', column: { correlation_id: 'corr-2' } },
    { why: 'the causation id', column: { causation_id: 'aud-0' } },
    { why: 'an evidence value', column: { evidence: { config_key: 'tampered' } } },
    {
      why: 'an added evidence field',
      column: { evidence: { config_key: 'session.timeout_seconds', extra: 'x' } },
    },
    { why: 'the idempotency key', column: { idempotency_key: 'idem-2' } },
  ];

  const consistent = row();
  for (const alteration of alterations) {
    const altered = { ...consistent, ...alteration.column };
    assert.throws(
      () => decode(altered),
      (error: unknown) => codeOf(error) === 'malformed-record',
      `altering ${alteration.why} was not caught by the fingerprint`,
    );
  }

  // And a row whose fingerprint was recomputed after the same edit decodes fine, so the refusals
  // above are about the mismatch rather than about the values.
  for (const alteration of alterations) {
    decode(row(alteration.column));
  }
});

test('evidence key order does not affect the recomputed fingerprint', () => {
  // Two spellings of one evidence map are one map. A fingerprint that depended on key order would
  // refuse rows at random depending on how the driver happened to deserialise the jsonb.
  const forward = row({ evidence: { alpha: '1', beta: '2' } });
  const reversed = { ...forward, evidence: { beta: '2', alpha: '1' } };

  const a = decode(forward);
  const b = decode(reversed);
  assert.equal(a.contentFingerprint, b.contentFingerprint);
});

test('the adapter refuses a tampered row on every read path', async () => {
  const tampered = row({ content_fingerprint: 'a'.repeat(64) });
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [tampered] }] });
  const repository = new PostgresAuditRepository(database);

  const reads: ReadonlyArray<readonly [string, (tx: AuditTransaction) => Promise<unknown>]> = [
    ['findRecordById', (tx) => tx.findRecordById('aud-1')],
    ['findRecordByIdempotencyKey', (tx) => tx.findRecordByIdempotencyKey('idem-1')],
    ['queryRecords', (tx) => tx.queryRecords({ limit: 10 })],
  ];

  for (const [name, read] of reads) {
    await assert.rejects(
      repository.withTransaction(read),
      (error: unknown) => codeOf(error) === 'malformed-record',
      `${name} returned a tampered row`,
    );
  }
});

test('one tampered row in a page refuses the page rather than hiding the row', async () => {
  // Skipping it would be worse than failing: a reader would get a page that looked complete and
  // silently omitted the one record somebody had reason to alter.
  const database = new RecordingDatabase({
    selects: [
      {
        match: /SELECT/i,
        rows: [
          row({ record_id: 'aud-1' }),
          row({ record_id: 'aud-2', content_fingerprint: 'a'.repeat(64) }),
        ],
      },
    ],
  });

  await assert.rejects(
    new PostgresAuditRepository(database).withTransaction((tx) => tx.queryRecords({ limit: 10 })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as AuditError).message, /aud-2/);
      return true;
    },
  );
});

test('a record written by the service round-trips through decoding', async () => {
  // The two halves must agree: what the service fingerprints is what the decoder recomputes. If
  // they ever drifted, every read of a genuine record would fail closed — which is safe, but only
  // discovered against a real database. This catches it here.
  const { service } = build();
  const written = await service.record(
    recordRequest({
      recordId: 'aud-round-trip',
      idempotencyKey: 'k-round-trip',
      evidence: { config_key: 'session.timeout_seconds', scope_level: 'global', attempt_count: 2 },
    }),
  );

  const decoded = decode({
    record_id: written.record.recordId,
    action: written.record.action,
    recorded_at: '2026-04-01T12:00:00.000000Z',
    actor_kind: written.record.actor.kind,
    actor_id: written.record.actor.id,
    actor_authentication: written.record.actor.authentication,
    actor_session_id: written.record.actor.sessionId,
    resource_owner: written.record.resource.owner,
    resource_type: written.record.resource.type,
    resource_id: written.record.resource.id,
    outcome: written.record.outcome,
    reason: written.record.reason,
    correlation_id: written.record.correlationId,
    causation_id: written.record.causationId,
    evidence: { ...written.record.evidence },
    content_fingerprint: written.record.contentFingerprint,
    idempotency_key: written.record.idempotencyKey,
  });

  assert.deepEqual(decoded, written.record, 'what was written is what decodes back');
});
