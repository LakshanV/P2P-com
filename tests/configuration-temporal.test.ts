/**
 * K-05 Configuration — instants, races and publication retries (FND-003a, second correction).
 *
 * Three defects, each of which let something through that the component claims to refuse:
 *
 *   1. **Instants were compared as strings.** `2026-01-01T00:00:00.000Z` sorts *before*
 *      `2026-01-01T00:00:00Z`, because `.` precedes `Z`, so a replacement offered at the
 *      incumbent's own instant passed the "must be strictly after" check merely by being written
 *      with a fraction. Ordering during resolution had the same flaw, so the version that answered
 *      a question depended on how its effective time had been typed. And a pattern match accepted
 *      `2026-02-30T00:00:00Z`, storing a date the calendar does not contain.
 *   2. **A first publication race leaked a driver error.** Two drafts at one key and scope, each
 *      correctly stating that it expected no active version, both reached activation. One won; the
 *      other got a PostgreSQL unique-violation — an error with no code, absent from the refusal
 *      table, naming an index rather than saying that someone else published first.
 *   3. **A retry after supersession was refused.** A publication that had genuinely succeeded, and
 *      had later been replaced, answered a redelivery with `not-a-draft` — reporting failure for
 *      work that was done.
 *
 * Each case below is written so that it fails against the previous implementation: the string
 * comparisons that used to be made are asserted directly, so the tests state what was wrong rather
 * than merely covering what is now right.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { databaseErrorDetail } from '../platform/db/client.ts';
import {
  ConfigurationError,
  ConfigurationRegistry,
  ConfigurationService,
  GLOBAL_SCOPE,
  InMemoryConfigurationRepository,
  PostgresConfigurationRepository,
  canonicalInstant,
  compareInstants,
  instantsEqual,
  parseInstant,
} from '../kernel/configuration/index.ts';
import type {
  ConfigurationKey,
  CreateDraftRequest,
  PublishRequest,
} from '../kernel/configuration/index.ts';
import { RecordingDatabase, row, sqlstateError } from './helpers/recording-database.ts';

const KEYS: readonly ConfigurationKey[] = [
  {
    id: 'session.timeout_seconds',
    description: 'How long an idle session survives.',
    schema: { kind: 'duration-seconds', minimum: 60, maximum: 86_400 },
    scopes: ['global', 'region', 'tenant'],
  },
];

const KEY = 'session.timeout_seconds';

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

const codeOf = (error: unknown): string | undefined =>
  error instanceof ConfigurationError ? error.code : undefined;

// ---------------------------------------------------------------------------
// 1. Instants that the calendar does not contain
// ---------------------------------------------------------------------------

test('impossible calendar instants are refused rather than rolled forward', () => {
  const impossible = [
    ['2026-02-30T00:00:00Z', 'February has no 30th'],
    ['2025-02-29T00:00:00Z', '2025 is not a leap year'],
    ['2026-04-31T00:00:00Z', 'April has no 31st'],
    ['2026-13-01T00:00:00Z', 'there is no thirteenth month'],
    ['2026-00-01T00:00:00Z', 'there is no zeroth month'],
    ['2026-01-32T00:00:00Z', 'no month has a 32nd'],
    ['2026-01-00T00:00:00Z', 'there is no zeroth day'],
    ['2026-01-01T24:00:00Z', 'hours end at 23'],
    ['2026-01-01T00:60:00Z', 'minutes end at 59'],
    ['2026-01-01T00:00:60Z', 'a leap second is not accepted'],
  ] as const;

  for (const [value, why] of impossible) {
    assert.throws(
      () => parseInstant(value, 'effectiveFrom'),
      (error: unknown) => codeOf(error) === 'invalid-value',
      `${value} should be refused: ${why}`,
    );

    // The specific trap the previous implementation fell into: `new Date` accepts these and
    // silently moves them, so a validator built on parsing alone reports success for a date the
    // caller never wrote.
    if (value === '2026-02-30T00:00:00Z') {
      assert.equal(
        new Date(value).toISOString(),
        '2026-03-02T00:00:00.000Z',
        'the trap: unchecked parsing turns 30 February into 2 March',
      );
    }
  }
});

test('real instants, including a leap day, are accepted at every permitted precision', () => {
  for (const value of [
    '2024-02-29T00:00:00Z',
    '2026-12-31T23:59:59Z',
    '2026-01-01T00:00:00.5Z',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.123456Z',
  ]) {
    assert.equal(parseInstant(value, 'effectiveFrom').source, value);
  }
});

test('an impossible instant is refused by the service, not merely by the parser', async () => {
  const { service, repository } = build();

  await assert.rejects(
    service.createDraft(draftRequest({ effectiveFrom: '2026-02-30T00:00:00Z' })),
    (error: unknown) => codeOf(error) === 'invalid-value',
  );
  assert.equal(repository.snapshot().length, 0, 'nothing was stored');
});

// ---------------------------------------------------------------------------
// 2. Equivalent and differently-precise instants
// ---------------------------------------------------------------------------

test('the same moment written three ways is one moment', () => {
  const spellings = [
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000000Z',
  ];

  for (const a of spellings) {
    for (const b of spellings) {
      assert.equal(compareInstants(a, b), 0, `${a} and ${b} are the same instant`);
      assert.ok(instantsEqual(a, b));
      assert.equal(canonicalInstant(a), canonicalInstant(b));
    }
  }

  // The defect, stated directly. Under string comparison the fractional spelling looks *earlier*,
  // which is what let a same-instant replacement past the ambiguity check.
  assert.ok(
    '2026-01-01T00:00:00.000Z' < '2026-01-01T00:00:00Z',
    'string comparison ranks the fractional spelling first — the bug this replaces',
  );
});

test('a finer fraction orders after a coarser one at the same second', () => {
  assert.equal(compareInstants('2026-01-01T00:00:00.500Z', '2026-01-01T00:00:00Z'), 1);
  assert.equal(compareInstants('2026-01-01T00:00:00Z', '2026-01-01T00:00:00.500Z'), -1);
  assert.equal(compareInstants('2026-01-01T00:00:00.000001Z', '2026-01-01T00:00:00Z'), 1);
  assert.equal(compareInstants('2026-01-01T00:00:00.1Z', '2026-01-01T00:00:00.05Z'), 1);
  assert.equal(compareInstants('2026-01-01T00:00:01Z', '2026-01-01T00:00:00.999999Z'), 1);

  // Again the contrast: text sorting disagrees with the calendar in every one of these.
  assert.ok('2026-01-01T00:00:00.500Z' < '2026-01-01T00:00:00Z', 'text sorting has it backwards');
});

test('a replacement effective at the incumbent instant is refused however it is spelled', async () => {
  for (const spelling of ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000000Z']) {
    const { service, repository } = build();
    const first = await service.publish(publishRequest());

    await assert.rejects(
      service.publish(
        publishRequest({
          value: 1800,
          effectiveFrom: spelling,
          expectedActiveVersionId: first.version.versionId,
        }),
      ),
      (error: unknown) => codeOf(error) === 'ambiguous-active-version',
      `${spelling} is the incumbent's own instant and cannot be ordered against it`,
    );

    const active = repository.snapshot().filter((version) => version.status === 'active');
    assert.deepEqual(
      active.map((version) => version.versionId),
      [first.version.versionId],
      'the incumbent is untouched',
    );
  }
});

test('the incumbent spelled with a fraction still blocks a same-instant replacement', async () => {
  // The direction that actually got through. Text comparison ranks a fractional spelling first,
  // so an incumbent written as ".000Z" looked *earlier* than a replacement written without a
  // fraction — and the replacement, at the very same instant, was accepted as a successor.
  const { service, repository } = build();

  const first = await service.publish(
    publishRequest({ effectiveFrom: '2026-01-01T00:00:00.000Z' }),
  );

  await assert.rejects(
    service.publish(
      publishRequest({
        value: 1800,
        effectiveFrom: '2026-01-01T00:00:00Z',
        expectedActiveVersionId: first.version.versionId,
      }),
    ),
    (error: unknown) => codeOf(error) === 'ambiguous-active-version',
    'the same instant, spelled shorter, is still the same instant',
  );

  assert.equal(
    repository.snapshot().filter((version) => version.status === 'active').length,
    1,
    'two versions effective at one instant would be unorderable at resolution',
  );
});

test('a retroactive change hiding behind a coarser spelling is still retroactive', async () => {
  // `effectiveFrom` sorts after `now` as text here, and half a second before it in reality.
  const { service } = build();

  await assert.rejects(
    service.createDraft(
      draftRequest({
        effectiveFrom: '2026-01-01T00:00:00Z',
        now: '2026-01-01T00:00:00.500Z',
      }),
    ),
    (error: unknown) => codeOf(error) === 'retroactive-change',
  );

  assert.ok(
    !('2026-01-01T00:00:00Z' < '2026-01-01T00:00:00.500Z'),
    'text comparison calls this instant later than now — the bug this replaces',
  );
});

test('resolution orders versions by instant, not by how the instant was typed', async () => {
  const { service } = build();

  const first = await service.publish(publishRequest({ value: 900 }));
  const second = await service.publish(
    publishRequest({
      value: 1800,
      // Later than the first by half a second, but *earlier* as text.
      effectiveFrom: '2026-01-01T00:00:00.500Z',
      expectedActiveVersionId: first.version.versionId,
    }),
  );

  const before = await service.resolve({
    key: KEY,
    scope: GLOBAL_SCOPE,
    at: '2026-01-01T00:00:00.400Z',
  });
  assert.equal(before.value, 900);
  assert.equal(before.versionId, first.version.versionId);

  const after = await service.resolve({
    key: KEY,
    scope: GLOBAL_SCOPE,
    at: '2026-01-01T00:00:00.500Z',
  });
  assert.equal(after.value, 1800, 'the version effective at this instant answers');
  assert.equal(after.versionId, second.version.versionId);

  const later = await service.resolve({
    key: KEY,
    scope: GLOBAL_SCOPE,
    at: '2026-06-01T00:00:00Z',
  });
  assert.equal(later.versionId, second.version.versionId);
});

test('a retry spelling the same instant differently is a retry, not key reuse', async () => {
  const { service, repository } = build();

  const first = await service.publish(
    publishRequest({ idempotencyKey: 'idem-fixed', versionId: 'ver-fixed' }),
  );

  const retry = await service.publish({
    ...publishRequest({ idempotencyKey: 'idem-fixed', versionId: 'ver-fixed' }),
    effectiveFrom: '2026-01-01T00:00:00.000000Z',
  });

  assert.equal(retry.deduplicated, true);
  assert.equal(retry.version.versionId, first.version.versionId);
  assert.equal(
    repository.snapshot().length,
    1,
    'the retry stored nothing; a refusal here would have reported failure for work that was done',
  );
});

test('a retry that changes the actual instant is still refused as key reuse', async () => {
  const { service } = build();
  await service.publish(publishRequest({ idempotencyKey: 'idem-shift', versionId: 'ver-shift' }));

  await assert.rejects(
    service.publish({
      ...publishRequest({ idempotencyKey: 'idem-shift', versionId: 'ver-shift' }),
      effectiveFrom: '2026-01-01T00:00:00.001Z',
    }),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
    'a millisecond is a different instant, not a different spelling',
  );
});

// ---------------------------------------------------------------------------
// 3. Competing publications where neither expects an incumbent
// ---------------------------------------------------------------------------

test('two first publications race, one wins, the loser is refused as a race', async () => {
  const { service, repository } = build();

  const a = await service.createDraft(
    draftRequest({ versionId: 'ver-a', idempotencyKey: 'idem-a' }),
  );
  const b = await service.createDraft(
    draftRequest({ versionId: 'ver-b', idempotencyKey: 'idem-b', value: 1800 }),
  );
  assert.equal(a.draft.status, 'draft');
  assert.equal(b.draft.status, 'draft');

  // Both are started before either is awaited, so both transactions read a store with no active
  // version and both correctly expect none. This is the case the service's own check cannot
  // catch: neither is wrong about what it saw.
  const outcomes = await Promise.allSettled([
    service.publishDraft({
      draftId: 'ver-a',
      expectedActiveVersionId: null,
      now: '2026-01-01T00:00:00Z',
    }),
    service.publishDraft({
      draftId: 'ver-b',
      expectedActiveVersionId: null,
      now: '2026-01-01T00:00:00Z',
    }),
  ]);

  const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(winners.length, 1, 'exactly one publication may take the active slot');
  assert.equal(losers.length, 1);

  for (const loser of losers) {
    assert.equal(
      codeOf(loser.reason),
      'concurrent-modification',
      'the loser is told it lost, in a code it can act on by re-reading and retrying',
    );
  }

  const active = repository.snapshot().filter((version) => version.status === 'active');
  assert.equal(active.length, 1, 'the one-active-row invariant held');

  const losingId = active[0]?.versionId === 'ver-a' ? 'ver-b' : 'ver-a';
  const losingDraft = repository.snapshot().find((version) => version.versionId === losingId);
  assert.equal(losingDraft?.status, 'draft', 'the loser keeps its draft and may retry');
  assert.equal(losingDraft?.publishedAt, null, 'and was not partially published');
  assert.ok(repository.transactionsRolledBack >= 1, 'the losing transaction rolled back');
});

test('a losing publication may retry successfully against the winner', async () => {
  const { service, repository } = build();

  await service.createDraft(draftRequest({ versionId: 'ver-a', idempotencyKey: 'idem-a' }));
  await service.createDraft(
    draftRequest({
      versionId: 'ver-b',
      idempotencyKey: 'idem-b',
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
    }),
  );

  const outcomes = await Promise.allSettled([
    service.publishDraft({
      draftId: 'ver-a',
      expectedActiveVersionId: null,
      now: '2026-01-01T00:00:00Z',
    }),
    service.publishDraft({
      draftId: 'ver-b',
      expectedActiveVersionId: null,
      now: '2026-01-01T00:00:00Z',
    }),
  ]);

  const active = repository.snapshot().find((version) => version.status === 'active');
  assert.ok(active !== undefined);
  const losingId = active.versionId === 'ver-a' ? 'ver-b' : 'ver-a';
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);

  // Only ver-b is effective later than ver-a, so a retry is only orderable in that direction.
  if (losingId === 'ver-b') {
    const retried = await service.publishDraft({
      draftId: 'ver-b',
      expectedActiveVersionId: active.versionId,
      now: '2026-01-15T00:00:00Z',
    });
    assert.equal(retried.version.status, 'active');
    assert.equal(retried.supersededVersionId, active.versionId);
    assert.equal(
      repository.snapshot().filter((version) => version.status === 'active').length,
      1,
      'still exactly one active row after the retry',
    );
  }
});

test('a transaction whose row changed underneath it is refused, not silently applied', async () => {
  const repository = new InMemoryConfigurationRepository();
  const service = new ConfigurationService(new ConfigurationRegistry(KEYS), repository);

  const first = await service.publish(
    publishRequest({ versionId: 'ver-1', idempotencyKey: 'idem-1' }),
  );
  await service.createDraft(
    draftRequest({
      versionId: 'ver-2',
      idempotencyKey: 'idem-2',
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
    }),
  );

  // Two replacements of the same incumbent, both correct about what they found.
  const outcomes = await Promise.allSettled([
    service.publishDraft({
      draftId: 'ver-2',
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-15T00:00:00Z',
    }),
    (async () => {
      await service.createDraft(
        draftRequest({
          versionId: 'ver-3',
          idempotencyKey: 'idem-3',
          value: 3600,
          effectiveFrom: '2026-03-01T00:00:00Z',
        }),
      );
      return service.publishDraft({
        draftId: 'ver-3',
        expectedActiveVersionId: first.version.versionId,
        now: '2026-01-15T00:00:00Z',
      });
    })(),
  ]);

  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'rejected').length,
    1,
    'one of the two replacements is refused',
  );
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      assert.equal(codeOf(outcome.reason), 'concurrent-modification');
    }
  }
  assert.equal(
    repository.snapshot().filter((version) => version.status === 'active').length,
    1,
    'one active row, whichever replacement won',
  );
});

// ---------------------------------------------------------------------------
// 4. Retrying a publication that has since been superseded
// ---------------------------------------------------------------------------

test('a retry of a publication that was later superseded returns its original result', async () => {
  const { service, repository } = build();

  const first = await service.publish(
    publishRequest({ versionId: 'ver-1', idempotencyKey: 'idem-1' }),
  );
  const second = await service.publish(
    publishRequest({
      versionId: 'ver-2',
      idempotencyKey: 'idem-2',
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-15T00:00:00Z',
    }),
  );

  const committedBefore = repository.transactionsCommitted;

  // A redelivery of the *first* publication, arriving after the second replaced it. It names the
  // incumbent that publication superseded — none — which is what makes it a retry rather than a
  // request to reinstate a retired version.
  const retry = await service.publishDraft({
    draftId: first.version.versionId,
    expectedActiveVersionId: null,
    now: '2026-03-01T00:00:00Z',
  });

  assert.equal(retry.deduplicated, true);
  assert.equal(retry.version.versionId, first.version.versionId);
  assert.equal(retry.supersededVersionId, null, 'the original publication superseded nothing');
  assert.equal(
    retry.version.publishedAt,
    first.version.publishedAt,
    'the original publication instant stands; a retry does not republish',
  );
  assert.equal(retry.version.status, 'superseded', 'and it reports the version as it now is');

  const active = repository.snapshot().filter((version) => version.status === 'active');
  assert.deepEqual(
    active.map((version) => version.versionId),
    [second.version.versionId],
    'the retry changed nothing: the current incumbent is still the incumbent',
  );
  assert.equal(
    repository.transactionsCommitted,
    committedBefore + 1,
    'one read-only transaction, no second activation',
  );
});

test('a superseded version cannot be reinstated by naming the current incumbent', async () => {
  const { service, repository } = build();

  const first = await service.publish(
    publishRequest({ versionId: 'ver-1', idempotencyKey: 'idem-1' }),
  );
  const second = await service.publish(
    publishRequest({
      versionId: 'ver-2',
      idempotencyKey: 'idem-2',
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-15T00:00:00Z',
    }),
  );

  await assert.rejects(
    service.publishDraft({
      draftId: first.version.versionId,
      expectedActiveVersionId: second.version.versionId,
      now: '2026-03-01T00:00:00Z',
    }),
    (error: unknown) => codeOf(error) === 'not-a-draft',
    'this is a new activation of a retired version, not a redelivery of an old one',
  );

  const active = repository.snapshot().filter((version) => version.status === 'active');
  assert.deepEqual(
    active.map((version) => version.versionId),
    [second.version.versionId],
  );
});

test('a retry through publish() is answered from the idempotency key after supersession', async () => {
  const { service } = build();

  const first = await service.publish(
    publishRequest({ versionId: 'ver-1', idempotencyKey: 'idem-1' }),
  );
  await service.publish(
    publishRequest({
      versionId: 'ver-2',
      idempotencyKey: 'idem-2',
      value: 1800,
      effectiveFrom: '2026-02-01T00:00:00Z',
      expectedActiveVersionId: first.version.versionId,
      now: '2026-01-15T00:00:00Z',
    }),
  );

  const retry = await service.publish(
    publishRequest({ versionId: 'ver-1', idempotencyKey: 'idem-1' }),
  );
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.version.versionId, 'ver-1');
  assert.equal(retry.version.status, 'superseded');
});

// ---------------------------------------------------------------------------
// 5. The adapter: driver errors become refusals, and the transaction rolls back
// ---------------------------------------------------------------------------

test('a unique violation on the active index becomes a race refusal, and rolls back', async () => {
  const database = new RecordingDatabase({
    failures: [
      {
        match: /UPDATE[\s\S]*status = 'active'/,
        error: sqlstateError(
          'duplicate key value violates unique constraint ' +
            '"config_version_one_active_per_scope"',
          '23505',
          'config_version_one_active_per_scope',
        ),
      },
    ],
  });
  const repository = new PostgresConfigurationRepository(database);

  await assert.rejects(
    repository.withTransaction((tx) => tx.activateDraft('ver-2', '2026-02-01T00:00:00Z', null)),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError, 'a raw driver error is not actionable');
      assert.equal(error.code, 'concurrent-modification');
      assert.match(error.message, /another publication activated a version/);
      return true;
    },
  );

  const statements = database.statements();
  assert.ok(statements.includes('ROLLBACK;'), 'the failed publication rolled back');
  assert.ok(!statements.includes('COMMIT;'), 'and did not commit');
  assert.equal(database.sessionsReleased, 1, 'the session was released');
});

test('a unique violation on the idempotency key and on the primary key are told apart', async () => {
  const cases = [
    ['config_version_idempotency_unique', 'idempotency-key-reuse'],
    ['config_version_pkey', 'immutable-version'],
  ] as const;

  for (const [constraint, expected] of cases) {
    const database = new RecordingDatabase({
      failures: [
        {
          match: /INSERT INTO/,
          error: sqlstateError(
            `duplicate key value violates unique constraint "${constraint}"`,
            '23505',
            constraint,
          ),
        },
      ],
    });
    const repository = new PostgresConfigurationRepository(database);

    await assert.rejects(
      repository.withTransaction((tx) =>
        tx.insertDraft({
          versionId: 'ver-1',
          key: KEY,
          scope: GLOBAL_SCOPE,
          value: 900,
          effectiveFrom: '2026-01-01T00:00:00Z',
          status: 'draft',
          createdAt: '2026-01-01T00:00:00Z',
          publishedAt: null,
          supersededAt: null,
          previousVersionId: null,
          idempotencyKey: 'idem-1',
          origin: 'human',
        }),
      ),
      (error: unknown) => codeOf(error) === expected,
      `${constraint} means ${expected}`,
    );
    assert.ok(database.statements().includes('ROLLBACK;'));
  }
});

test('an unrecognised driver failure is passed through untouched', async () => {
  const database = new RecordingDatabase({
    failures: [{ match: /UPDATE/, error: sqlstateError('could not write to disk', '58030') }],
  });
  const repository = new PostgresConfigurationRepository(database);

  await assert.rejects(
    repository.withTransaction((tx) => tx.activateDraft('ver-2', '2026-02-01T00:00:00Z', null)),
    (error: unknown) => {
      assert.ok(
        !(error instanceof ConfigurationError),
        'an I/O failure dressed up as a race would be retried forever by a caller that retries races',
      );
      assert.match((error as Error).message, /could not write to disk/);
      return true;
    },
  );
});

test('a unique violation with no constraint name is recognised from the message', async () => {
  const database = new RecordingDatabase({
    failures: [
      {
        match: /UPDATE/,
        error: sqlstateError(
          'duplicate key value violates unique constraint ' +
            '"config_version_one_active_per_scope"',
          '23505',
        ),
      },
    ],
  });
  const repository = new PostgresConfigurationRepository(database);

  await assert.rejects(
    repository.withTransaction((tx) => tx.activateDraft('ver-2', '2026-02-01T00:00:00Z', null)),
    (error: unknown) => codeOf(error) === 'concurrent-modification',
  );
});

test('the platform client exposes SQLSTATE and the constraint, and nothing else', () => {
  const detail = databaseErrorDetail(
    sqlstateError('duplicate key', '23505', 'config_version_one_active_per_scope'),
  );
  assert.equal(detail.code, '23505');
  assert.equal(detail.constraint, 'config_version_one_active_per_scope');

  // Absent rather than present-and-undefined, so a caller cannot mistake "the driver said
  // nothing" for "the driver reported no code".
  assert.deepEqual(databaseErrorDetail(new Error('plain')), {});
  assert.deepEqual(databaseErrorDetail(null), {});
  assert.deepEqual(databaseErrorDetail('a string'), {});
  assert.deepEqual(databaseErrorDetail({ code: 42 }), {}, 'a non-string code is not a SQLSTATE');
  assert.deepEqual(databaseErrorDetail({ constraint: 'only_this' }), { constraint: 'only_this' });
});

test('the adapter preserves microsecond precision it reads back', async () => {
  const database = new RecordingDatabase({
    selects: [
      {
        match: /WHERE version_id = \$1/,
        rows: [row({ effective_from: '2026-01-01 00:00:00.000500+00', status: 'draft' })],
      },
    ],
  });
  const repository = new PostgresConfigurationRepository(database);

  const version = await repository.withTransaction((tx) => tx.findVersionById('ver-1'));
  assert.equal(
    version?.effectiveFrom,
    '2026-01-01T00:00:00.0005Z',
    'truncating to milliseconds here would merge two instants that publication kept apart',
  );
  assert.equal(
    compareInstants(version?.effectiveFrom ?? '', '2026-01-01T00:00:00Z'),
    1,
    'and it still orders after the whole second',
  );
});

test('the adapter renders one moment one way', async () => {
  const cases = [
    ['2026-01-01 00:00:00+00', '2026-01-01T00:00:00Z'],
    ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z'],
    ['2026-01-01 00:00:00.120000+00:00', '2026-01-01T00:00:00.12Z'],
  ] as const;

  for (const [stored, expected] of cases) {
    const database = new RecordingDatabase({
      selects: [{ match: /WHERE version_id = \$1/, rows: [row({ effective_from: stored })] }],
    });
    const repository = new PostgresConfigurationRepository(database);
    const version = await repository.withTransaction((tx) => tx.findVersionById('ver-1'));
    assert.equal(version?.effectiveFrom, expected, `${stored} renders as ${expected}`);
  }
});
