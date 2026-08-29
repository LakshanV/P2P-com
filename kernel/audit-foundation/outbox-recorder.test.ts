/**
 * K-09 outbox-to-audit adapter tests (FND-003d).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { AuditServiceRecorder } from './outbox-recorder.ts';
import { AuditActionRegistry, AuditService } from './index.ts';
import { InMemoryAuditRepository } from './repository.ts';

const ACTION = {
  action: 'configuration.version_published',
  owner: 'K-05',
  authority: 'business-authoritative',
  description: 'A configuration version was activated.',
  resourceTypes: ['configuration_version'],
  evidenceFields: [
    {
      name: 'version_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'id',
    },
  ],
} as const;

const RECORD_REQUEST = {
  recordId: 'rec-1',
  action: 'configuration.version_published',
  recordedAt: '2026-01-01T00:00:00Z',
  actor: {
    kind: 'system',
    id: 'K-05',
    authentication: 'unauthenticated',
    sessionId: null,
  },
  resource: { owner: 'K-05', type: 'configuration_version', id: 'ver-1' },
  outcome: 'succeeded',
  reason: 'published',
  correlationId: 'corr-1',
  causationId: null,
  evidence: { version_id: 'ver-1' },
  idempotencyKey: 'idem-1',
} as const;

test('the adapter forwards an outbox payload to AuditService.record', async () => {
  const repository = new InMemoryAuditRepository();
  const service = new AuditService(new AuditActionRegistry([ACTION]), repository);
  const adapter = new AuditServiceRecorder(service);

  const result = await adapter.record(RECORD_REQUEST);

  assert.equal(repository.records().length, 1);
  assert.equal((result as { deduplicated: boolean }).deduplicated, false);
});

test('a malformed payload is refused by K-09, not by the adapter', async () => {
  const service = new AuditService(
    new AuditActionRegistry([ACTION]),
    new InMemoryAuditRepository(),
  );
  const adapter = new AuditServiceRecorder(service);

  await assert.rejects(
    () => adapter.record({ ...RECORD_REQUEST, evidence: { wrong: 'value' } }),
    /evidence/,
  );
});
