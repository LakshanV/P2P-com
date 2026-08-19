/**
 * K-08 Event Infrastructure — registry, envelope and publication (FND-003b).
 *
 * The envelope is the contract between units that cannot see each other's code, so most of what
 * matters here is what publication *refuses*. An event that reaches the log has been fanned out to
 * every subscriber and cannot be recalled; validating afterwards is validating too late.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EventError,
  EventTypeRegistry,
  SubscriptionRegistry,
  assertRegistrableType,
  assertValidPayload,
  fingerprintPayload,
} from '../kernel/event-infrastructure/index.ts';
import type {
  EventTypeDefinition,
  SubscriptionDefinition,
} from '../kernel/event-infrastructure/index.ts';

import {
  AI,
  SUBSCRIPTIONS,
  SYSTEM,
  TYPES,
  build,
  publishRequest,
} from './helpers/event-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof EventError ? error.code : undefined;

const typeDefinition = (overrides: Partial<EventTypeDefinition> = {}): EventTypeDefinition => ({
  type: 'inventory.item_reserved',
  schemaVersion: 1,
  owner: 'K-05',
  description: 'An item was reserved.',
  payloadFields: [{ name: 'item_id', kind: 'string', required: true, description: 'Which item.' }],
  ...overrides,
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test('an unregistered type and an unregistered version are refused differently', () => {
  const registry = new EventTypeRegistry(TYPES);

  assert.throws(
    () => registry.require('inventory.item_reserved', 1),
    (error: unknown) => codeOf(error) === 'unknown-event-type',
  );

  // A known type at an unknown version is usually a producer running ahead of its deployment, and
  // it is worth saying so rather than reporting the type as unknown.
  assert.throws(
    () => registry.require('configuration.version_published', 7),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unknown-schema-version');
      assert.match((error as EventError).message, /registered versions are 1, 2/);
      return true;
    },
  );

  assert.ok(registry.has('configuration.version_published', 1));
  assert.ok(registry.has('configuration.version_published', 2));
});

test('versions coexist, because events already in the log conform to the older one', () => {
  const registry = new EventTypeRegistry(TYPES);
  const v1 = registry.require('configuration.version_published', 1);
  const v2 = registry.require('configuration.version_published', 2);

  assert.equal(v1.payloadFields.length, 3);
  assert.equal(v2.payloadFields.length, 6);
  assert.equal(
    v1.payloadFields.find((field) => field.name === 'scope_level')?.required,
    false,
    'v1 made scope_level optional and that cannot be retroactively tightened',
  );
});

test('a type with no owner, no description or a bad name cannot be registered', () => {
  assert.throws(
    () => assertRegistrableType(typeDefinition({ type: 'ItemReserved' })),
    (error: unknown) => codeOf(error) === 'unknown-event-type',
  );
  assert.throws(
    () => assertRegistrableType(typeDefinition({ type: 'inventory' })),
    (error: unknown) => codeOf(error) === 'unknown-event-type',
    'a type without a subject and a fact is not a type',
  );
  assert.throws(
    () => assertRegistrableType(typeDefinition({ owner: 'K-99' })),
    (error: unknown) => codeOf(error) === 'producer-not-permitted',
    'an owner absent from the manifest has nobody to change the type',
  );
  assert.throws(
    () => assertRegistrableType(typeDefinition({ description: '   ' })),
    (error: unknown) => codeOf(error) === 'unknown-event-type',
  );
  assert.throws(
    () => assertRegistrableType(typeDefinition({ schemaVersion: 0 })),
    (error: unknown) => codeOf(error) === 'unknown-schema-version',
  );
});

test('a type that declares a credential field is refused at registration', () => {
  for (const name of ['password', 'api_key', 'session_id', 'user_access_key']) {
    assert.throws(
      () =>
        assertRegistrableType(
          typeDefinition({
            payloadFields: [{ name, kind: 'string', required: true, description: 'x' }],
          }),
        ),
      (error: unknown) => codeOf(error) === 'secret-bearing-payload',
      `"${name}" names a credential, and an event is published rather than merely stored`,
    );
  }
});

test('a subscription must name registered types and a real owner', () => {
  const types = new EventTypeRegistry(TYPES);
  const subscription = (
    overrides: Partial<SubscriptionDefinition> = {},
  ): SubscriptionDefinition[] => [
    {
      subscription: 'audit-writer',
      owner: 'K-09',
      types: ['configuration.version_published'],
      description: 'x',
      ...overrides,
    },
  ];

  assert.throws(
    () => new SubscriptionRegistry(subscription({ types: ['inventory.item_reserved'] }), types),
    (error: unknown) => codeOf(error) === 'unknown-event-type',
  );
  assert.throws(
    () => new SubscriptionRegistry(subscription({ types: [] }), types),
    (error: unknown) => codeOf(error) === 'unknown-subscription',
  );
  assert.throws(
    () => new SubscriptionRegistry(subscription({ owner: 'nobody' }), types),
    (error: unknown) => codeOf(error) === 'producer-not-permitted',
  );
  assert.throws(
    () => new SubscriptionRegistry(subscription({ subscription: 'Audit_Writer' }), types),
    (error: unknown) => codeOf(error) === 'unknown-subscription',
  );
});

test('fan-out is deterministic and covers every subscriber of the type', () => {
  const types = new EventTypeRegistry(TYPES);
  const registry = new SubscriptionRegistry(SUBSCRIPTIONS, types);
  assert.deepEqual(
    registry.subscribersOf('configuration.version_published').map((s) => s.subscription),
    ['audit-writer', 'search-indexer'],
  );
  assert.deepEqual(registry.subscribersOf('inventory.item_reserved'), []);
});

// ---------------------------------------------------------------------------
// Payload validation — fail closed
// ---------------------------------------------------------------------------

test('an undeclared payload field is refused rather than dropped', () => {
  const definition = new EventTypeRegistry(TYPES).require('configuration.version_published', 1);

  assert.throws(
    () =>
      assertValidPayload(definition, {
        version_id: 'ver-1',
        config_key: 'k',
        surprise: 'value',
      }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'invalid-payload');
      // Dropping it silently would let a producer believe it published something no consumer will
      // ever see, which surfaces later as data that was never there.
      assert.match((error as EventError).message, /does not declare field "surprise"/);
      return true;
    },
  );
});

test('a missing required field, and a field of the wrong type, are both refused', () => {
  const registry = new EventTypeRegistry(TYPES);
  const v2 = registry.require('configuration.version_published', 2);

  assert.throws(
    () => assertValidPayload(v2, { version_id: 'v', config_key: 'k' }),
    (error: unknown) => codeOf(error) === 'invalid-payload',
  );
  assert.throws(
    () => assertValidPayload(v2, { version_id: 'v', config_key: 'k', scope_level: 4 }),
    (error: unknown) => codeOf(error) === 'invalid-payload',
  );
  assert.throws(
    () =>
      assertValidPayload(v2, {
        version_id: 'v',
        config_key: 'k',
        scope_level: 'global',
        attempt_count: 1.5,
      }),
    (error: unknown) => codeOf(error) === 'invalid-payload',
    'an integer field may not hold a fraction',
  );
  assert.throws(
    () =>
      assertValidPayload(v2, {
        version_id: 'v',
        config_key: 'k',
        scope_level: 'global',
        is_rollback: 'yes',
      }),
    (error: unknown) => codeOf(error) === 'invalid-payload',
  );
  assert.throws(
    () => assertValidPayload(v2, { version_id: null, config_key: 'k', scope_level: 'g' }),
    (error: unknown) => codeOf(error) === 'invalid-payload',
    'a required field may not be null',
  );

  // Optional fields may be absent, and may be explicitly null.
  assertValidPayload(v2, { version_id: 'v', config_key: 'k', scope_level: 'global' });
  assertValidPayload(v2, {
    version_id: 'v',
    config_key: 'k',
    scope_level: 'global',
    scope_id: null,
  });
});

test('a credential-shaped value is refused even under an innocent field name', async () => {
  const { service, repository } = build();

  const secrets = [
    'sk-abcdefghijklmnopqrstuvwx',
    'ghp_abcdefghijklmnopqrstuvwxyz12',
    'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----',
    'postgresql://jaya:hunter2@db.internal:5432/jaya',
  ];

  for (const secret of secrets) {
    await assert.rejects(
      service.publish(publishRequest({ payload: { version_id: secret, config_key: 'k' } })),
      (error: unknown) => codeOf(error) === 'secret-bearing-payload',
      `${secret.slice(0, 12)}… is a credential whatever the field is called`,
    );
  }
  assert.equal(repository.events().length, 0, 'none of them reached the log');
});

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

test('publishing appends the event and fans out one delivery per subscriber, atomically', async () => {
  const { service, repository } = build();

  const result = await service.publish(publishRequest({ eventId: 'evt-a', idempotencyKey: 'k-a' }));

  assert.equal(result.deduplicated, false);
  assert.equal(result.event.eventId, 'evt-a');
  assert.equal(result.event.recordedAt, '2026-03-01T10:00:00Z');
  assert.equal(result.event.causationId, null);
  assert.deepEqual(
    result.deliveries.map((delivery) => delivery.subscription),
    ['audit-writer', 'search-indexer'],
  );
  for (const delivery of result.deliveries) {
    assert.equal(delivery.status, 'pending');
    assert.equal(delivery.attempts, 0);
    assert.equal(delivery.generation, 1);
    assert.equal(delivery.claimToken, null);
  }
  assert.equal(repository.transactionsCommitted, 1, 'event and deliveries share one transaction');
});

test('a failed publication leaves neither event nor deliveries', async () => {
  const { service, repository } = build();
  await service.publish(publishRequest({ eventId: 'evt-a', idempotencyKey: 'k-a' }));

  await assert.rejects(
    service.publish(publishRequest({ eventId: 'evt-a', idempotencyKey: 'k-b' })),
    (error: unknown) => codeOf(error) === 'duplicate-event-id',
  );

  assert.equal(repository.events().length, 1);
  assert.equal(repository.deliveries().length, 2, 'no orphan deliveries from the failed attempt');
  assert.ok(repository.transactionsRolledBack >= 1);
});

test('an identical retry returns the original event and adds no deliveries', async () => {
  const { service, repository } = build();
  const request = publishRequest({ eventId: 'evt-a', idempotencyKey: 'k-a' });
  const first = await service.publish(request);
  const retry = await service.publish({ ...request });

  assert.equal(retry.deduplicated, true);
  assert.equal(retry.event.eventId, first.event.eventId);
  assert.equal(retry.deliveries.length, 2, 'the original deliveries, not a second set');
  assert.equal(repository.deliveries().length, 2);
});

test('an idempotency key reused for different content is refused', async () => {
  const { service } = build();
  await service.publish(publishRequest({ eventId: 'evt-a', idempotencyKey: 'k-a' }));

  await assert.rejects(
    service.publish(
      publishRequest({
        eventId: 'evt-a',
        idempotencyKey: 'k-a',
        payload: { version_id: 'ver-2', config_key: 'session.timeout_seconds' },
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match((error as EventError).message, /payloadFingerprint/);
      return true;
    },
  );
});

test('the payload is fingerprinted, and the fingerprint does not depend on key order', async () => {
  const { service } = build();
  const result = await service.publish(
    publishRequest({ payload: { version_id: 'v', config_key: 'k' } }),
  );

  assert.match(result.event.payloadFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    fingerprintPayload({ version_id: 'v', config_key: 'k' }),
    fingerprintPayload({ config_key: 'k', version_id: 'v' }),
    'the same payload written in a different order is the same payload',
  );
  assert.notEqual(
    fingerprintPayload({ version_id: 'v', config_key: 'k' }),
    fingerprintPayload({ version_id: 'v', config_key: 'k2' }),
  );
});

test('a stored payload is frozen, so a consumer cannot edit the evidence it was handed', async () => {
  const { service } = build();
  const result = await service.publish(publishRequest());

  assert.throws(() => {
    (result.event.payload as Record<string, unknown>).version_id = 'tampered';
  }, TypeError);
  assert.equal(result.event.payload.version_id, 'ver-1');
});

test('an event may not be recorded before it happened', async () => {
  const { service } = build();
  await assert.rejects(
    service.publish(
      publishRequest({ occurredAt: '2026-03-01T10:00:01Z', now: '2026-03-01T10:00:00Z' }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-envelope');
      assert.match((error as EventError).message, /cannot be recorded before it happened/);
      return true;
    },
  );
});

test('malformed identifiers and instants fail closed', async () => {
  const { service, repository } = build();

  const malformed = [
    publishRequest({ eventId: '' }),
    publishRequest({ eventId: 'has spaces' }),
    publishRequest({ correlationId: 'x'.repeat(200) }),
    publishRequest({ causationId: 'bad/id' }),
    publishRequest({ idempotencyKey: '#nope' }),
    publishRequest({ occurredAt: '2026-02-30T00:00:00Z' }),
    publishRequest({ occurredAt: 'yesterday' }),
    publishRequest({ now: '2026-03-01 10:00:00' }),
  ];

  for (const request of malformed) {
    await assert.rejects(
      service.publish(request),
      (error: unknown) => codeOf(error) === 'malformed-envelope',
      `${JSON.stringify({ id: request.eventId, at: request.occurredAt })} must be refused`,
    );
  }
  assert.equal(repository.events().length, 0);
});

test('an unregistered type or version never reaches the log', async () => {
  const { service, repository } = build();

  await assert.rejects(
    service.publish(publishRequest({ type: 'inventory.item_reserved' })),
    (error: unknown) => codeOf(error) === 'unknown-event-type',
  );
  await assert.rejects(
    service.publish(publishRequest({ schemaVersion: 9 })),
    (error: unknown) => codeOf(error) === 'unknown-schema-version',
  );
  assert.equal(repository.events().length, 0);
});

test('a unit may not publish the events another unit owns', async () => {
  const { service } = build();
  await assert.rejects(
    service.publish(publishRequest({ producer: 'K-09', actor: { id: 'K-09', kind: 'system' } })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'producer-not-permitted');
      assert.match((error as EventError).message, /owned by K-05/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// AI has no authority here
// ---------------------------------------------------------------------------

test('AI cannot publish an event, by origin or by actor', async () => {
  const { service, repository } = build();

  await assert.rejects(
    service.publish(publishRequest({ origin: 'ai-suggested' })),
    (error: unknown) => codeOf(error) === 'origin-not-permitted',
  );
  await assert.rejects(
    service.publish(publishRequest({ actor: AI })),
    (error: unknown) => codeOf(error) === 'ai-not-permitted',
  );
  // Both together, in case one check were mistaken for the other.
  await assert.rejects(
    service.publish(publishRequest({ actor: AI, origin: 'ai-suggested' })),
    (error: unknown) => codeOf(error) === 'ai-not-permitted',
  );

  assert.equal(repository.events().length, 0, 'nothing AI touched reached the log');
});

test('a system actor may not claim a human decided', async () => {
  const { service } = build();
  await assert.rejects(
    service.publish(publishRequest({ origin: 'human', actor: SYSTEM })),
    (error: unknown) => codeOf(error) === 'origin-not-permitted',
  );

  const result = await service.publish(
    publishRequest({ origin: 'human', actor: { id: 'ops-alice', kind: 'operator' } }),
  );
  assert.equal(result.event.origin, 'human');
});

test('every stored event carries a permitted origin', async () => {
  const { service, repository } = build();
  await service.publish(publishRequest());
  await service.publish(
    publishRequest({ origin: 'human', actor: { id: 'ops-alice', kind: 'operator' } }),
  );

  for (const event of repository.events()) {
    assert.ok(['system', 'human'].includes(event.origin), `${event.origin} is not publishable`);
  }
});
