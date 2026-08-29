/**
 * K-07 Feature Flags — outbox wiring tests (FND-003d).
 *
 * A publish, activation or retirement must append an event and an audit record to K-07's outbox
 * inside the same transaction. A relay must then be able to read those rows and dispatch them to
 * K-08 Event Infrastructure and K-09 Audit Foundation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuditActionRegistry,
  AuditService,
  InMemoryAuditRepository,
} from '../kernel/audit-foundation/index.ts';
import {
  FEATURE_FLAG_RETIRED_ACTION,
  FEATURE_FLAG_RETIRED_EVENT,
  FEATURE_FLAG_VERSION_ACTIVATED_ACTION,
  FEATURE_FLAG_VERSION_ACTIVATED_EVENT,
  FEATURE_FLAG_VERSION_PUBLISHED_ACTION,
  FEATURE_FLAG_VERSION_PUBLISHED_EVENT,
  FeatureFlagService,
  InMemoryFeatureFlagRepository,
} from '../kernel/feature-flags/index.ts';
import {
  EventService,
  EventTypeRegistry,
  InMemoryEventRepository,
  SubscriptionRegistry,
} from '../kernel/event-infrastructure/index.ts';
import { runOutboxRelay } from '../platform/outbox/relay.ts';

import {
  FLAG,
  FixedClock,
  RELEASE_CONSOLE,
  StubConfiguration,
  nextId,
  publishRequest,
  withActiveFlag,
} from './helpers/feature-flag-fixtures.ts';

const NOW = '2026-04-01T12:00:00Z';

const buildServices = () => {
  const eventsRepository = new InMemoryEventRepository();
  const auditRepository = new InMemoryAuditRepository();

  const eventTypes = new EventTypeRegistry([
    FEATURE_FLAG_VERSION_PUBLISHED_EVENT,
    FEATURE_FLAG_VERSION_ACTIVATED_EVENT,
    FEATURE_FLAG_RETIRED_EVENT,
  ]);
  const eventService = new EventService(
    eventTypes,
    new SubscriptionRegistry([], eventTypes),
    eventsRepository,
  );

  const auditService = new AuditService(
    new AuditActionRegistry([
      FEATURE_FLAG_VERSION_PUBLISHED_ACTION,
      FEATURE_FLAG_VERSION_ACTIVATED_ACTION,
      FEATURE_FLAG_RETIRED_ACTION,
    ]),
    auditRepository,
  );

  return { eventService, eventsRepository, auditService, auditRepository };
};

const buildFlagHarness = () => {
  const repository = new InMemoryFeatureFlagRepository();
  const clock = new FixedClock(NOW);
  const configuration = new StubConfiguration();
  const service = new FeatureFlagService({
    repository,
    clock,
    configuration,
    authority: RELEASE_CONSOLE,
  });
  return { service, repository, clock, configuration };
};

test('publishing a feature flag appends an event and an audit record to the outbox', async () => {
  const { service, repository } = buildFlagHarness();

  await service.publish(publishRequest());

  const outbox = repository.outbox().entries();
  assert.equal(outbox.length, 2);
  assert.equal(outbox[0]?.kind, 'event');
  assert.equal((outbox[0]?.payload as { type?: string }).type, 'featureflag.version_published');
  assert.equal(outbox[1]?.kind, 'audit');
  assert.equal((outbox[1]?.payload as { action?: string }).action, 'featureflag.version_published');
});

test('activating a feature flag appends an event and an audit record to the outbox', async () => {
  const { service, repository } = buildFlagHarness();
  const published = await service.publish(publishRequest());

  await service.activate({
    activationId: nextId('act'),
    flagVersionId: published.version.flagVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  const outbox = repository.outbox().entries();
  assert.equal(outbox.length, 4);
  const event = outbox[outbox.length - 2];
  const audit = outbox[outbox.length - 1];
  assert.equal(event?.kind, 'event');
  assert.equal((event?.payload as { type?: string }).type, 'featureflag.version_activated');
  assert.equal(audit?.kind, 'audit');
  assert.equal((audit?.payload as { action?: string }).action, 'featureflag.version_activated');
});

test('retiring a feature flag appends an event and an audit record to the outbox', async () => {
  const { harness } = await withActiveFlag(buildFlagHarness());
  const before = harness.repository.outbox().entries().length;

  await harness.service.retire({
    eventId: nextId('evt'),
    flagKey: FLAG,
    reason: 'feature is no longer needed',
    idempotencyKey: nextId('idem'),
  });

  const outbox = harness.repository.outbox().entries();
  assert.equal(outbox.length, before + 2);
  const event = outbox[outbox.length - 2];
  const audit = outbox[outbox.length - 1];
  assert.equal(event?.kind, 'event');
  assert.equal((event?.payload as { type?: string }).type, 'featureflag.retired');
  assert.equal(audit?.kind, 'audit');
  assert.equal((audit?.payload as { action?: string }).action, 'featureflag.retired');
});

test('the relay dispatches feature flag outbox rows to event and audit services', async () => {
  const { service, repository } = buildFlagHarness();
  const { eventService, eventsRepository, auditService, auditRepository } = buildServices();

  const published = await service.publish(publishRequest());
  await service.activate({
    activationId: nextId('act'),
    flagVersionId: published.version.flagVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });
  await service.retire({
    eventId: nextId('evt'),
    flagKey: FLAG,
    reason: 'feature is no longer needed',
    idempotencyKey: nextId('idem'),
  });

  const result = await runOutboxRelay(
    {
      sources: [repository.outbox()],
      events: eventService,
      audit: auditService,
    },
    NOW,
  );

  assert.equal(result.dispatched, 6);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);

  const events = eventsRepository.events();
  assert.equal(events.length, 3);
  const types = events.map((event) => event.type).sort();
  assert.deepEqual(types, [
    'featureflag.retired',
    'featureflag.version_activated',
    'featureflag.version_published',
  ]);

  const records = auditRepository.records();
  assert.equal(records.length, 3);
  const actions = records.map((record) => record.action).sort();
  assert.deepEqual(actions, [
    'featureflag.retired',
    'featureflag.version_activated',
    'featureflag.version_published',
  ]);
});
