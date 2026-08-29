/**
 * K-05 Configuration — outbox wiring tests (FND-003d).
 *
 * A publication must append an event and an audit record to K-05's outbox inside the same
 * transaction. A relay must then be able to read those rows and dispatch them to K-08 Event
 * Infrastructure and K-09 Audit Foundation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuditActionRegistry,
  AuditService,
  InMemoryAuditRepository,
} from '../kernel/audit-foundation/index.ts';
import {
  CONFIGURATION_VERSION_PUBLISHED_ACTION,
  CONFIGURATION_VERSION_PUBLISHED_EVENT,
  ConfigurationRegistry,
  ConfigurationService,
  GLOBAL_SCOPE,
  InMemoryConfigurationRepository,
} from '../kernel/configuration/index.ts';
import {
  EventService,
  EventTypeRegistry,
  InMemoryEventRepository,
  SubscriptionRegistry,
} from '../kernel/event-infrastructure/index.ts';
import { runOutboxRelay } from '../platform/outbox/relay.ts';

const KEYS = [
  {
    id: 'session.timeout_seconds',
    description: 'How long an idle session survives.',
    schema: { kind: 'duration-seconds', minimum: 60, maximum: 86_400 },
    scopes: ['global', 'tenant'],
  },
] as const;

const build = () => {
  const eventsRepository = new InMemoryEventRepository();
  const auditRepository = new InMemoryAuditRepository();
  const configRepository = new InMemoryConfigurationRepository();

  const eventService = new EventService(
    new EventTypeRegistry([CONFIGURATION_VERSION_PUBLISHED_EVENT]),
    new SubscriptionRegistry([], new EventTypeRegistry([CONFIGURATION_VERSION_PUBLISHED_EVENT])),
    eventsRepository,
  );

  const auditService = new AuditService(
    new AuditActionRegistry([CONFIGURATION_VERSION_PUBLISHED_ACTION]),
    auditRepository,
  );

  const configService = new ConfigurationService(new ConfigurationRegistry(KEYS), configRepository);

  return {
    configService,
    configRepository,
    eventService,
    eventsRepository,
    auditService,
    auditRepository,
  };
};

test('publishing configuration appends an event and an audit record to the outbox', async () => {
  const { configService, configRepository } = build();

  await configService.publish({
    key: 'session.timeout_seconds',
    scope: GLOBAL_SCOPE,
    value: 900,
    effectiveFrom: '2026-01-01T00:00:00Z',
    expectedActiveVersionId: null,
    idempotencyKey: 'idem-1',
    versionId: 'ver-1',
    origin: 'human',
    authorityLevel: 'global',
    now: '2026-01-01T00:00:00Z',
  });

  const outbox = configRepository.outbox().entries();
  assert.equal(outbox.length, 2);
  assert.equal(outbox[0]?.kind, 'event');
  assert.equal(outbox[1]?.kind, 'audit');
});

test('the relay dispatches configuration outbox rows to event and audit services', async () => {
  const {
    configService,
    configRepository,
    eventService,
    eventsRepository,
    auditService,
    auditRepository,
  } = build();

  await configService.publish({
    key: 'session.timeout_seconds',
    scope: GLOBAL_SCOPE,
    value: 900,
    effectiveFrom: '2026-01-01T00:00:00Z',
    expectedActiveVersionId: null,
    idempotencyKey: 'idem-1',
    versionId: 'ver-1',
    origin: 'human',
    authorityLevel: 'global',
    now: '2026-01-01T00:00:00Z',
  });

  const result = await runOutboxRelay(
    {
      sources: [configRepository.outbox()],
      events: eventService,
      audit: auditService,
    },
    '2026-01-01T00:00:01Z',
  );

  assert.equal(result.dispatched, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);

  const events = eventsRepository.events();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'configuration.version_published');

  const records = auditRepository.records();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.action, 'configuration.version_published');
});
