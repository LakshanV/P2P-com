/**
 * K-11 Commerce Unit Registry — outbox wiring tests (FND-003d).
 *
 * Publishing, activating and retiring a commerce unit type must each append an event and an audit
 * record to K-11's outbox inside the same transaction. A relay must then be able to read those rows
 * and dispatch them to K-08 Event Infrastructure and K-09 Audit Foundation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuditActionRegistry,
  AuditService,
  InMemoryAuditRepository,
} from '../kernel/audit-foundation/index.ts';
import {
  COMMERCE_UNIT_ACTIVATED_ACTION,
  COMMERCE_UNIT_ACTIVATED_EVENT,
  COMMERCE_UNIT_RETIRED_ACTION,
  COMMERCE_UNIT_RETIRED_EVENT,
  COMMERCE_UNIT_VERSION_PUBLISHED_ACTION,
  COMMERCE_UNIT_VERSION_PUBLISHED_EVENT,
  InMemoryCommerceUnitRepository,
} from '../kernel/commerce-unit-registry/index.ts';
import {
  EventService,
  EventTypeRegistry,
  InMemoryEventRepository,
  SubscriptionRegistry,
} from '../kernel/event-infrastructure/index.ts';
import { runOutboxRelay } from '../platform/outbox/relay.ts';

import { GOODS_MEASURES, ROOT, build, nextId } from './helpers/commerce-unit-fixtures.ts';

const buildOutboxHarness = () => {
  const eventsRepository = new InMemoryEventRepository();
  const auditRepository = new InMemoryAuditRepository();
  const commerceRepository = new InMemoryCommerceUnitRepository();

  const eventTypes = new EventTypeRegistry([
    COMMERCE_UNIT_VERSION_PUBLISHED_EVENT,
    COMMERCE_UNIT_ACTIVATED_EVENT,
    COMMERCE_UNIT_RETIRED_EVENT,
  ]);

  const eventService = new EventService(
    eventTypes,
    new SubscriptionRegistry([], eventTypes),
    eventsRepository,
  );

  const auditService = new AuditService(
    new AuditActionRegistry([
      COMMERCE_UNIT_VERSION_PUBLISHED_ACTION,
      COMMERCE_UNIT_ACTIVATED_ACTION,
      COMMERCE_UNIT_RETIRED_ACTION,
    ]),
    auditRepository,
  );

  const { service: commerceService } = build({ repository: commerceRepository });

  return {
    commerceService,
    commerceRepository,
    eventService,
    eventsRepository,
    auditService,
    auditRepository,
  };
};

test('publishing a commerce unit type appends an event and an audit row to the outbox', async () => {
  const { commerceService, commerceRepository } = buildOutboxHarness();

  await commerceService.publish({
    typeVersionId: nextId('typever'),
    typeKey: ROOT,
    kind: 'new-product',
    measures: GOODS_MEASURES,
    idempotencyKey: nextId('idem'),
  });

  const outbox = commerceRepository.outbox().entries();
  assert.equal(outbox.length, 2);
  assert.equal(outbox[0]?.kind, 'event');
  assert.equal(outbox[1]?.kind, 'audit');
});

test('activating a commerce unit type appends an event and an audit row to the outbox', async () => {
  const { commerceService, commerceRepository } = buildOutboxHarness();

  const published = await commerceService.publish({
    typeVersionId: nextId('typever'),
    typeKey: ROOT,
    kind: 'new-product',
    measures: GOODS_MEASURES,
    idempotencyKey: nextId('idem'),
  });

  await commerceService.activate({
    activationId: nextId('act'),
    typeVersionId: published.version.typeVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  const outbox = commerceRepository.outbox().entries();
  assert.equal(outbox.length, 4);
  assert.equal(outbox[2]?.kind, 'event');
  assert.equal(outbox[3]?.kind, 'audit');
});

test('retiring a commerce unit type appends an event and an audit row to the outbox', async () => {
  const { commerceService, commerceRepository } = buildOutboxHarness();

  const published = await commerceService.publish({
    typeVersionId: nextId('typever'),
    typeKey: ROOT,
    kind: 'new-product',
    measures: GOODS_MEASURES,
    idempotencyKey: nextId('idem'),
  });

  await commerceService.activate({
    activationId: nextId('act'),
    typeVersionId: published.version.typeVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  await commerceService.retire({
    retirementId: nextId('ret'),
    typeKey: ROOT,
    reason: 'the category was folded into the new taxonomy',
    idempotencyKey: nextId('idem'),
  });

  const outbox = commerceRepository.outbox().entries();
  assert.equal(outbox.length, 6);
  assert.equal(outbox[4]?.kind, 'event');
  assert.equal(outbox[5]?.kind, 'audit');
});

test('deduplicated mutations do not append extra outbox rows', async () => {
  const { commerceService, commerceRepository } = buildOutboxHarness();

  const idempotencyKey = nextId('idem');
  const typeVersionId = nextId('typever');

  await commerceService.publish({
    typeVersionId,
    typeKey: ROOT,
    kind: 'new-product',
    measures: GOODS_MEASURES,
    idempotencyKey,
  });

  await commerceService.publish({
    typeVersionId,
    typeKey: ROOT,
    kind: 'new-product',
    measures: GOODS_MEASURES,
    idempotencyKey,
  });

  const outbox = commerceRepository.outbox().entries();
  assert.equal(outbox.length, 2, 'a retried publication must not append a second event and audit');
});

test('the relay dispatches commerce unit registry outbox rows to event and audit services', async () => {
  const {
    commerceService,
    commerceRepository,
    eventService,
    eventsRepository,
    auditService,
    auditRepository,
  } = buildOutboxHarness();

  const published = await commerceService.publish({
    typeVersionId: nextId('typever'),
    typeKey: ROOT,
    kind: 'new-product',
    measures: GOODS_MEASURES,
    idempotencyKey: nextId('idem'),
  });

  await commerceService.activate({
    activationId: nextId('act'),
    typeVersionId: published.version.typeVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  await commerceService.retire({
    retirementId: nextId('ret'),
    typeKey: ROOT,
    reason: 'the category was folded into the new taxonomy',
    idempotencyKey: nextId('idem'),
  });

  const result = await runOutboxRelay(
    {
      sources: [commerceRepository.outbox()],
      events: eventService,
      audit: auditService,
    },
    '2026-04-01T12:00:01Z',
  );

  assert.equal(result.dispatched, 6);
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);

  const events = eventsRepository.events();
  assert.equal(events.length, 3);
  assert.ok(events.some((event) => event.type === 'commerceunitregistry.version_published'));
  assert.ok(events.some((event) => event.type === 'commerceunitregistry.type_activated'));
  assert.ok(events.some((event) => event.type === 'commerceunitregistry.type_retired'));

  const records = auditRepository.records();
  assert.equal(records.length, 3);
  assert.ok(records.some((record) => record.action === 'commerceunitregistry.version_published'));
  assert.ok(records.some((record) => record.action === 'commerceunitregistry.type_activated'));
  assert.ok(records.some((record) => record.action === 'commerceunitregistry.type_retired'));
});
