/**
 * Shared fixtures for the K-09 suites (FND-003c).
 *
 * The actions here are invented for testing and belong to no business module. FND-003c delivers the
 * mechanism; registering a real action on a unit's behalf would be claiming that unit is audited
 * when it records nothing. They name real manifest owners only because the registry requires one —
 * which is itself among the things being tested.
 */

import {
  AuditActionRegistry,
  AuditService,
  InMemoryAuditRepository,
  type AuditActionDefinition,
  type AuditActor,
  type RecordRequest,
} from '../../kernel/audit-foundation/index.ts';

export const ACTIONS: readonly AuditActionDefinition[] = [
  {
    action: 'configuration.version_published',
    owner: 'K-05',
    authority: 'business-authoritative',
    description: 'A configuration version was made active.',
    resourceTypes: ['configuration_version'],
    evidenceFields: [
      {
        name: 'config_key',
        kind: 'string',
        required: true,
        classification: 'internal',
        description: 'Which key changed.',
      },
      {
        name: 'scope_level',
        kind: 'string',
        required: false,
        classification: 'internal',
        description: 'Scope the change applied at.',
      },
      {
        name: 'previous_version_id',
        kind: 'string',
        required: false,
        classification: 'internal',
        description: 'The version it replaced.',
      },
      {
        name: 'attempt_count',
        kind: 'integer',
        required: false,
        classification: 'internal',
        description: 'How many attempts it took.',
      },
      {
        name: 'was_rollback',
        kind: 'boolean',
        required: false,
        classification: 'internal',
        description: 'Whether this reversed an earlier change.',
      },
    ],
  },
  {
    action: 'events.replay_ordered',
    owner: 'K-08',
    authority: 'security-sensitive',
    description: 'An operator ordered an event redelivered.',
    resourceTypes: ['event_delivery'],
    evidenceFields: [
      {
        name: 'subscription',
        kind: 'string',
        required: true,
        classification: 'internal',
        description: 'Which consumer.',
      },
      {
        name: 'receipt_discarded',
        kind: 'boolean',
        required: true,
        classification: 'internal',
        description: 'Whether the consumer receipt was dropped.',
      },
      {
        name: 'operator_note',
        kind: 'string',
        required: false,
        classification: 'personal',
        description: 'Free text from the operator, which may name a person.',
      },
    ],
  },
];

/** An action with no declared resource types, so any owned type is permitted. */
export const OPEN_ACTION: AuditActionDefinition = {
  action: 'platform.migration_applied',
  owner: 'platform',
  authority: 'security-sensitive',
  description: 'A migration was applied to a database.',
  resourceTypes: [],
  evidenceFields: [
    {
      name: 'migration_version',
      kind: 'string',
      required: true,
      classification: 'public',
      description: 'Which migration.',
    },
    {
      name: 'checksum',
      kind: 'string',
      required: false,
      classification: 'restricted',
      description: 'The recorded checksum.',
    },
  ],
};

export const OPERATOR: AuditActor = {
  kind: 'human',
  id: 'ops-alice',
  authentication: 'unauthenticated',
  sessionId: null,
};

export const SYSTEM: AuditActor = {
  kind: 'system',
  id: 'K-05',
  authentication: 'unauthenticated',
  sessionId: null,
};

export const AI: AuditActor = {
  kind: 'ai',
  id: 'ai-assistant',
  authentication: 'unauthenticated',
  sessionId: null,
};

export interface Harness {
  readonly service: AuditService;
  readonly repository: InMemoryAuditRepository;
  readonly registry: AuditActionRegistry;
}

export function build(actions: readonly AuditActionDefinition[] = ACTIONS): Harness {
  const registry = new AuditActionRegistry(actions);
  const repository = new InMemoryAuditRepository();
  return { service: new AuditService(registry, repository), repository, registry };
}

let sequence = 0;

export function recordRequest(overrides: Partial<RecordRequest> = {}): RecordRequest {
  sequence += 1;
  return {
    recordId: `aud-${sequence}`,
    action: 'configuration.version_published',
    recordedAt: '2026-04-01T12:00:00Z',
    actor: SYSTEM,
    resource: { owner: 'K-05', type: 'configuration_version', id: 'ver-1' },
    outcome: 'succeeded',
    reason: 'published by the configuration service',
    correlationId: `corr-${sequence}`,
    causationId: null,
    evidence: { config_key: 'session.timeout_seconds' },
    idempotencyKey: `idem-${sequence}`,
    ...overrides,
  };
}
