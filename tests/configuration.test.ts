/**
 * K-05 Configuration — service tests (FND-003a).
 *
 * Every case is deterministic: the service takes `now`, the version id and the idempotency key
 * from the caller and reads no clock, so concurrency, effective-time and idempotency behaviour can
 * be provoked exactly rather than approximately.
 *
 * The refusals matter more than the happy path. A configuration component that accepts an unknown
 * key, a retroactive change or a second active version is not merely incomplete — it produces a
 * history that cannot be reconciled with the decisions taken under it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConfigurationError,
  ConfigurationRegistry,
  ConfigurationService,
  GLOBAL_SCOPE,
  InMemoryConfigurationRepository,
  scopeChain,
} from '../kernel/configuration/index.ts';
import type { ConfigurationKey, PublishRequest, Scope } from '../kernel/configuration/index.ts';

// --------------------------------------------------------------- fixtures

const KEYS: readonly ConfigurationKey[] = [
  {
    id: 'session.timeout_seconds',
    description: 'How long an idle session survives.',
    schema: { kind: 'duration-seconds', minimum: 60, maximum: 86_400 },
    scopes: ['global', 'tenant'],
  },
  {
    id: 'listing.moderation_mode',
    description: 'How new listings are moderated.',
    schema: { kind: 'enum', values: ['off', 'sampled', 'all'] },
    scopes: ['global', 'region', 'tenant'],
  },
  {
    id: 'search.results_per_page',
    description: 'Default page size for search.',
    schema: { kind: 'integer', minimum: 1, maximum: 100 },
    scopes: ['global'],
  },
  {
    id: 'support.contact_url',
    description: 'Where users are sent for help.',
    schema: { kind: 'string', maxLength: 200 },
    scopes: ['global', 'tenant'],
  },
];

const TENANT: Scope = { level: 'tenant', id: 'tenant-a' };
const OTHER_TENANT: Scope = { level: 'tenant', id: 'tenant-b' };
const REGION: Scope = { level: 'region', id: 'eu' };

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
const publication = (overrides: Partial<PublishRequest> = {}): PublishRequest => {
  sequence += 1;
  return {
    key: 'session.timeout_seconds',
    scope: GLOBAL_SCOPE,
    value: 900,
    effectiveFrom: '2026-01-01T00:00:00Z',
    expectedActiveVersionId: null,
    idempotencyKey: `idem-${sequence}`,
    versionId: `ver-${sequence}`,
    origin: 'human',
    authorityLevel: 'global',
    now: '2026-01-01T00:00:00Z',
    ...overrides,
  };
};

const codeOf = (error: unknown): string =>
  error instanceof ConfigurationError ? error.code : `not-a-configuration-error:${String(error)}`;

// --------------------------------------------------------------- lifecycle

test('a published version becomes active and resolvable at its effective instant', async () => {
  const { service } = build();
  const result = await service.publish(publication());

  assert.equal(result.deduplicated, false);
  assert.equal(result.version.status, 'active');
  assert.equal(result.version.previousVersionId, null);
  assert.equal(result.supersededVersionId, null);

  const resolved = await service.resolve({
    key: 'session.timeout_seconds',
    scope: GLOBAL_SCOPE,
    at: '2026-01-01T00:00:00Z',
  });
  assert.equal(resolved.value, 900);
  assert.equal(resolved.versionId, result.version.versionId);
});

test('a version is not resolvable before it takes effect', async () => {
  const { service } = build();
  await service.publish(publication({ effectiveFrom: '2026-06-01T00:00:00Z' }));

  await assert.rejects(
    service.resolve({
      key: 'session.timeout_seconds',
      scope: GLOBAL_SCOPE,
      at: '2026-05-31T23:59:59Z',
    }),
    (error: unknown) => codeOf(error) === 'no-value',
    'a future version must not answer a question about the present',
  );
});

test('publishing supersedes the previous version and links to it', async () => {
  const { service } = build();
  const first = await service.publish(publication());
  const second = await service.publish(
    publication({
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-15T00:00:00Z',
    }),
  );

  assert.equal(second.supersededVersionId, first.version.versionId);
  assert.equal(second.version.previousVersionId, first.version.versionId);

  const history = await service.history('session.timeout_seconds', GLOBAL_SCOPE);
  assert.deepEqual(
    history.map((version) => version.status),
    ['superseded', 'active'],
  );
});

test('resolution at a past instant answers with what was true then', async () => {
  const { service } = build();
  const first = await service.publish(publication());
  await service.publish(
    publication({
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-15T00:00:00Z',
    }),
  );

  const before = await service.resolve({
    key: 'session.timeout_seconds',
    scope: GLOBAL_SCOPE,
    at: '2026-01-20T00:00:00Z',
  });
  assert.equal(before.value, 900, 'a question about January must not be answered with February');

  const after = await service.resolve({
    key: 'session.timeout_seconds',
    scope: GLOBAL_SCOPE,
    at: '2026-03-01T00:00:00Z',
  });
  assert.equal(after.value, 1800);
});

// --------------------------------------------------------------- historical decisions

test('a recorded version reference never changes when a later version is published', async () => {
  const { service } = build();
  const first = await service.publish(publication());

  const decision = await service.resolveForDecision({
    key: 'session.timeout_seconds',
    scope: GLOBAL_SCOPE,
    at: '2026-01-05T00:00:00Z',
  });
  assert.equal(decision.versionId, first.version.versionId);
  assert.equal(decision.value, 900);

  await service.publish(
    publication({
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-15T00:00:00Z',
    }),
  );

  // The whole point: the record taken in January still explains the January decision.
  const pinned = await service.versionById(decision.versionId);
  assert.equal(pinned.value, 900, 'the recorded version must be unchanged by later publication');
  assert.equal(pinned.versionId, decision.versionId);
  assert.equal(pinned.effectiveFrom, '2026-01-01T00:00:00Z');
  assert.equal(pinned.status, 'superseded', 'superseded is not deleted');
  assert.equal(pinned.supersededAt, '2026-01-15T00:00:00Z');
});

test('a superseded version is still retrievable by id', async () => {
  const { service } = build();
  const first = await service.publish(publication());
  await service.publish(
    publication({
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-15T00:00:00Z',
    }),
  );

  const retrieved = await service.versionById(first.version.versionId);
  assert.equal(retrieved.value, 900);
});

// --------------------------------------------------------------- idempotency and concurrency

test('a retried publication returns the original version and writes nothing new', async () => {
  const { service, repository } = build();
  const request = publication({ idempotencyKey: 'retry-me' });
  const first = await service.publish(request);
  const retry = await service.publish({ ...request });

  assert.equal(retry.deduplicated, true);
  assert.equal(retry.version.versionId, first.version.versionId);
  assert.equal(retry.version.value, 900);
  assert.equal(
    repository.snapshot().length,
    1,
    'a dropped response must not become a second version',
  );
});

test('a reused idempotency key with different content is refused, not answered', async () => {
  // The earlier revision returned the original version here, reporting success for a change that
  // never happened — the worst of the available outcomes. The detailed cases live in
  // tests/configuration-lifecycle.test.ts; this pins the headline behaviour beside its sibling.
  const { service } = build();
  const request = publication({ idempotencyKey: 'reused-here' });
  await service.publish(request);

  await assert.rejects(
    service.publish({ ...request, versionId: 'ver-different', value: 1800 }),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
  );
});

test('a stale expected version is refused rather than silently applied', async () => {
  const { service, repository } = build();
  const first = await service.publish(publication());
  await service.publish(
    publication({
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-15T00:00:00Z',
    }),
  );

  // A second editor who read the same state as the first, and published later.
  await assert.rejects(
    service.publish(
      publication({
        value: 3600,
        effectiveFrom: '2026-03-01T00:00:00Z',
        expectedActiveVersionId: first.version.versionId,
        now: '2026-01-20T00:00:00Z',
      }),
    ),
    (error: unknown) => codeOf(error) === 'concurrent-modification',
  );
  // The draft the refused publication created survives, unactivated — it is a real record, and
  // discarding it would lose a validated proposal the caller may retry against the new incumbent.
  // What must not have changed is either published version.
  assert.deepEqual(
    repository
      .snapshot()
      .filter((version) => version.status !== 'draft')
      .map((version) => version.status),
    ['superseded', 'active'],
    'the refused publication must not have changed a published version',
  );
});

test('claiming no active version when one exists is refused', async () => {
  const { service } = build();
  await service.publish(publication());
  await assert.rejects(
    service.publish(
      publication({ effectiveFrom: '2026-02-01T00:00:00Z', expectedActiveVersionId: null }),
    ),
    (error: unknown) => codeOf(error) === 'concurrent-modification',
  );
});

test('a failed publication rolls back, leaving no partial write', async () => {
  const { service, repository } = build();
  const first = await service.publish(publication());

  await assert.rejects(
    service.publish(
      publication({
        effectiveFrom: '2026-01-01T00:00:00Z', // not after the current version
        expectedActiveVersionId: first.version.versionId,
      }),
    ),
    (error: unknown) => codeOf(error) === 'ambiguous-active-version',
  );

  const published = repository.snapshot().filter((version) => version.status !== 'draft');
  assert.equal(published.length, 1);
  assert.equal(published[0]?.status, 'active', 'the existing version stays active');
  assert.ok(
    repository.transactionsRolledBack > 0,
    'the activation transaction must have rolled back',
  );
});

// --------------------------------------------------------------- scoped overrides

test('a tenant override beats the global value, and only for that tenant', async () => {
  const { service } = build();
  await service.publish(
    publication({ key: 'listing.moderation_mode', value: 'sampled', scope: GLOBAL_SCOPE }),
  );
  await service.publish(
    publication({
      key: 'listing.moderation_mode',
      value: 'all',
      scope: TENANT,
      authorityLevel: 'tenant',
    }),
  );

  const at = '2026-01-02T00:00:00Z';
  const overridden = await service.resolve({ key: 'listing.moderation_mode', scope: TENANT, at });
  assert.equal(overridden.value, 'all');
  assert.deepEqual(overridden.scope, TENANT);

  const other = await service.resolve({ key: 'listing.moderation_mode', scope: OTHER_TENANT, at });
  assert.equal(other.value, 'sampled', 'another tenant falls through to global');
  assert.deepEqual(other.scope, GLOBAL_SCOPE);
});

test('the documented precedence chain is most-specific-first, ending at global', () => {
  assert.deepEqual(scopeChain(TENANT), [TENANT, GLOBAL_SCOPE]);
  assert.deepEqual(scopeChain(REGION), [REGION, GLOBAL_SCOPE]);
  assert.deepEqual(scopeChain(GLOBAL_SCOPE), [GLOBAL_SCOPE]);
});

test('a key may not be set at a scope it does not permit', async () => {
  const { service } = build();
  await assert.rejects(
    service.publish(
      publication({
        key: 'search.results_per_page',
        value: 20,
        scope: TENANT,
        authorityLevel: 'tenant',
      }),
    ),
    (error: unknown) => codeOf(error) === 'scope-not-permitted',
  );
});

// --------------------------------------------------------------- refusals

test('an unknown key is refused on publish and on resolve', async () => {
  const { service } = build();
  await assert.rejects(
    service.publish(publication({ key: 'not.registered' })),
    (error: unknown) => codeOf(error) === 'unknown-key',
  );
  await assert.rejects(
    service.resolve({ key: 'not.registered', scope: GLOBAL_SCOPE, at: '2026-01-01T00:00:00Z' }),
    (error: unknown) => codeOf(error) === 'unknown-key',
  );
});

test('a value outside its schema is refused', async () => {
  const { service } = build();
  const cases: ReadonlyArray<Partial<PublishRequest>> = [
    { value: 30 }, // below the duration minimum
    { value: 90_000 }, // above the maximum
    { value: 900.5 }, // not an integer
    { value: 'fifteen minutes' }, // wrong type
    { key: 'listing.moderation_mode', value: 'sometimes' }, // outside the enum
    { key: 'search.results_per_page', value: 0 },
  ];
  for (const overrides of cases) {
    await assert.rejects(
      service.publish(publication(overrides)),
      (error: unknown) => codeOf(error) === 'invalid-value',
      `expected ${JSON.stringify(overrides)} to be refused`,
    );
  }
});

test('a retroactive change is refused', async () => {
  const { service } = build();
  await assert.rejects(
    service.publish(
      publication({ effectiveFrom: '2025-12-31T23:59:59Z', now: '2026-01-01T00:00:00Z' }),
    ),
    (error: unknown) => codeOf(error) === 'retroactive-change',
  );
});

test('a second version effective at the same instant is refused as ambiguous', async () => {
  const { service } = build();
  const first = await service.publish(publication());
  await assert.rejects(
    service.publish(
      publication({
        effectiveFrom: '2026-01-01T00:00:00Z',
        expectedActiveVersionId: first.version.versionId,
      }),
    ),
    (error: unknown) => codeOf(error) === 'ambiguous-active-version',
  );
});

test('scope escalation is refused', async () => {
  const { service } = build();
  await assert.rejects(
    service.publish(
      publication({
        key: 'listing.moderation_mode',
        value: 'off',
        scope: GLOBAL_SCOPE,
        authorityLevel: 'tenant',
      }),
    ),
    (error: unknown) => codeOf(error) === 'scope-escalation',
    'tenant authority must not reach global scope',
  );
  await assert.rejects(
    service.publish(
      publication({
        key: 'listing.moderation_mode',
        value: 'off',
        scope: REGION,
        authorityLevel: 'tenant',
      }),
    ),
    (error: unknown) => codeOf(error) === 'scope-escalation',
  );

  // Broader authority may act at a narrower scope — that is delegation, not escalation.
  await assert.doesNotReject(
    service.publish(
      publication({
        key: 'listing.moderation_mode',
        value: 'off',
        scope: TENANT,
        authorityLevel: 'global',
      }),
    ),
  );
});

test('a malformed instant is refused rather than coerced', async () => {
  const { service } = build();
  for (const effectiveFrom of ['2026-01-01', 'tomorrow', '2026-01-01T00:00:00+01:00', '']) {
    await assert.rejects(
      service.publish(publication({ effectiveFrom })),
      (error: unknown) => codeOf(error) === 'invalid-value',
      `expected "${effectiveFrom}" to be refused`,
    );
  }
});

// --------------------------------------------------------------- AI exclusion

test('AI cannot publish configuration', async () => {
  const { service, repository } = build();
  await assert.rejects(
    service.publish(publication({ origin: 'ai-suggested' })),
    (error: unknown) => codeOf(error) === 'origin-not-permitted',
    'AI may propose a change to a human; it may not publish one',
  );
  assert.deepEqual(repository.snapshot(), [], 'a refused AI publication writes nothing');
});

test('every stored version carries a permitted origin', async () => {
  const { service, repository } = build();
  await service.publish(publication());
  await service.publish(
    publication({ origin: 'system-migration', key: 'search.results_per_page', value: 20 }),
  );
  for (const version of repository.snapshot()) {
    assert.notEqual(version.origin, 'ai-suggested');
  }
});

test('resolution answers only from published versions, never from a suggestion', async () => {
  const { service } = build();
  // There is no API by which a suggestion could enter: publish is the only writer, and it refuses
  // the AI origin. This pins that there is no second path.
  await assert.rejects(
    service.resolve({
      key: 'session.timeout_seconds',
      scope: GLOBAL_SCOPE,
      at: '2026-01-01T00:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'no-value',
    'with nothing published, resolution has nothing to answer from',
  );
});

// --------------------------------------------------------------- registry

test('secret-bearing keys and values are refused at registration and at publication', () => {
  for (const id of ['auth.password', 'provider.api_key', 'billing.secret_token']) {
    assert.throws(
      () =>
        new ConfigurationRegistry([
          { id, description: 'x', schema: { kind: 'string', maxLength: 100 }, scopes: ['global'] },
        ]),
      (error: unknown) => codeOf(error) === 'secret-bearing-value',
      `expected "${id}" to be refused`,
    );
  }
});

test('a secret-shaped value is refused even under an innocent key', async () => {
  const { service } = build();
  const secrets = [
    'postgres://user:hunter2@db.internal:5432/app',
    '-----BEGIN RSA PRIVATE KEY-----',
    'Bearer abcdefghijklmnopqrstuvwxyz',
    'AKIAIOSFODNN7EXAMPLE',
  ];
  for (const value of secrets) {
    await assert.rejects(
      service.publish(publication({ key: 'support.contact_url', value })),
      (error: unknown) => codeOf(error) === 'secret-bearing-value',
      `expected ${value.slice(0, 24)}… to be refused`,
    );
  }
});

test('financial policy keys belong to K-06 and are refused here', () => {
  for (const id of ['commission.rate', 'fee.listing', 'payout.threshold', 'tax.vat_rate']) {
    assert.throws(
      () =>
        new ConfigurationRegistry([
          {
            id,
            description: 'x',
            schema: { kind: 'integer', minimum: 0, maximum: 1 },
            scopes: ['global'],
          },
        ]),
      (error: unknown) => codeOf(error) === 'financial-policy-value',
      `expected "${id}" to be refused`,
    );
  }
});

test('a malformed key name is refused at registration', () => {
  for (const id of ['Session.Timeout', 'session timeout', '1session', 'session..timeout', '']) {
    assert.throws(
      () =>
        new ConfigurationRegistry([
          { id, description: 'x', schema: { kind: 'boolean' }, scopes: ['global'] },
        ]),
      ConfigurationError,
      `expected "${id}" to be refused`,
    );
  }
});

test('the registry refuses duplicates and keys with no permitted scope', () => {
  const key: ConfigurationKey = {
    id: 'session.timeout_seconds',
    description: 'x',
    schema: { kind: 'boolean' },
    scopes: ['global'],
  };
  assert.throws(() => new ConfigurationRegistry([key, key]), ConfigurationError);
  assert.throws(
    () => new ConfigurationRegistry([{ ...key, scopes: [] }]),
    (error: unknown) => codeOf(error) === 'invalid-value',
  );
});
