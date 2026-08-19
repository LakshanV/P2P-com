/**
 * Shared fixtures for the K-08 suites (FND-003b).
 *
 * The event types here are deliberately invented for testing and belong to no business module:
 * FND-003b delivers the infrastructure, and registering a real business event would be publishing
 * a contract for a module that does not exist. They are owned by manifest units only because the
 * registry requires a real owner — which is itself one of the things being tested.
 */

import {
  EventTypeRegistry,
  InMemoryEventRepository,
  EventService,
  SubscriptionRegistry,
  type Actor,
  type EventTypeDefinition,
  type PublishRequest,
  type RetryPolicy,
  type SubscriptionDefinition,
} from '../../kernel/event-infrastructure/index.ts';

export const TYPES: readonly EventTypeDefinition[] = [
  {
    type: 'configuration.version_published',
    schemaVersion: 1,
    owner: 'K-05',
    description: 'A configuration version became active.',
    payloadFields: [
      { name: 'version_id', kind: 'string', required: true, description: 'The version.' },
      { name: 'config_key', kind: 'string', required: true, description: 'Which key.' },
      { name: 'scope_level', kind: 'string', required: false, description: 'Scope level.' },
    ],
  },
  {
    type: 'configuration.version_published',
    schemaVersion: 2,
    owner: 'K-05',
    description: 'A configuration version became active, now carrying the scope id.',
    payloadFields: [
      { name: 'version_id', kind: 'string', required: true, description: 'The version.' },
      { name: 'config_key', kind: 'string', required: true, description: 'Which key.' },
      { name: 'scope_level', kind: 'string', required: true, description: 'Scope level.' },
      { name: 'scope_id', kind: 'string', required: false, description: 'Scope id.' },
      { name: 'attempt_count', kind: 'integer', required: false, description: 'Attempts.' },
      { name: 'is_rollback', kind: 'boolean', required: false, description: 'A rollback?' },
    ],
  },
];

export const SUBSCRIPTIONS: readonly SubscriptionDefinition[] = [
  {
    subscription: 'audit-writer',
    owner: 'K-09',
    types: ['configuration.version_published'],
    description: 'Records configuration changes in the audit trail.',
  },
  {
    subscription: 'search-indexer',
    owner: 'K-15',
    types: ['configuration.version_published'],
    description: 'Keeps the search index current.',
  },
];

export const SYSTEM: Actor = { id: 'K-05', kind: 'system' };
export const WORKER: Actor = { id: 'worker-1', kind: 'system' };
export const OPERATOR: Actor = { id: 'ops-alice', kind: 'operator' };
export const AI: Actor = { id: 'ai-suggester', kind: 'ai' };

export const FAST_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseBackoffSeconds: 10,
  maxBackoffSeconds: 60,
  leaseSeconds: 30,
};

export interface Harness {
  readonly service: EventService;
  readonly repository: InMemoryEventRepository;
  readonly types: EventTypeRegistry;
  readonly subscriptions: SubscriptionRegistry;
}

export function build(policy?: RetryPolicy): Harness {
  const types = new EventTypeRegistry(TYPES);
  const subscriptions = new SubscriptionRegistry(SUBSCRIPTIONS, types);
  const repository = new InMemoryEventRepository();
  return {
    service: new EventService(types, subscriptions, repository, policy ?? FAST_POLICY),
    repository,
    types,
    subscriptions,
  };
}

let sequence = 0;

export function publishRequest(overrides: Partial<PublishRequest> = {}): PublishRequest {
  sequence += 1;
  return {
    eventId: `evt-${sequence}`,
    type: 'configuration.version_published',
    schemaVersion: 1,
    occurredAt: '2026-03-01T10:00:00Z',
    producer: 'K-05',
    correlationId: `corr-${sequence}`,
    causationId: null,
    payload: { version_id: 'ver-1', config_key: 'session.timeout_seconds' },
    idempotencyKey: `idem-${sequence}`,
    origin: 'system',
    actor: SYSTEM,
    now: '2026-03-01T10:00:00Z',
    ...overrides,
  };
}
