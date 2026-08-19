/**
 * K-05 Configuration — draft lifecycle, replacement ordering and idempotency (FND-003a corrected).
 *
 * These cover the behaviours the first revision got wrong:
 *
 *   - a version was constructed already active, so there was no draft to be invisible or to
 *     activate, and activation had nothing to fail *at*;
 *   - the replacement was inserted active and the incumbent superseded afterwards, which asks the
 *     partial unique index to hold two active rows for one key and scope;
 *   - a reused idempotency key returned the earlier version whatever the caller had asked for,
 *     reporting success for a change that never happened;
 *   - a tenant resolution fell through to global with no way to reach a regional default, because
 *     the component tried to derive the relationship it does not know.
 *
 * The adapter-query cases run the real PostgreSQL adapter against a recording fake, because
 * statement *order* is behaviour and cannot be asserted by reading source.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConfigurationError,
  ConfigurationRegistry,
  ConfigurationService,
  GLOBAL_SCOPE,
  InMemoryConfigurationRepository,
  PostgresConfigurationRepository,
  scopeChain,
} from '../kernel/configuration/index.ts';
import type {
  ConfigurationKey,
  CreateDraftRequest,
  PublishRequest,
  Scope,
} from '../kernel/configuration/index.ts';
import { RecordingDatabase, row } from './helpers/recording-database.ts';

const KEYS: readonly ConfigurationKey[] = [
  {
    id: 'session.timeout_seconds',
    description: 'How long an idle session survives.',
    schema: { kind: 'duration-seconds', minimum: 60, maximum: 86_400 },
    scopes: ['global', 'region', 'tenant'],
  },
];

const KEY = 'session.timeout_seconds';
const TENANT: Scope = { level: 'tenant', id: 'tenant-a' };
const REGION: Scope = { level: 'region', id: 'eu' };
const OTHER_REGION: Scope = { level: 'region', id: 'apac' };

const build = (): {
  service: ConfigurationService;
  repository: InMemoryConfigurationRepository;
} => {
  const repository = new InMemoryConfigurationRepository();
  return {
    service: new ConfigurationService(new ConfigurationRegistry(KEYS), repository),
    repository,
  };
};

let sequence = 0;
const draftRequest = (overrides: Partial<CreateDraftRequest> = {}): CreateDraftRequest => {
  sequence += 1;
  return {
    key: KEY,
    scope: GLOBAL_SCOPE,
    value: 900,
    effectiveFrom: '2026-01-01T00:00:00Z',
    idempotencyKey: `idem-${sequence}`,
    versionId: `ver-${sequence}`,
    origin: 'human',
    authorityLevel: 'global',
    now: '2026-01-01T00:00:00Z',
    ...overrides,
  };
};

const publishRequest = (overrides: Partial<PublishRequest> = {}): PublishRequest => ({
  ...draftRequest(overrides),
  expectedActiveVersionId: null,
  ...overrides,
});

const codeOf = (error: unknown): string =>
  error instanceof ConfigurationError ? error.code : `not-a-configuration-error:${String(error)}`;

// --------------------------------------------------------------- drafts

test('a draft is stored, immutable in content, and not yet active', async () => {
  const { service, repository } = build();
  const { draft, deduplicated } = await service.createDraft(draftRequest());

  assert.equal(deduplicated, false);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.publishedAt, null, 'a draft has not been published');
  assert.equal(draft.previousVersionId, null, 'what it replaces is decided at activation');
  assert.equal(repository.snapshot().length, 1, 'the draft is a real stored record');
});

test('a draft is invisible to resolution', async () => {
  const { service } = build();
  await service.createDraft(draftRequest());

  await assert.rejects(
    service.resolve({ key: KEY, scope: GLOBAL_SCOPE, at: '2026-06-01T00:00:00Z' }),
    (error: unknown) => codeOf(error) === 'no-value',
    'a proposal is not a published value, however far past its effective instant',
  );
});

test('publishing a draft activates that same record rather than creating another', async () => {
  const { service, repository } = build();
  const { draft } = await service.createDraft(draftRequest());

  const result = await service.publishDraft({
    draftId: draft.versionId,
    expectedActiveVersionId: null,
    now: '2026-01-01T00:00:00Z',
  });

  assert.equal(result.version.versionId, draft.versionId, 'activation must not mint a new id');
  assert.equal(result.version.status, 'active');
  assert.equal(result.version.publishedAt, '2026-01-01T00:00:00Z');
  assert.equal(result.version.value, draft.value, 'content is fixed at creation');
  assert.equal(repository.snapshot().length, 1, 'one record, not two');

  const resolved = await service.resolve({
    key: KEY,
    scope: GLOBAL_SCOPE,
    at: '2026-01-01T00:00:00Z',
  });
  assert.equal(resolved.versionId, draft.versionId);
});

test('publishing a draft twice is idempotent by state', async () => {
  const { service } = build();
  const { draft } = await service.createDraft(draftRequest());
  const first = await service.publishDraft({
    draftId: draft.versionId,
    expectedActiveVersionId: null,
    now: '2026-01-01T00:00:00Z',
  });
  const retry = await service.publishDraft({
    draftId: draft.versionId,
    expectedActiveVersionId: null,
    now: '2026-01-02T00:00:00Z',
  });

  assert.equal(retry.deduplicated, true);
  assert.equal(retry.version.versionId, first.version.versionId);
  assert.equal(retry.version.publishedAt, '2026-01-01T00:00:00Z', 'the original instant stands');
});

test('publishing an unknown or already-superseded version is refused', async () => {
  const { service } = build();
  await assert.rejects(
    service.publishDraft({
      draftId: 'nope',
      expectedActiveVersionId: null,
      now: '2026-01-01T00:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'draft-not-found',
  );

  const first = await service.publish(publishRequest());
  await service.publish(
    publishRequest({
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-15T00:00:00Z',
    }),
  );
  await assert.rejects(
    service.publishDraft({
      draftId: first.version.versionId,
      expectedActiveVersionId: null,
      now: '2026-02-01T00:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'not-a-draft',
  );
});

test('a failed activation leaves both the incumbent and the draft untouched', async () => {
  const { service, repository } = build();
  const first = await service.publish(publishRequest());
  const { draft } = await service.createDraft(
    draftRequest({
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      now: '2026-01-15T00:00:00Z',
    }),
  );

  // The caller's expectation is wrong, so activation is refused after the draft already exists.
  await assert.rejects(
    service.publishDraft({
      draftId: draft.versionId,
      expectedActiveVersionId: 'ver-does-not-exist',
      now: '2026-01-15T00:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'concurrent-modification',
  );

  const after = repository.snapshot();
  const incumbent = after.find((version) => version.versionId === first.version.versionId);
  const proposal = after.find((version) => version.versionId === draft.versionId);

  assert.equal(incumbent?.status, 'active', 'the incumbent must not have been superseded');
  assert.equal(incumbent?.supersededAt, null);
  assert.equal(proposal?.status, 'draft', 'the draft must remain a draft');
  assert.equal(proposal?.publishedAt, null);
});

// --------------------------------------------------------------- replacement and concurrency

test('replacement supersedes the incumbent and activates the draft, never both active', async () => {
  const { service, repository } = build();
  const first = await service.publish(publishRequest());
  const second = await service.publish(
    publishRequest({
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-15T00:00:00Z',
    }),
  );

  assert.equal(second.supersededVersionId, first.version.versionId);
  assert.equal(second.version.previousVersionId, first.version.versionId);

  // The in-memory repository enforces the partial unique index at commit, so reaching here at all
  // is the proof that two active rows never coexisted.
  const active = repository.snapshot().filter((version) => version.status === 'active');
  assert.equal(active.length, 1, 'exactly one active version survives');
  assert.equal(active[0]?.versionId, second.version.versionId);
});

test('the loser of a concurrent replacement is refused and changes nothing', async () => {
  const { service, repository } = build();
  const first = await service.publish(publishRequest());

  // Two editors prepare replacements against the same incumbent.
  const winner = await service.createDraft(
    draftRequest({
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      now: '2026-01-15T00:00:00Z',
    }),
  );
  const loser = await service.createDraft(
    draftRequest({
      value: 3600,
      effectiveFrom: '2026-03-01T00:00:00Z',
      now: '2026-01-15T00:00:00Z',
    }),
  );

  await service.publishDraft({
    draftId: winner.draft.versionId,
    expectedActiveVersionId: first.version.versionId,
    now: '2026-01-15T00:00:00Z',
  });

  await assert.rejects(
    service.publishDraft({
      draftId: loser.draft.versionId,
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-16T00:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'concurrent-modification',
    'the second editor must be refused, not silently applied on top of the first',
  );

  const after = repository.snapshot();
  assert.equal(
    after.find((v) => v.versionId === loser.draft.versionId)?.status,
    'draft',
    "the loser's draft survives, unactivated, to be retried against the new incumbent",
  );
  assert.equal(after.filter((v) => v.status === 'active').length, 1);
  assert.equal(
    after.find((v) => v.status === 'active')?.versionId,
    winner.draft.versionId,
    'the winner stands',
  );
});

// --------------------------------------------------------------- idempotency

test('a retry with the identical request returns the original draft', async () => {
  const { service, repository } = build();
  const request = draftRequest({ idempotencyKey: 'retry-me' });
  const first = await service.createDraft(request);
  const retry = await service.createDraft({ ...request });

  assert.equal(retry.deduplicated, true);
  assert.equal(retry.draft.versionId, first.draft.versionId);
  assert.equal(repository.snapshot().length, 1);
});

test('reusing an idempotency key for different content is refused', async () => {
  const { service, repository } = build();
  const request = draftRequest({ idempotencyKey: 'reused' });
  await service.createDraft(request);

  const mutations: ReadonlyArray<[string, Partial<CreateDraftRequest>]> = [
    ['a different value', { value: 1800 }],
    ['a different effective instant', { effectiveFrom: '2026-03-01T00:00:00Z' }],
    ['a different scope', { scope: TENANT, authorityLevel: 'tenant' }],
    ['a different origin', { origin: 'system-migration' }],
    ['a different version id', { versionId: 'ver-other' }],
  ];
  for (const [description, overrides] of mutations) {
    await assert.rejects(
      service.createDraft({ ...request, ...overrides }),
      (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
      `expected ${description} under a reused key to be refused`,
    );
  }
  assert.equal(repository.snapshot().length, 1, 'no refused reuse may write');
});

test('the refusal explains what differed, without inventing a version', async () => {
  const { service } = build();
  const request = draftRequest({ idempotencyKey: 'explain-me' });
  await service.createDraft(request);

  await assert.rejects(service.createDraft({ ...request, value: 1800 }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.equal(error.code, 'idempotency-key-reuse');
    assert.match(error.message, /value was 900, now 1800/);
    return true;
  });
});

// --------------------------------------------------------------- explicit region

test('a tenant request falls back to an explicitly named region before global', async () => {
  const { service } = build();
  await service.publish(publishRequest({ value: 900, scope: GLOBAL_SCOPE }));
  await service.publish(publishRequest({ value: 1800, scope: REGION, authorityLevel: 'region' }));

  const at = '2026-01-02T00:00:00Z';

  const withRegion = await service.resolve({ key: KEY, scope: TENANT, region: REGION, at });
  assert.equal(withRegion.value, 1800, 'the named region beats global');
  assert.deepEqual(withRegion.scope, REGION);

  const withoutRegion = await service.resolve({ key: KEY, scope: TENANT, at });
  assert.equal(
    withoutRegion.value,
    900,
    'with no region named, the chain skips to global rather than guessing one',
  );
  assert.deepEqual(withoutRegion.scope, GLOBAL_SCOPE);

  const otherRegion = await service.resolve({ key: KEY, scope: TENANT, region: OTHER_REGION, at });
  assert.equal(otherRegion.value, 900, 'a different region does not inherit this one');
});

test('a tenant value still beats the named region', async () => {
  const { service } = build();
  await service.publish(publishRequest({ value: 900, scope: GLOBAL_SCOPE }));
  await service.publish(publishRequest({ value: 1800, scope: REGION, authorityLevel: 'region' }));
  await service.publish(publishRequest({ value: 300, scope: TENANT, authorityLevel: 'tenant' }));

  const resolved = await service.resolve({
    key: KEY,
    scope: TENANT,
    region: REGION,
    at: '2026-01-02T00:00:00Z',
  });
  assert.equal(resolved.value, 300);
  assert.deepEqual(resolved.scope, TENANT);
});

test('the scope chain is explicit about what it will and will not consult', () => {
  assert.deepEqual(scopeChain(TENANT, REGION), [TENANT, REGION, GLOBAL_SCOPE]);
  assert.deepEqual(scopeChain(TENANT), [TENANT, GLOBAL_SCOPE]);
  assert.deepEqual(scopeChain(REGION), [REGION, GLOBAL_SCOPE]);
  assert.deepEqual(scopeChain(GLOBAL_SCOPE), [GLOBAL_SCOPE]);
});

test('a region may only be supplied for a tenant request, and must be a region', () => {
  assert.throws(
    () => scopeChain(REGION, REGION),
    (error: unknown) => codeOf(error) === 'region-mismatch',
    'a region request has no broader region to fall back to',
  );
  assert.throws(
    () => scopeChain(TENANT, TENANT),
    (error: unknown) => codeOf(error) === 'region-mismatch',
    'a tenant is not a region',
  );
});

// --------------------------------------------------------------- adapter query ordering

const draftRow = row({
  version_id: 'ver-draft',
  status: 'draft',
  published_at: null,
  value_text: '1800',
  // Later than the incumbent, or the service refuses it as ambiguous before the adapter is reached.
  effective_from: '2026-02-01T00:00:00.000Z',
  idempotency_key: 'idem-draft',
});
const activeRow = row({ version_id: 'ver-active', status: 'active' });

test('the adapter supersedes the incumbent before activating the draft', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /WHERE version_id = \$1/, rows: [draftRow] },
      { match: /IN \(SELECT \* FROM unnest/, rows: [activeRow, draftRow] },
    ],
    updates: [{ match: /UPDATE/, rowCount: 1 }],
  });
  const service = new ConfigurationService(
    new ConfigurationRegistry(KEYS),
    new PostgresConfigurationRepository(database),
  );

  await service.publishDraft({
    draftId: 'ver-draft',
    expectedActiveVersionId: 'ver-active',
    now: '2026-01-15T00:00:00Z',
  });

  const supersede = database.indexOf(/SET status = 'superseded'/);
  const activate = database.indexOf(/SET status = 'active'/);
  const commit = database.indexOf(/^COMMIT;$/);

  assert.ok(supersede !== -1 && activate !== -1, 'both updates must be issued');
  assert.ok(
    supersede < activate,
    'the incumbent must leave the partial unique index before the replacement enters it — the ' +
      'reverse order asks the database to hold two active rows for one key and scope',
  );
  assert.ok(activate < commit, 'both updates are inside the transaction');
});

test('the adapter guards each update on the status it expects to find', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /WHERE version_id = \$1/, rows: [draftRow] },
      { match: /IN \(SELECT \* FROM unnest/, rows: [activeRow, draftRow] },
    ],
  });
  const service = new ConfigurationService(
    new ConfigurationRegistry(KEYS),
    new PostgresConfigurationRepository(database),
  );
  await service.publishDraft({
    draftId: 'ver-draft',
    expectedActiveVersionId: 'ver-active',
    now: '2026-01-15T00:00:00Z',
  });

  const statements = database.statements();
  assert.ok(
    statements.some((sql) =>
      /SET status = 'superseded'.*WHERE version_id = \$1 AND status = 'active'/.test(sql),
    ),
    'supersession must be conditional on the row still being active',
  );
  assert.ok(
    statements.some((sql) =>
      /SET status = 'active'.*WHERE version_id = \$1 AND status = 'draft'/.test(sql),
    ),
    'activation must be conditional on the row still being a draft',
  );
});

test('an activation that changes no rows is refused and the transaction rolls back', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /WHERE version_id = \$1/, rows: [draftRow] },
      { match: /IN \(SELECT \* FROM unnest/, rows: [activeRow, draftRow] },
    ],
    // The incumbent supersedes fine; the draft was activated by someone else in between.
    updates: [
      { match: /SET status = 'superseded'/, rowCount: 1 },
      { match: /SET status = 'active'/, rowCount: 0 },
    ],
  });
  const service = new ConfigurationService(
    new ConfigurationRegistry(KEYS),
    new PostgresConfigurationRepository(database),
  );

  await assert.rejects(
    service.publishDraft({
      draftId: 'ver-draft',
      expectedActiveVersionId: 'ver-active',
      now: '2026-01-15T00:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'concurrent-modification',
  );

  const statements = database.statements();
  assert.ok(statements.includes('ROLLBACK;'), 'the transaction must roll back');
  assert.equal(
    statements.includes('COMMIT;'),
    false,
    'a half-completed replacement must never commit — the incumbent would be superseded with ' +
      'nothing active to replace it',
  );
  assert.equal(database.sessionsReleased, 1, 'the session is released on the failure path');
});

test('a supersession that changes no rows refuses before activation is attempted', async () => {
  const database = new RecordingDatabase({
    selects: [
      { match: /WHERE version_id = \$1/, rows: [draftRow] },
      { match: /IN \(SELECT \* FROM unnest/, rows: [activeRow, draftRow] },
    ],
    updates: [{ match: /SET status = 'superseded'/, rowCount: 0 }],
  });
  const service = new ConfigurationService(
    new ConfigurationRegistry(KEYS),
    new PostgresConfigurationRepository(database),
  );

  await assert.rejects(
    service.publishDraft({
      draftId: 'ver-draft',
      expectedActiveVersionId: 'ver-active',
      now: '2026-01-15T00:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'concurrent-modification',
  );

  assert.equal(
    database.indexOf(/SET status = 'active'/),
    -1,
    'activation must not be attempted once supersession has failed',
  );
  assert.ok(database.statements().includes('ROLLBACK;'));
});

test('the adapter refuses to insert a version that is already active', async () => {
  const database = new RecordingDatabase();
  const repository = new PostgresConfigurationRepository(database);

  await assert.rejects(
    repository.withTransaction((tx) =>
      tx.insertDraft({
        versionId: 'ver-1',
        key: KEY,
        scope: GLOBAL_SCOPE,
        value: 900,
        effectiveFrom: '2026-01-01T00:00:00Z',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        publishedAt: '2026-01-01T00:00:00Z',
        supersededAt: null,
        previousVersionId: null,
        idempotencyKey: 'idem-1',
        origin: 'human',
      }),
    ),
    (error: unknown) => codeOf(error) === 'immutable-version',
  );

  assert.equal(
    database.indexOf(/INSERT INTO/),
    -1,
    'the refusal must happen before any row is written',
  );
});
