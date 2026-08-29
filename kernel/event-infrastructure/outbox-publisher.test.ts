/**
 * K-08 outbox-to-event adapter tests (FND-003d).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { EventServicePublisher } from './outbox-publisher.ts';
import { EventService, EventTypeRegistry, SubscriptionRegistry } from './index.ts';
import { InMemoryEventRepository } from './repository.ts';

const DEFINITION = {
  type: 'configuration.version_published',
  schemaVersion: 1,
  owner: 'K-05',
  description: 'A configuration version became active.',
  payloadFields: [{ name: 'version_id', kind: 'string', required: true, description: 'id' }],
} as const;

const PUBLISH_REQUEST = {
  eventId: 'ev-1',
  type: 'configuration.version_published',
  schemaVersion: 1,
  occurredAt: '2026-01-01T00:00:00Z',
  recordedAt: '2026-01-01T00:00:00Z',
  producer: 'K-05',
  correlationId: 'corr-1',
  causationId: null,
  payload: { version_id: 'ver-1' },
  idempotencyKey: 'idem-1',
  origin: 'system',
  actor: { kind: 'system', id: 'K-05' },
  now: '2026-01-01T00:00:00Z',
} as const;

test('the adapter forwards an outbox payload to EventService.publish', async () => {
  const repository = new InMemoryEventRepository();
  const types = new EventTypeRegistry([DEFINITION]);
  const service = new EventService(types, new SubscriptionRegistry([], types), repository);
  const adapter = new EventServicePublisher(service);

  const result = await adapter.publish(PUBLISH_REQUEST);

  assert.equal(repository.events().length, 1);
  assert.equal((result as { deduplicated: boolean }).deduplicated, false);
});

test('a malformed payload is refused by K-08, not by the adapter', async () => {
  const service = new EventService(
    new EventTypeRegistry([DEFINITION]),
    new SubscriptionRegistry([], new EventTypeRegistry([DEFINITION])),
    new InMemoryEventRepository(),
  );
  const adapter = new EventServicePublisher(service);

  await assert.rejects(
    () => adapter.publish({ ...PUBLISH_REQUEST, payload: { wrong: 'value' } }),
    /payload/,
  );
});
