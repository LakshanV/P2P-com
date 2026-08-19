/**
 * K-09 Audit Foundation — the record contract (FND-003c).
 *
 * An audit record is read once, years later, by somebody deciding whether to trust the system. Its
 * value is entirely in what could not have got into it, so almost everything here is a refusal.
 *
 * Three refusals are worth naming up front, because each protects something different:
 *
 *   - **AI may not author.** A fabricated record is indistinguishable from a real one to whoever
 *     reads it during an investigation.
 *   - **Unclassified evidence is refused, not stored.** A field nobody classified is a field
 *     nobody can decide about when an access layer finally exists.
 *   - **A claimed session is refused.** Nothing authenticates anybody yet, so a record asserting a
 *     verified actor would be lying to its own reader.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuditActionRegistry,
  AuditError,
  EVIDENCE_CLASSIFICATIONS,
  REDACTED,
  assertRegistrableAction,
  assertValidEvidence,
  fingerprintRecord,
} from '../kernel/audit-foundation/index.ts';
import type { AuditActionDefinition } from '../kernel/audit-foundation/index.ts';

import {
  ACTIONS,
  AI,
  OPEN_ACTION,
  OPERATOR,
  build,
  recordRequest,
} from './helpers/audit-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AuditError ? error.code : undefined;

const definition = (overrides: Partial<AuditActionDefinition> = {}): AuditActionDefinition => ({
  action: 'inventory.item_reserved',
  owner: 'K-05',
  authority: 'business-authoritative',
  description: 'An item was reserved.',
  resourceTypes: ['inventory_item'],
  evidenceFields: [
    {
      name: 'item_id',
      kind: 'string',
      required: true,
      classification: 'internal',
      description: 'Which item.',
    },
  ],
  ...overrides,
});

// ---------------------------------------------------------------------------
// The action registry
// ---------------------------------------------------------------------------

test('an unregistered action is refused with an explanation, not a default', () => {
  const registry = new AuditActionRegistry(ACTIONS);

  assert.throws(
    () => registry.require('inventory.item_reserved'),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unknown-action');
      assert.match((error as AuditError).message, /no declared evidence/);
      return true;
    },
  );
  assert.ok(registry.has('configuration.version_published'));
  assert.deepEqual(registry.actions(), [
    'configuration.version_published',
    'events.replay_ordered',
  ]);
});

test('an action with a bad name, no owner, no description or an unknown authority is refused', () => {
  for (const [why, overrides] of [
    ['not dotted', { action: 'ItemReserved' }],
    ['no subject and deed', { action: 'inventory' }],
    ['an owner absent from the manifest', { owner: 'K-99' }],
    ['no description', { description: '   ' }],
    [
      'an authority nobody defined',
      { authority: 'informational' as AuditActionDefinition['authority'] },
    ],
    ['a resource type that is not snake_case', { resourceTypes: ['InventoryItem'] }],
  ] as const) {
    assert.throws(
      () => assertRegistrableAction(definition(overrides)),
      (error: unknown) => codeOf(error) === 'unknown-action',
      `${why} must be refused`,
    );
  }
});

test('every evidence field must carry a classification', () => {
  assert.throws(
    () =>
      assertRegistrableAction(
        definition({
          evidenceFields: [
            {
              name: 'item_id',
              kind: 'string',
              required: true,
              classification: 'confidential' as never,
              description: 'x',
            },
          ],
        }),
      ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unclassified-evidence');
      assert.match((error as AuditError).message, /nobody classified/);
      return true;
    },
  );

  // Every declared classification is accepted, so the refusal above is about the unknown one.
  for (const classification of EVIDENCE_CLASSIFICATIONS) {
    assertRegistrableAction(
      definition({
        evidenceFields: [
          { name: 'item_id', kind: 'string', required: true, classification, description: 'x' },
        ],
      }),
    );
  }
});

test('an action that declares a credential field cannot be registered at all', () => {
  for (const name of ['password', 'api_key', 'session_token', 'user_access_key']) {
    assert.throws(
      () =>
        assertRegistrableAction(
          definition({
            evidenceFields: [
              {
                name,
                kind: 'string',
                required: true,
                classification: 'restricted',
                description: 'x',
              },
            ],
          }),
        ),
      (error: unknown) => {
        assert.equal(codeOf(error), 'secret-bearing-evidence');
        // Even `restricted` is not enough. An audit log outlives every other store.
        assert.match((error as AuditError).message, /no classification changes that/);
        return true;
      },
      `"${name}" must be refused`,
    );
  }
});

test('the registry reports a field classification, so a reader can decide about it', () => {
  const registry = new AuditActionRegistry(ACTIONS);

  assert.equal(
    registry.classificationOf('events.replay_ordered', 'operator_note'),
    'personal',
    'free text from an operator may name somebody',
  );
  assert.equal(registry.classificationOf('events.replay_ordered', 'subscription'), 'internal');
  assert.throws(
    () => registry.classificationOf('events.replay_ordered', 'nonexistent'),
    (error: unknown) => codeOf(error) === 'unclassified-evidence',
  );
});

// ---------------------------------------------------------------------------
// Evidence validation
// ---------------------------------------------------------------------------

test('an undeclared evidence field is refused rather than dropped', () => {
  const registry = new AuditActionRegistry(ACTIONS);
  const action = registry.require('configuration.version_published');

  assert.throws(
    () => assertValidEvidence(action, { config_key: 'k', surprise: 'value' }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unclassified-evidence');
      // Dropping it would mean a recorder believes it captured something the log does not hold,
      // which surfaces during an investigation, when it is far too late.
      assert.match((error as AuditError).message, /does not declare evidence field "surprise"/);
      return true;
    },
  );
});

test('missing required fields and wrong-typed values are refused', () => {
  const registry = new AuditActionRegistry(ACTIONS);
  const action = registry.require('configuration.version_published');

  assert.throws(
    () => assertValidEvidence(action, {}),
    (error: unknown) => codeOf(error) === 'invalid-evidence',
  );
  assert.throws(
    () => assertValidEvidence(action, { config_key: 42 }),
    (error: unknown) => codeOf(error) === 'invalid-evidence',
  );
  assert.throws(
    () => assertValidEvidence(action, { config_key: 'k', attempt_count: 1.5 }),
    (error: unknown) => codeOf(error) === 'invalid-evidence',
  );
  assert.throws(
    () => assertValidEvidence(action, { config_key: 'k', was_rollback: 'yes' }),
    (error: unknown) => codeOf(error) === 'invalid-evidence',
  );
  assert.throws(
    () => assertValidEvidence(action, { config_key: null }),
    (error: unknown) => codeOf(error) === 'invalid-evidence',
    'a required field may not be null',
  );

  // Optional fields may be absent or explicitly null.
  assertValidEvidence(action, { config_key: 'k' });
  assertValidEvidence(action, { config_key: 'k', scope_level: null });
});

test('a credential-shaped value is refused even under a declared, classified field', async () => {
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
      service.record(recordRequest({ evidence: { config_key: secret } })),
      (error: unknown) => codeOf(error) === 'secret-bearing-evidence',
      `${secret.slice(0, 12)}… is a credential wherever it is put`,
    );
  }
  assert.equal(repository.records().length, 0, 'none of them reached the log');
});

test('the documented alternative to a secret is accepted', async () => {
  // Refusing the value without offering a way to record that the field existed would push callers
  // into omitting it, which loses the more useful fact.
  const { service } = build();
  const result = await service.record(
    recordRequest({ evidence: { config_key: 'session.timeout_seconds', scope_level: REDACTED } }),
  );

  assert.equal(result.record.evidence.scope_level, REDACTED);
  assert.equal(REDACTED, '[redacted]');
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

test('a recorded action is stored exactly as given, with a content fingerprint', async () => {
  const { service, repository } = build();

  const result = await service.record(
    recordRequest({ recordId: 'aud-a', idempotencyKey: 'k-a', correlationId: 'corr-a' }),
  );

  assert.equal(result.deduplicated, false);
  assert.equal(result.record.recordId, 'aud-a');
  assert.equal(result.record.action, 'configuration.version_published');
  assert.equal(result.record.recordedAt, '2026-04-01T12:00:00Z');
  assert.equal(result.record.outcome, 'succeeded');
  assert.equal(result.record.causationId, null);
  assert.match(result.record.contentFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(repository.records().length, 1);
  assert.equal(repository.transactionsCommitted, 1);
});

test('the fingerprint covers the content and ignores how the evidence was written', async () => {
  const { service } = build();

  const first = await service.record(
    recordRequest({
      recordId: 'aud-a',
      idempotencyKey: 'k-a',
      correlationId: 'corr-a',
      evidence: { config_key: 'k', scope_level: 'global' },
    }),
  );
  const second = await service.record(
    recordRequest({
      recordId: 'aud-b',
      idempotencyKey: 'k-b',
      correlationId: 'corr-a',
      evidence: { scope_level: 'global', config_key: 'k' },
    }),
  );

  // Same content but a different record id, so the fingerprints differ — and the *evidence* half
  // is order-independent, which is what makes an idempotent retry comparable at all.
  assert.notEqual(first.record.contentFingerprint, second.record.contentFingerprint);
  assert.equal(
    fingerprintRecord({ ...first.record, recordId: 'aud-b', idempotencyKey: 'k-b' }),
    second.record.contentFingerprint,
    'only the id and key differ, so equalising them equalises the fingerprint',
  );
});

test('an identical retry returns the original record and writes nothing', async () => {
  const { service, repository } = build();
  const request = recordRequest({ recordId: 'aud-a', idempotencyKey: 'k-a' });

  const first = await service.record(request);
  const retry = await service.record({ ...request });

  assert.equal(retry.deduplicated, true);
  assert.equal(retry.record.recordId, first.record.recordId);
  assert.equal(retry.record.contentFingerprint, first.record.contentFingerprint);
  assert.equal(repository.records().length, 1, 'one action, one record');
});

test('a key reused for different content is refused, naming what differed', async () => {
  const { service, repository } = build();
  const request = recordRequest({ recordId: 'aud-a', idempotencyKey: 'k-a' });
  await service.record(request);

  await assert.rejects(
    service.record({ ...request, outcome: 'failed', reason: 'it did not work after all' }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match((error as AuditError).message, /outcome was "succeeded", now "failed"/);
      assert.match((error as AuditError).message, /attest to something that was never recorded/);
      return true;
    },
  );
  assert.equal(repository.records().length, 1);
});

test('a duplicate record id is refused even under a fresh key', async () => {
  const { service } = build();
  await service.record(recordRequest({ recordId: 'aud-a', idempotencyKey: 'k-a' }));

  await assert.rejects(
    service.record(recordRequest({ recordId: 'aud-a', idempotencyKey: 'k-b' })),
    (error: unknown) => codeOf(error) === 'duplicate-record-id',
  );
});

// ---------------------------------------------------------------------------
// Refusals that keep the log honest
// ---------------------------------------------------------------------------

test('AI may not author an audit record', async () => {
  const { service, repository } = build();

  await assert.rejects(service.record(recordRequest({ actor: AI })), (error: unknown) => {
    assert.equal(codeOf(error), 'ai-not-permitted');
    assert.match((error as AuditError).message, /may prompt a human or a deterministic system/);
    return true;
  });
  assert.equal(repository.records().length, 0);
});

test('a record may not claim a session or an authentication that never happened', async () => {
  const { service } = build();

  await assert.rejects(
    service.record(
      recordRequest({
        actor: { ...OPERATOR, sessionId: 'sess-1' },
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'actor-not-permitted');
      assert.match((error as AuditError).message, /K-02 Authentication does not exist/);
      return true;
    },
  );

  await assert.rejects(
    service.record(recordRequest({ actor: { ...OPERATOR, authentication: 'session' } })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'actor-not-permitted');
      assert.match((error as AuditError).message, /lies to whoever reads it later/);
      return true;
    },
  );
});

test('a unit may not record an action against another unit’s resource', async () => {
  const { service } = build();

  await assert.rejects(
    service.record(
      recordRequest({
        resource: { owner: 'K-08', type: 'configuration_version', id: 'ver-1' },
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'resource-not-owned');
      assert.match((error as AuditError).message, /could fabricate that unit's history/);
      return true;
    },
  );

  await assert.rejects(
    service.record(recordRequest({ resource: { owner: 'K-05', type: 'something_else', id: 'x' } })),
    (error: unknown) => codeOf(error) === 'resource-not-owned',
    'a type the action never declared is refused too',
  );
});

test('an action with no declared resource types accepts any type its owner names', async () => {
  const { service } = build([OPEN_ACTION]);

  const result = await service.record(
    recordRequest({
      action: 'platform.migration_applied',
      resource: { owner: 'platform', type: 'migration', id: '0005' },
      evidence: { migration_version: '0005' },
    }),
  );

  assert.equal(result.record.resource.type, 'migration');
});

test('malformed identities and instants fail closed', async () => {
  const { service, repository } = build();

  const malformed = [
    recordRequest({ recordId: '' }),
    recordRequest({ recordId: 'has spaces' }),
    recordRequest({ correlationId: 'x'.repeat(200) }),
    recordRequest({ causationId: 'bad/id' }),
    recordRequest({ idempotencyKey: '#nope' }),
    recordRequest({ actor: { ...OPERATOR, id: 'has spaces' } }),
    recordRequest({ resource: { owner: 'K-05', type: 'configuration_version', id: '' } }),
    recordRequest({ recordedAt: '2026-02-30T00:00:00Z' }),
    recordRequest({ recordedAt: 'yesterday' }),
    recordRequest({ recordedAt: '2026-04-01 12:00:00' }),
  ];

  for (const request of malformed) {
    await assert.rejects(
      service.record(request),
      (error: unknown) => codeOf(error) === 'malformed-record',
      `${JSON.stringify({ id: request.recordId, at: request.recordedAt })} must be refused`,
    );
  }
  assert.equal(repository.records().length, 0);
});

test('a record with no reason is refused', async () => {
  const { service } = build();

  for (const reason of ['', '   ', '\n\t']) {
    await assert.rejects(service.record(recordRequest({ reason })), (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as AuditError).message, /only time anybody reads one/);
      return true;
    });
  }
});

test('an unknown outcome is refused', async () => {
  const { service } = build();

  await assert.rejects(
    service.record(recordRequest({ outcome: 'partially' as never })),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );

  // All three declared outcomes are recordable, so the refusal above is about the unknown one.
  for (const outcome of ['succeeded', 'failed', 'denied'] as const) {
    const { service: fresh } = build();
    const result = await fresh.record(recordRequest({ outcome }));
    assert.equal(result.record.outcome, outcome);
  }
});

test('a denied attempt is recordable, and is not the same as a failure', async () => {
  // The single most interesting row in a security log. Folding it into "failed" would lose the
  // difference between the system breaking and somebody trying something they may not do.
  const { service } = build();

  const denied = await service.record(
    recordRequest({
      outcome: 'denied',
      reason: 'actor is not permitted to publish at global scope',
    }),
  );

  assert.equal(denied.record.outcome, 'denied');
  assert.notEqual(denied.record.outcome, 'failed');
});
