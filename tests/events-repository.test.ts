/**
 * K-08 Event Infrastructure — port conformance, adapter queries and module contract (FND-003b).
 *
 * Three kinds of assertion, and they cover different risks:
 *
 *   - **Port conformance.** The in-memory repository is the reference implementation, so its
 *     guards are the contract. If it accepts something the database would refuse, every service
 *     test above is proving a guarantee that only holds in memory.
 *   - **Adapter queries.** Statement shape is behaviour and cannot be asserted by reading source:
 *     the real adapter runs against a recording fake, and what it sends is inspected.
 *   - **Module contract.** Ownership, schema and migration coupling, asserted mechanically so that
 *     the CONTRACT.md claims cannot drift away from the code.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KERNEL_COMPONENTS } from '../platform/architecture/manifest.ts';
import { KERNEL_SCHEMA_PREFIX, knownSchemas } from '../platform/db/schema-namespaces.ts';
import {
  DELIVERY_TABLE,
  EVENT_SCHEMA,
  EVENT_TABLE,
  EventError,
  InMemoryEventRepository,
  PostgresEventRepository,
  RECEIPT_TABLE,
  TIMESTAMP_COLUMNS,
  decodePayload,
  toDelivery,
  toEnvelope,
} from '../kernel/event-infrastructure/index.ts';
import type {
  ConsumerReceipt,
  Delivery,
  EventEnvelope,
  EventRepository,
} from '../kernel/event-infrastructure/index.ts';

import { RecordingDatabase } from './helpers/recording-database.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, '..', 'kernel', 'event-infrastructure');
const ADAPTER_SOURCE = readFileSync(path.join(MODULE_DIR, 'postgres-repository.ts'), 'utf8');
const CONTRACT = readFileSync(path.join(MODULE_DIR, 'CONTRACT.md'), 'utf8');
const MIGRATION_UP = readFileSync(
  path.join(
    HERE,
    '..',
    'db',
    'migrations',
    '0004_create_kernel_event_infrastructure_schema.up.sql',
  ),
  'utf8',
);
const MIGRATION_DOWN = readFileSync(
  path.join(
    HERE,
    '..',
    'db',
    'migrations',
    '0004_create_kernel_event_infrastructure_schema.down.sql',
  ),
  'utf8',
);

const codeOf = (error: unknown): string | undefined =>
  error instanceof EventError ? error.code : undefined;

const envelope = (overrides: Partial<EventEnvelope> = {}): EventEnvelope => ({
  eventId: 'evt-1',
  type: 'configuration.version_published',
  schemaVersion: 1,
  occurredAt: '2026-03-01T10:00:00Z',
  recordedAt: '2026-03-01T10:00:00Z',
  producer: 'K-05',
  correlationId: 'corr-1',
  causationId: null,
  payload: { version_id: 'ver-1' },
  payloadFingerprint: 'a'.repeat(64),
  idempotencyKey: 'idem-1',
  origin: 'system',
  ...overrides,
});

const delivery = (overrides: Partial<Delivery> = {}): Delivery => ({
  deliveryId: 'del-1',
  eventId: 'evt-1',
  subscription: 'audit-writer',
  generation: 1,
  status: 'pending',
  attempts: 0,
  nextAttemptAt: '2026-03-01T10:00:00Z',
  claimedBy: null,
  claimToken: null,
  claimExpiresAt: null,
  lastError: null,
  completedAt: null,
  createdAt: '2026-03-01T10:00:00Z',
  replayOf: null,
  replayReason: null,
  ...overrides,
});

const receipt = (overrides: Partial<ConsumerReceipt> = {}): ConsumerReceipt => ({
  subscription: 'audit-writer',
  eventId: 'evt-1',
  deliveryId: 'del-1',
  processedAt: '2026-03-01T10:00:00Z',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Port conformance
// ---------------------------------------------------------------------------

const conformance = (name: string, make: () => EventRepository & InMemoryEventRepository): void => {
  test(`${name}: an event is appended once and never rewritten`, async () => {
    const repository = make();
    await repository.withTransaction((tx) => tx.insertEvent(envelope()));

    await assert.rejects(
      repository.withTransaction((tx) => tx.insertEvent(envelope({ idempotencyKey: 'idem-2' }))),
      (error: unknown) => codeOf(error) === 'duplicate-event-id',
    );
    await assert.rejects(
      repository.withTransaction((tx) => tx.insertEvent(envelope({ eventId: 'evt-2' }))),
      (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
    );

    assert.equal(repository.events().length, 1);
  });

  test(`${name}: the port offers no way to change an event`, () => {
    const repository = make();
    const operations = new Set<string>();
    // The transaction object is constructed inside withTransaction, so its shape is inspected from
    // the inside. Anything that could edit an envelope would appear here.
    return repository.withTransaction((tx) => {
      let proto: object | null = Object.getPrototypeOf(tx) as object | null;
      while (proto !== null && proto !== Object.prototype) {
        for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
        proto = Object.getPrototypeOf(proto) as object | null;
      }
      const mutators = [...operations].filter(
        (op) => /event/i.test(op) && /update|set|edit/i.test(op),
      );
      assert.deepEqual(mutators, [], 'an envelope is evidence, and evidence is not editable');
      assert.ok(operations.has('insertEvent'));
      assert.ok(!operations.has('deleteEvent'));
      return Promise.resolve();
    });
  });

  test(`${name}: one delivery per event, subscription and generation`, async () => {
    const repository = make();
    await repository.withTransaction(async (tx) => {
      await tx.insertEvent(envelope());
      await tx.insertDelivery(delivery());
    });

    await assert.rejects(
      repository.withTransaction((tx) => tx.insertDelivery(delivery({ deliveryId: 'del-2' }))),
      (error: unknown) => codeOf(error) === 'concurrent-modification',
      'the same subscription may not have two deliveries at one generation',
    );
    await repository.withTransaction((tx) =>
      tx.insertDelivery(delivery({ deliveryId: 'del-2', generation: 2 })),
    );
    assert.equal(repository.deliveries().length, 2);
  });

  test(`${name}: completion is refused unless the claim token is current`, async () => {
    const repository = make();
    await repository.withTransaction(async (tx) => {
      await tx.insertEvent(envelope());
      await tx.insertDelivery(delivery());
    });

    await repository.withTransaction((tx) =>
      tx.claimDueDeliveries({
        subscription: 'audit-writer',
        now: '2026-03-01T10:00:00Z',
        limit: 10,
        worker: 'worker-a',
        claimToken: 'claim-a',
        claimExpiresAt: '2026-03-01T10:05:00Z',
      }),
    );

    await assert.rejects(
      repository.withTransaction((tx) =>
        tx.completeDelivery('del-1', 'claim-b', '2026-03-01T10:01:00Z'),
      ),
      (error: unknown) => codeOf(error) === 'stale-claim',
      'a token that is not the current claim completes nothing',
    );

    await repository.withTransaction((tx) =>
      tx.completeDelivery('del-1', 'claim-a', '2026-03-01T10:01:00Z'),
    );
    assert.equal(repository.deliveries()[0]?.status, 'delivered');
  });

  test(`${name}: a terminal delivery is never reopened`, async () => {
    const repository = make();
    await repository.withTransaction(async (tx) => {
      await tx.insertEvent(envelope());
      await tx.insertDelivery(
        delivery({ status: 'delivered', completedAt: '2026-03-01T10:01:00Z' }),
      );
    });

    // Every terminal transition, not just completion: a delivered row must not be able to become
    // pending again through a reschedule either, or a stalled worker could resurrect it.
    await assert.rejects(
      repository.withTransaction((tx) =>
        tx.completeDelivery('del-1', 'claim-a', '2026-03-01T10:02:00Z'),
      ),
      (error: unknown) => codeOf(error) === 'obsolete-delivery',
    );
    await assert.rejects(
      repository.withTransaction((tx) =>
        tx.rescheduleDelivery('del-1', 'claim-a', '2026-03-01T10:02:00Z', 'retry me'),
      ),
      (error: unknown) => codeOf(error) === 'obsolete-delivery',
    );
    await assert.rejects(
      repository.withTransaction((tx) =>
        tx.deadLetterDelivery('del-1', 'claim-a', '2026-03-01T10:02:00Z', 'give up'),
      ),
      (error: unknown) => codeOf(error) === 'obsolete-delivery',
    );

    assert.equal(repository.deliveries()[0]?.status, 'delivered', 'unchanged by all three');
    assert.equal(repository.deliveries()[0]?.completedAt, '2026-03-01T10:01:00Z');
  });

  test(`${name}: an expired lease makes a delivery claimable again`, async () => {
    const repository = make();
    await repository.withTransaction(async (tx) => {
      await tx.insertEvent(envelope());
      await tx.insertDelivery(
        delivery({
          status: 'in-flight',
          attempts: 1,
          claimedBy: 'worker-a',
          claimToken: 'claim-a',
          claimExpiresAt: '2026-03-01T10:05:00Z',
        }),
      );
    });

    const tooEarly = await repository.withTransaction((tx) =>
      tx.claimDueDeliveries({
        subscription: 'audit-writer',
        now: '2026-03-01T10:04:59Z',
        limit: 10,
        worker: 'worker-b',
        claimToken: 'claim-b',
        claimExpiresAt: '2026-03-01T10:09:59Z',
      }),
    );
    assert.deepEqual(tooEarly, [], 'a live lease is respected');

    const claimed = await repository.withTransaction((tx) =>
      tx.claimDueDeliveries({
        subscription: 'audit-writer',
        now: '2026-03-01T10:05:00Z',
        limit: 10,
        worker: 'worker-b',
        claimToken: 'claim-c',
        claimExpiresAt: '2026-03-01T10:10:00Z',
      }),
    );
    assert.equal(claimed.length, 1, 'a dead lease returns the work to the pool');
    assert.equal(claimed[0]?.attempts, 2, 'and the abandoned attempt was still counted');
  });

  test(`${name}: a claim lease must be in the future`, async () => {
    const repository = make();
    await assert.rejects(
      repository.withTransaction((tx) =>
        tx.claimDueDeliveries({
          subscription: 'audit-writer',
          now: '2026-03-01T10:00:00Z',
          limit: 10,
          worker: 'worker-a',
          claimToken: 'claim-a',
          claimExpiresAt: '2026-03-01T10:00:00Z',
        }),
      ),
      (error: unknown) => codeOf(error) === 'malformed-envelope',
      'a lease that has already expired protects nothing',
    );
  });

  test(`${name}: one receipt per subscription and event`, async () => {
    const repository = make();
    await repository.withTransaction(async (tx) => {
      await tx.insertEvent(envelope());
      await tx.insertDelivery(delivery());
      await tx.insertReceipt(receipt());
    });

    await assert.rejects(
      repository.withTransaction((tx) => tx.insertReceipt(receipt())),
      (error: unknown) => codeOf(error) === 'concurrent-modification',
    );

    const removed = await repository.withTransaction((tx) =>
      tx.deleteReceipt('audit-writer', 'evt-1'),
    );
    assert.equal(removed, true);
    assert.equal(repository.receipts().length, 0);

    const removedAgain = await repository.withTransaction((tx) =>
      tx.deleteReceipt('audit-writer', 'evt-1'),
    );
    assert.equal(removedAgain, false, 'discarding a receipt that is not there is not an error');
  });

  test(`${name}: a failed transaction writes nothing`, async () => {
    const repository = make();
    await assert.rejects(
      repository.withTransaction(async (tx) => {
        await tx.insertEvent(envelope());
        await tx.insertDelivery(delivery());
        throw new Error('something went wrong after the writes');
      }),
    );
    assert.equal(repository.events().length, 0);
    assert.equal(repository.deliveries().length, 0);
    assert.equal(repository.transactionsRolledBack, 1);
  });
};

conformance('in-memory', () => new InMemoryEventRepository());

// ---------------------------------------------------------------------------
// Adapter queries
// ---------------------------------------------------------------------------

async function issuedStatements(): Promise<string[]> {
  const database = new RecordingDatabase({ selects: [{ match: /SELECT/i, rows: [] }] });
  const repository = new PostgresEventRepository(database);
  await repository.withTransaction(async (tx) => {
    await tx.findEventById('evt-1');
    await tx.findEventByIdempotencyKey('idem-1');
    await tx.findDeliveryById('del-1');
    await tx.findDeliveriesForEvent('evt-1');
    await tx.findLatestDelivery('evt-1', 'audit-writer');
    await tx.findReceipt('audit-writer', 'evt-1');
  });
  return database.statements();
}

test('the adapter claims work atomically, with SKIP LOCKED', async () => {
  const database = new RecordingDatabase();
  const repository = new PostgresEventRepository(database);

  await repository.withTransaction((tx) =>
    tx.claimDueDeliveries({
      subscription: 'audit-writer',
      now: '2026-03-01T10:00:00Z',
      limit: 5,
      worker: 'worker-a',
      claimToken: 'claim-a',
      claimExpiresAt: '2026-03-01T10:05:00Z',
    }),
  );

  const claim = database.statements().find((sql) => /UPDATE/i.test(sql));
  assert.ok(claim !== undefined, 'claiming is an UPDATE, not a SELECT followed by one');
  assert.match(
    claim,
    /FOR UPDATE SKIP LOCKED/,
    'without SKIP LOCKED two workers block on each other or take the same row',
  );
  assert.match(claim, /attempts = target\.attempts \+ 1/, 'a claim burns an attempt');
  assert.match(claim, /status = 'pending' AND due\.next_attempt_at <= \$2/);
  assert.match(
    claim,
    /status = 'in-flight' AND due\.claim_expires_at <= \$2/,
    'dead leases return',
  );
  assert.match(claim, /RETURNING/, 'selection and acquisition are one statement');
});

test('every completion path is guarded on the claim token and the in-flight status', async () => {
  const database = new RecordingDatabase({ updates: [{ match: /UPDATE/i, rowCount: 1 }] });
  const repository = new PostgresEventRepository(database);

  await repository.withTransaction(async (tx) => {
    await tx.completeDelivery('del-1', 'claim-a', '2026-03-01T10:01:00Z');
    await tx.rescheduleDelivery('del-1', 'claim-a', '2026-03-01T10:02:00Z', 'boom');
    await tx.deadLetterDelivery('del-1', 'claim-a', '2026-03-01T10:03:00Z', 'boom');
  });

  const updates = database.statements().filter((sql) => /^UPDATE/i.test(sql));
  assert.equal(updates.length, 3);
  for (const sql of updates) {
    assert.match(
      sql,
      /WHERE delivery_id = \$1 AND claim_token = \$2 AND status = 'in-flight'/,
      `unguarded: ${sql}`,
    );
    assert.match(sql, /claim_token = NULL/, 'a completed delivery releases its claim');
  }
});

test('a zero-row completion is diagnosed rather than reported as success', async () => {
  const database = new RecordingDatabase({
    updates: [{ match: /UPDATE/i, rowCount: 0 }],
    selects: [
      {
        match: /SELECT/i,
        rows: [
          {
            delivery_id: 'del-1',
            event_id: 'evt-1',
            subscription: 'audit-writer',
            generation: 1,
            status: 'delivered',
            attempts: 1,
            next_attempt_at: '2026-03-01T10:00:00.000000Z',
            claimed_by: null,
            claim_token: null,
            claim_expires_at: null,
            last_error: null,
            completed_at: '2026-03-01T10:01:00.000000Z',
            created_at: '2026-03-01T10:00:00.000000Z',
            replay_of: null,
            replay_reason: null,
          },
        ],
      },
    ],
  });
  const repository = new PostgresEventRepository(database);

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.completeDelivery('del-1', 'claim-a', '2026-03-01T10:02:00Z'),
    ),
    (error: unknown) => codeOf(error) === 'obsolete-delivery',
    'a delivery that is already terminal says so, rather than reporting "0 rows"',
  );
  assert.ok(database.statements().includes('ROLLBACK;'));
});

test('every timestamp column is projected as UTC text in every SELECT', async () => {
  for (const sql of (await issuedStatements()).filter((s) => /^SELECT/i.test(s))) {
    const selectList = sql.slice(0, sql.search(/\bFROM\b/i));
    for (const column of TIMESTAMP_COLUMNS) {
      if (!selectList.includes(column)) continue;
      const projected = `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${column}`;
      assert.ok(selectList.includes(projected), `${column} is not projected as text in: ${sql}`);
      assert.ok(
        !new RegExp(`(^|[\\s,(])${column}(\\s*,|\\s*$)`).test(
          selectList.split(projected).join(' '),
        ),
        `${column} also appears bare in: ${sql}`,
      );
    }
  }
});

test('ordering is done on the column, not on the projected text', async () => {
  const ordered = (await issuedStatements()).filter((sql) => /ORDER BY/i.test(sql));
  assert.ok(ordered.length >= 2);
  for (const sql of ordered) {
    assert.match(
      sql,
      /ORDER BY event_delivery\.generation/,
      'an unqualified name binds to the output column; here that is harmless, but only by luck',
    );
  }
});

test('the adapter parameterises every value it writes', () => {
  const statements = [
    ...ADAPTER_SOURCE.matchAll(/client\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g),
  ].map((match) => match[1] ?? '');
  assert.ok(
    statements.length >= 8,
    `expected the adapter to issue queries, found ${statements.length}`,
  );

  const permitted = new Set([
    'EVENT_TABLE',
    'DELIVERY_TABLE',
    'RECEIPT_TABLE',
    'EVENT_COLUMNS',
    'EVENT_PROJECTION',
    'DELIVERY_COLUMNS',
    'DELIVERY_PROJECTION',
    'RECEIPT_COLUMNS',
    'RECEIPT_PROJECTION',
  ]);
  for (const sql of statements) {
    for (const match of sql.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      assert.ok(
        permitted.has(String(match[1])),
        `SQL interpolates ${String(match[1])}, which is not a fixed constant`,
      );
    }
  }
  assert.ok(statements.some((sql) => sql.includes('$1')));
});

test('a payload that is not a flat scalar object is refused on the way out', () => {
  assert.deepEqual(decodePayload('{"a":1,"b":"x","c":true,"d":null}', 'evt-1'), {
    a: 1,
    b: 'x',
    c: true,
    d: null,
  });
  assert.deepEqual(decodePayload({ a: 1 }, 'evt-1'), { a: 1 });

  for (const bad of ['[1,2]', 'null', '"text"', 'not json', '{"a":{"nested":1}}', '{"a":[1]}']) {
    assert.throws(
      () => decodePayload(bad, 'evt-1'),
      (error: unknown) => codeOf(error) === 'invalid-payload',
      `${bad} is not a validatable payload`,
    );
  }
});

test('a timestamp that arrives as a Date is refused rather than truncated', () => {
  assert.throws(
    () =>
      toEnvelope({
        event_id: 'evt-1',
        event_type: 'configuration.version_published',
        schema_version: 1,
        occurred_at: new Date('2026-03-01T10:00:00Z'),
        recorded_at: '2026-03-01T10:00:00.000000Z',
        producer: 'K-05',
        correlation_id: 'corr-1',
        causation_id: null,
        payload: { a: 1 },
        payload_fingerprint: 'a'.repeat(64),
        idempotency_key: 'idem-1',
        origin: 'system',
      }),
    (error: unknown) => codeOf(error) === 'malformed-envelope',
  );

  assert.throws(
    () =>
      toDelivery({
        delivery_id: 'del-1',
        event_id: 'evt-1',
        subscription: 'audit-writer',
        generation: 1,
        status: 'pending',
        attempts: 0,
        next_attempt_at: 'infinity',
        claimed_by: null,
        claim_token: null,
        claim_expires_at: null,
        last_error: null,
        completed_at: null,
        created_at: '2026-03-01T10:00:00.000000Z',
        replay_of: null,
        replay_reason: null,
      }),
    (error: unknown) => codeOf(error) === 'malformed-envelope',
    'an infinite next_attempt_at would make a delivery permanently undue',
  );
});

// ---------------------------------------------------------------------------
// Module contract
// ---------------------------------------------------------------------------

test('the K-08 schema is the one the architecture manifest derives', () => {
  const component = KERNEL_COMPONENTS.find((entry) => entry.id === 'K-08');
  assert.ok(component !== undefined);
  assert.equal(EVENT_SCHEMA, `${KERNEL_SCHEMA_PREFIX}${component.dir.replace(/-/g, '_')}`);
  assert.ok(knownSchemas().includes(EVENT_SCHEMA), 'the schema is owned by a manifest unit');
  assert.equal(EVENT_TABLE, `${EVENT_SCHEMA}.event`);
  assert.equal(DELIVERY_TABLE, `${EVENT_SCHEMA}.event_delivery`);
  assert.equal(RECEIPT_TABLE, `${EVENT_SCHEMA}.event_receipt`);
});

test('the adapter names its own schema and no other', () => {
  const others = knownSchemas().filter((schema) => schema !== EVENT_SCHEMA);
  const statements = [
    ...ADAPTER_SOURCE.matchAll(/client\.query(?:<[^>]*>)?\(\s*`([\s\S]*?)`/g),
  ].map((match) => match[1] ?? '');

  for (const sql of statements) {
    for (const schema of others) {
      assert.ok(!sql.includes(`${schema}.`), `the adapter reaches into ${schema}`);
    }
  }
});

test('the migration is owned by K-08 and touches no other schema', () => {
  assert.match(MIGRATION_UP, /^-- owner: kernel_event_infrastructure$/m);
  assert.match(MIGRATION_DOWN, /^-- owner: kernel_event_infrastructure$/m);

  for (const schema of knownSchemas().filter((s) => s !== EVENT_SCHEMA)) {
    assert.ok(!MIGRATION_UP.includes(`${schema}.`), `the forward migration touches ${schema}`);
    assert.ok(!MIGRATION_DOWN.includes(`${schema}.`), `the rollback touches ${schema}`);
  }
});

test('the migration enforces the guarantees in the database, not only in the service', () => {
  // The claim token is what stops a stale worker acknowledging. If it were not unique, two claims
  // could not be told apart and the guard would be decorative.
  assert.match(MIGRATION_UP, /CONSTRAINT event_delivery_claim_token_unique UNIQUE \(claim_token\)/);
  // A replay appends; it never reuses a generation.
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT event_delivery_generation_unique UNIQUE \(event_id, subscription, generation\)/,
  );
  // One receipt per subscription and event: the consumer-side deduplication key.
  assert.match(
    MIGRATION_UP,
    /CONSTRAINT event_receipt_pkey PRIMARY KEY \(subscription, event_id\)/,
  );
  // AI may not publish, at the database level as well as in the service.
  assert.match(MIGRATION_UP, /CHECK \(origin IN \('system', 'human'\)\)/);
  // A claim is all-or-nothing, and only an in-flight row holds one.
  assert.match(MIGRATION_UP, /event_delivery_claim_only_in_flight/);
  assert.match(MIGRATION_UP, /event_delivery_terminal_has_instant/);
});

test('the rollback reverses exactly what the forward migration created', () => {
  const created = [...MIGRATION_UP.matchAll(/CREATE TABLE IF NOT EXISTS ([\w.]+)/g)].map(
    (match) => match[1],
  );
  const dropped = [...MIGRATION_DOWN.matchAll(/DROP TABLE IF EXISTS ([\w.]+)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...created].sort(), [...dropped].sort());

  const createdIndexes = [...MIGRATION_UP.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map(
    (match) => match[1],
  );
  for (const index of createdIndexes) {
    assert.ok(
      MIGRATION_DOWN.includes(String(index)),
      `${String(index)} is created but never dropped`,
    );
  }

  // Children before parents: event_receipt and event_delivery both carry foreign keys into
  // event, so dropping event first would fail against a real server.
  assert.deepEqual(
    dropped,
    [
      'kernel_event_infrastructure.event_receipt',
      'kernel_event_infrastructure.event_delivery',
      'kernel_event_infrastructure.event',
    ],
    'a foreign key means the child table must be dropped first',
  );
  assert.match(MIGRATION_DOWN, /DROP SCHEMA IF EXISTS kernel_event_infrastructure RESTRICT/);
});

test('the module contract records what is deferred rather than implying it exists', () => {
  for (const deferred of ['K-02', 'K-04', 'K-09', 'broker']) {
    assert.ok(CONTRACT.includes(deferred), `CONTRACT.md does not mention ${deferred}`);
  }
  assert.match(
    CONTRACT,
    /no module publishes|not yet integrated|no producing module/i,
    'the contract must not imply that module integration is delivered',
  );
  assert.match(CONTRACT, /at-least-once/i);
  assert.match(CONTRACT, /same transaction/i, 'the transactional-outbox rule must be written down');
});
