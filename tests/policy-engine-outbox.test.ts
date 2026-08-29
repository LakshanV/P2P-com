/**
 * K-06 Policy Engine — outbox wiring tests (FND-003d).
 *
 * Publishing, activating and retiring a policy must each append an event and an audit record to
 * K-06's outbox inside the same write transaction. A relay must then be able to read those rows and
 * dispatch them to K-08 Event Infrastructure and K-09 Audit Foundation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuditActionRegistry,
  AuditService,
  InMemoryAuditRepository,
} from '../kernel/audit-foundation/index.ts';
import {
  InMemoryEventRepository,
  EventService,
  EventTypeRegistry,
  SubscriptionRegistry,
} from '../kernel/event-infrastructure/index.ts';
import {
  InMemoryPolicyRepository,
  POLICY_ACTIVATED_ACTION,
  POLICY_ACTIVATED_EVENT,
  POLICY_RETIRED_ACTION,
  POLICY_RETIRED_EVENT,
  POLICY_VERSION_PUBLISHED_ACTION,
  POLICY_VERSION_PUBLISHED_EVENT,
  PolicyService,
} from '../kernel/policy-engine/index.ts';
import { runOutboxRelay } from '../platform/outbox/relay.ts';

import { AUTHORITY, FixedClock, POLICY, draftRequest, nextId } from './helpers/policy-fixtures.ts';

const buildWithRelay = () => {
  const eventsRepository = new InMemoryEventRepository();
  const auditRepository = new InMemoryAuditRepository();
  const policyRepository = new InMemoryPolicyRepository();

  const eventTypes = new EventTypeRegistry([
    POLICY_VERSION_PUBLISHED_EVENT,
    POLICY_ACTIVATED_EVENT,
    POLICY_RETIRED_EVENT,
  ]);
  const eventService = new EventService(
    eventTypes,
    new SubscriptionRegistry([], eventTypes),
    eventsRepository,
  );

  const auditService = new AuditService(
    new AuditActionRegistry([
      POLICY_VERSION_PUBLISHED_ACTION,
      POLICY_ACTIVATED_ACTION,
      POLICY_RETIRED_ACTION,
    ]),
    auditRepository,
  );

  const clock = new FixedClock();
  const service = new PolicyService({
    repository: policyRepository,
    clock,
    authority: {
      authorityId: AUTHORITY,
      permitsAuthoring: () => true,
    },
  });

  return {
    service,
    policyRepository,
    eventService,
    eventsRepository,
    auditService,
    auditRepository,
  };
};

test('publishing a policy appends an event and an audit row to the outbox', async () => {
  const { service, policyRepository } = buildWithRelay();

  const drafted = await service.draft(draftRequest());
  await service.publish({
    policyVersionId: nextId('polver'),
    draftId: drafted.draft.draftId,
    idempotencyKey: nextId('idem'),
  });

  const outbox = policyRepository.outbox().entries();
  assert.equal(outbox.length, 2);
  assert.equal(outbox[0]?.kind, 'event');
  assert.equal(outbox[1]?.kind, 'audit');
  assert.equal((outbox[0]?.payload as { type?: string }).type, 'policy.version_published');
  assert.equal((outbox[1]?.payload as { action?: string }).action, 'policy.version_published');
});

test('activating a policy appends an event and an audit row to the outbox', async () => {
  const { service, policyRepository } = buildWithRelay();

  const drafted = await service.draft(draftRequest());
  const published = await service.publish({
    policyVersionId: nextId('polver'),
    draftId: drafted.draft.draftId,
    idempotencyKey: nextId('idem'),
  });
  await service.activate({
    activationId: nextId('act'),
    policyVersionId: published.version.policyVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  const outbox = policyRepository.outbox().entries();
  assert.equal(outbox.length, 4);
  assert.equal(outbox[2]?.kind, 'event');
  assert.equal(outbox[3]?.kind, 'audit');
  assert.equal((outbox[2]?.payload as { type?: string }).type, 'policy.activated');
  assert.equal((outbox[3]?.payload as { action?: string }).action, 'policy.activated');
});

test('retiring a policy appends an event and an audit row to the outbox', async () => {
  const { service, policyRepository } = buildWithRelay();

  const drafted = await service.draft(draftRequest());
  const published = await service.publish({
    policyVersionId: nextId('polver'),
    draftId: drafted.draft.draftId,
    idempotencyKey: nextId('idem'),
  });
  await service.activate({
    activationId: nextId('act'),
    policyVersionId: published.version.policyVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });
  await service.retire({
    retirementId: nextId('ret'),
    policyKey: POLICY,
    reason: 'the commission model moved to the new tier structure',
    idempotencyKey: nextId('idem'),
  });

  const outbox = policyRepository.outbox().entries();
  assert.equal(outbox.length, 6);
  assert.equal(outbox[4]?.kind, 'event');
  assert.equal(outbox[5]?.kind, 'audit');
  assert.equal((outbox[4]?.payload as { type?: string }).type, 'policy.retired');
  assert.equal((outbox[5]?.payload as { action?: string }).action, 'policy.retired');
});

test('the relay dispatches policy outbox rows to event and audit services', async () => {
  const {
    service,
    policyRepository,
    eventService,
    eventsRepository,
    auditService,
    auditRepository,
  } = buildWithRelay();

  const drafted = await service.draft(draftRequest());
  const published = await service.publish({
    policyVersionId: nextId('polver'),
    draftId: drafted.draft.draftId,
    idempotencyKey: nextId('idem'),
  });
  await service.activate({
    activationId: nextId('act'),
    policyVersionId: published.version.policyVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });
  await service.retire({
    retirementId: nextId('ret'),
    policyKey: POLICY,
    reason: 'the commission model moved to the new tier structure',
    idempotencyKey: nextId('idem'),
  });

  const result = await runOutboxRelay(
    {
      sources: [policyRepository.outbox()],
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
  assert.ok(events.some((event) => event.type === 'policy.version_published'));
  assert.ok(events.some((event) => event.type === 'policy.activated'));
  assert.ok(events.some((event) => event.type === 'policy.retired'));

  const records = auditRepository.records();
  assert.equal(records.length, 3);
  assert.ok(records.some((record) => record.action === 'policy.version_published'));
  assert.ok(records.some((record) => record.action === 'policy.activated'));
  assert.ok(records.some((record) => record.action === 'policy.retired'));
});
