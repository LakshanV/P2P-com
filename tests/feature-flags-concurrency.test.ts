/**
 * K-07 Feature Flags — idempotency, races and append-only history (FND-004e).
 *
 * The scenario this file is about is two operators reacting to the same incident. Both read the
 * current version, both decide, both act — and if the store lets both writes land, the flag's
 * history says two versions took effect at once, with nothing recording which one actually served
 * traffic. That is the exact question an incident review opens with.
 *
 * So activation is **guarded**: an activation names the version it supersedes, and one naming a
 * version that is no longer current is refused as stale. The guard is checked at commit against
 * the store as it stands, not against the snapshot the transaction read, which is what makes the
 * reference repository behave the way a server would. K-08 shipped without that parity and every
 * concurrency guarantee proved against it was worth less than it appeared
 * (CURRENT_IMPLEMENTATION_STATUS §11.15).
 *
 * The overlaps here are deterministic rather than timing-dependent: a latch holds one transaction
 * open at a chosen point while another runs to completion, so the interleaving under test is the
 * one written down and the suite does not depend on which promise the scheduler picks.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FeatureFlagError,
  FeatureFlagService,
  InMemoryFeatureFlagRepository,
  type FeatureFlagRepository,
  type FeatureFlagTransaction,
} from '../kernel/feature-flags/index.ts';

import {
  FLAG,
  FixedClock,
  RELEASE_CONSOLE,
  build,
  nextId,
  publishRequest,
  withActiveFlag,
} from './helpers/feature-flag-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof FeatureFlagError ? error.code : undefined;

/** A promise a test resolves by hand, so an interleaving is chosen rather than raced for. */
class Latch {
  #resolve: (() => void) | undefined;
  readonly promise: Promise<void>;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
  }

  release(): void {
    this.#resolve?.();
  }
}

/** A repository that can hold a transaction open at a chosen point. */
class GatedRepository implements FeatureFlagRepository {
  readonly store = new InMemoryFeatureFlagRepository();
  #hold: Promise<void> | null = null;
  #signal: (() => void) | null = null;

  holdNextAt(hold: Promise<void>, signal: () => void): void {
    this.#hold = hold;
    this.#signal = signal;
  }

  async withTransaction<T>(body: (tx: FeatureFlagTransaction) => Promise<T>): Promise<T> {
    const hold = this.#hold;
    const signal = this.#signal;
    this.#hold = null;
    this.#signal = null;

    return this.store.withTransaction(async (tx) => {
      const result = await body(tx);
      if (hold !== null) {
        signal?.();
        await hold;
      }
      return result;
    });
  }
}

/** A real service over any repository, so a gated one can be driven through the real paths. */
function serviceOn(repository: FeatureFlagRepository): FeatureFlagService {
  return new FeatureFlagService({
    repository,
    clock: new FixedClock(),
    authority: RELEASE_CONSOLE,
  });
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('an identical retry converges rather than publishing twice', async () => {
  const harness = build();
  const request = publishRequest({ state: 'percentage', percentage: 10 });

  const first = await harness.service.publish(request);
  const second = await harness.service.publish(request);

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.deepEqual(second.version, first.version);
  assert.equal(harness.repository.versions().length, 1, 'and only one version was written');
});

test('a key reused for a different definition is refused, and names what moved', async () => {
  const harness = build();
  const request = publishRequest({ state: 'percentage', percentage: 10 });
  await harness.service.publish(request);

  const changes: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['percentage', { percentage: 25 }],
    ['state', { state: 'off', percentage: 0 }],
    ['supportedScopes', { supportedScopes: ['global', 'account'] }],
    ['rolloutSalt', { rolloutSalt: 'salt09HQZXOTHER' }],
    ['notBefore', { notBefore: '2026-05-01T00:00:00Z' }],
    ['flagVersionId', { flagVersionId: nextId('flagver') }],
  ];

  for (const [field, change] of changes) {
    await assert.rejects(
      harness.service.publish({ ...request, ...change }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'idempotency-key-reuse', field);
        assert.match((error as Error).message, new RegExp(field), `the refusal must name ${field}`);
        return true;
      },
      `reusing a key while changing ${field} must be refused`,
    );
  }

  assert.equal(harness.repository.versions().length, 1);
});

test('an idempotent kill converges, and a different reason under the same key does not', async () => {
  const { harness } = await withActiveFlag(build());
  const request = {
    eventId: nextId('evt'),
    flagKey: FLAG,
    reason: 'the supplier feed started quoting in the wrong currency',
    idempotencyKey: nextId('idem'),
  };

  const first = await harness.service.kill(request);
  const second = await harness.service.kill(request);
  assert.equal(second.deduplicated, true);
  assert.deepEqual(second.event, first.event);

  await assert.rejects(
    harness.service.kill({ ...request, reason: 'something else entirely' }),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
    'the reason is part of the record, so it is part of the request being retried',
  );
  assert.equal(harness.repository.lifecycleEvents().length, 1);
});

test('an idempotent activation converges', async () => {
  const harness = build();
  const published = await harness.service.publish(publishRequest());
  const request = {
    activationId: nextId('act'),
    flagVersionId: published.version.flagVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  };

  const first = await harness.service.activate(request);
  const second = await harness.service.activate(request);
  assert.equal(second.deduplicated, true);
  assert.deepEqual(second.activation, first.activation);
  assert.equal(harness.repository.activations().length, 1);
});

// ---------------------------------------------------------------------------
// The activation guard
// ---------------------------------------------------------------------------

test('two operators activating different versions: one wins and one is told it lost', async () => {
  const harness = build();
  const first = await harness.service.publish(publishRequest({ state: 'off' }));
  const second = await harness.service.publish(publishRequest({ state: 'on' }));
  const third = await harness.service.publish(publishRequest({ state: 'off' }));

  await harness.service.activate({
    activationId: nextId('act'),
    flagVersionId: first.version.flagVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  // Both operators read `first` as current and both decide to move on from it.
  await harness.service.activate({
    activationId: nextId('act'),
    flagVersionId: second.version.flagVersionId,
    supersedesVersionId: first.version.flagVersionId,
    idempotencyKey: nextId('idem'),
  });

  await assert.rejects(
    harness.service.activate({
      activationId: nextId('act'),
      flagVersionId: third.version.flagVersionId,
      supersedesVersionId: first.version.flagVersionId,
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'stale-activation');
      assert.match((error as Error).message, /Re-read the current version/);
      return true;
    },
  );

  assert.equal(harness.repository.activations().length, 2, 'the loser wrote nothing');
  assert.equal((await harness.service.evaluate({ flagKey: FLAG })).enabled, true);
});

test('two first activations for one flag cannot both land', async () => {
  // The NULL case, which a plain unique constraint would miss: NULLs do not conflict.
  const harness = build();
  const first = await harness.service.publish(publishRequest({ state: 'on' }));
  const second = await harness.service.publish(publishRequest({ state: 'off' }));

  await harness.service.activate({
    activationId: nextId('act'),
    flagVersionId: first.version.flagVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  await assert.rejects(
    harness.service.activate({
      activationId: nextId('act'),
      flagVersionId: second.version.flagVersionId,
      supersedesVersionId: null,
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => codeOf(error) === 'stale-activation',
  );
});

test('an activation that loses the race at commit writes nothing at all', async () => {
  // The interleaving that a read-then-write inside one transaction would miss: the guard held when
  // this transaction read, and stopped holding before it committed.
  const repository = new GatedRepository();
  const harness = build({ repository: repository.store });
  const first = await harness.service.publish(publishRequest({ state: 'off' }));
  const second = await harness.service.publish(publishRequest({ state: 'on' }));
  const third = await harness.service.publish(publishRequest({ state: 'off' }));

  await harness.service.activate({
    activationId: nextId('act'),
    flagVersionId: first.version.flagVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  const held = new Latch();
  const ready = new Latch();
  repository.holdNextAt(held.promise, () => ready.release());

  const losing = repository.withTransaction(async (tx) => {
    await tx.insertActivation({
      activationId: nextId('act'),
      flagKey: FLAG,
      flagVersionId: third.version.flagVersionId,
      supersedesVersionId: first.version.flagVersionId,
      activatedAt: '2026-04-01T12:00:00Z',
      activatedBy: { kind: 'system', id: 'k07-release-console' },
      idempotencyKey: nextId('idem'),
      requestFingerprint: 'e'.repeat(64),
    });
  });

  await ready.promise;

  // While that one is held open, the other operator's activation commits.
  await harness.service.activate({
    activationId: nextId('act'),
    flagVersionId: second.version.flagVersionId,
    supersedesVersionId: first.version.flagVersionId,
    idempotencyKey: nextId('idem'),
  });

  held.release();
  await assert.rejects(
    losing,
    (error: unknown) => {
      assert.equal(codeOf(error), 'stale-activation');
      assert.match((error as Error).message, /while this one was open/);
      return true;
    },
    'the guard must be re-checked at commit, not only when the transaction read',
  );

  assert.equal(repository.store.activations().length, 2);
  assert.equal((await harness.service.evaluate({ flagKey: FLAG })).enabled, true);
});

test('two overlapping identical publications converge on one version', async () => {
  // Deterministic, not raced for. `Promise.allSettled` over two publishes *usually* overlaps, but
  // whether it does depends on which microtask the scheduler picks — and a concurrency test that
  // passes for scheduling reasons is one that stops testing concurrency the day the code changes.
  // Here the losing transaction is held open at a chosen point: after its body has run and read a
  // store with no such version in it, and before it commits.
  const gated = new GatedRepository();
  const losing = serviceOn(gated);
  const winning = serviceOn(gated.store);
  const request = publishRequest({ state: 'percentage', percentage: 10 });

  const held = new Latch();
  const ready = new Latch();
  gated.holdNextAt(held.promise, () => ready.release());

  const late = losing.publish(request);
  await ready.promise;

  // The other copy of the same call commits while this one is held.
  const first = await winning.publish(request);
  assert.equal(first.deduplicated, false);

  held.release();
  const second = await late;

  assert.equal(second.deduplicated, true, 'the loser converges rather than failing');
  assert.deepEqual(second.version, first.version, 'and converges on the row that actually landed');
  assert.equal(gated.store.versions().length, 1, 'one publication, one immutable version');
  assert.equal(gated.store.versions()[0]?.version, 1);
});

test('an overlapping publication reusing the key for a different definition is refused', async () => {
  // The other half of convergence, and the half that makes it safe. Recovering *any* row stored
  // under the key would hand the loser somebody else's definition and tell it the publication
  // succeeded. The comparison is the same one a sequential retry runs, so the two paths cannot
  // drift apart into a hole reachable only by racing.
  const gated = new GatedRepository();
  const losing = serviceOn(gated);
  const winning = serviceOn(gated.store);
  const key = nextId('idem');

  const held = new Latch();
  const ready = new Latch();
  gated.holdNextAt(held.promise, () => ready.release());

  const late = losing.publish(
    publishRequest({ state: 'percentage', percentage: 50, idempotencyKey: key }),
  );
  await ready.promise;

  await winning.publish(
    publishRequest({ state: 'percentage', percentage: 10, idempotencyKey: key }),
  );

  held.release();
  await assert.rejects(
    late,
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match((error as Error).message, /percentage/, 'the refusal names what moved');
      return true;
    },
    'a key reused for a different definition must not converge, however the race falls',
  );

  const stored = gated.store.versions();
  assert.equal(stored.length, 1, 'the loser wrote nothing');
  assert.equal(stored[0]?.percentage, 10, 'and the winner is intact');
});

test('two overlapping publications competing for one version number: one wins, one writes nothing', async () => {
  // Different idempotency keys, so there is nothing to converge on: both bodies read
  // `highestVersion` as 0 and both compute version 1. Exactly one may land, or "the definition of
  // the day" has two answers for every evaluation replayed against it.
  const gated = new GatedRepository();
  const losing = serviceOn(gated);
  const winning = serviceOn(gated.store);

  const held = new Latch();
  const ready = new Latch();
  gated.holdNextAt(held.promise, () => ready.release());

  const late = losing.publish(publishRequest({ state: 'off' }));
  await ready.promise;

  const first = await winning.publish(publishRequest({ state: 'on' }));
  assert.equal(first.version.version, 1);

  held.release();
  await assert.rejects(late, (error: unknown) => {
    assert.equal(codeOf(error), 'duplicate-flag-version');
    assert.match((error as Error).message, /while this one was open/);
    return true;
  });

  const stored = gated.store.versions();
  assert.equal(stored.length, 1, 'the losing publication left nothing behind');
  assert.equal(stored[0]?.state, 'on');
});

test('two overlapping kills: one records the stop, the other is told the flag is already terminal', async () => {
  // Two operators reaching for the same emergency stop. One row records when the feature actually
  // stopped; a second would rewrite that, and it is the first question an incident review asks.
  const gated = new GatedRepository();
  const { harness } = await withActiveFlag(build({ repository: gated.store }));
  const losing = serviceOn(gated);

  const held = new Latch();
  const ready = new Latch();
  gated.holdNextAt(held.promise, () => ready.release());

  const late = losing.kill({
    eventId: nextId('evt'),
    flagKey: FLAG,
    reason: 'the second operator saw the same alert',
    idempotencyKey: nextId('idem'),
  });
  await ready.promise;

  await harness.service.kill({
    eventId: nextId('evt'),
    flagKey: FLAG,
    reason: 'incident 4471: supplier feed quoting in the wrong currency',
    idempotencyKey: nextId('idem'),
  });

  held.release();
  await assert.rejects(
    late,
    (error: unknown) => {
      assert.equal(codeOf(error), 'flag-terminated');
      return true;
    },
    'a losing kill must not append a second stop',
  );

  const events = gated.store.lifecycleEvents();
  assert.equal(events.length, 1, 'one stop, one record of when the feature stopped');
  assert.match(events[0]?.reason ?? '', /incident 4471/);
});

test('a retirement racing a kill is refused: terminal means terminal, not terminal per kind', async () => {
  // The case a `UNIQUE (flag_key, kind)` constraint would have let through. Sequentially the
  // service refuses it; under a race only the commit-time check can, and a flag carrying both a
  // kill and a retirement is a history with two answers to "when did this stop".
  const gated = new GatedRepository();
  const { harness } = await withActiveFlag(build({ repository: gated.store }));
  const losing = serviceOn(gated);

  const held = new Latch();
  const ready = new Latch();
  gated.holdNextAt(held.promise, () => ready.release());

  const late = losing.retire({
    eventId: nextId('evt'),
    flagKey: FLAG,
    reason: 'tidying up a flag that shipped last quarter',
    idempotencyKey: nextId('idem'),
  });
  await ready.promise;

  await harness.service.kill({
    eventId: nextId('evt'),
    flagKey: FLAG,
    reason: 'incident 4471: supplier feed quoting in the wrong currency',
    idempotencyKey: nextId('idem'),
  });

  held.release();
  await assert.rejects(late, (error: unknown) => codeOf(error) === 'flag-terminated');

  const events = gated.store.lifecycleEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, 'kill');
});

test('every losing guarded mutation leaves the store exactly as the winner left it', async () => {
  // One assertion over all three write paths: whatever a losing transaction had queued — a
  // version, an activation, a lifecycle event — none of it is visible afterwards, and the flag
  // still evaluates from what the winner wrote. Partial history is worse than no history: it
  // reads as a complete record of something that never happened.
  const gated = new GatedRepository();
  const { harness, version } = await withActiveFlag(build({ repository: gated.store }), {
    state: 'on',
  });
  const losing = serviceOn(gated);

  const before = {
    versions: gated.store.versions().length,
    activations: gated.store.activations().length,
    lifecycle: gated.store.lifecycleEvents().length,
  };

  // A losing activation: it reads `version` as current, then somebody else moves the flag on.
  const replacement = await harness.service.publish(publishRequest({ state: 'off' }));
  const held = new Latch();
  const ready = new Latch();
  gated.holdNextAt(held.promise, () => ready.release());

  const late = losing.activate({
    activationId: nextId('act'),
    flagVersionId: replacement.version.flagVersionId,
    supersedesVersionId: version.flagVersionId,
    idempotencyKey: nextId('idem'),
  });
  await ready.promise;

  const third = await harness.service.publish(publishRequest({ state: 'on' }));
  await harness.service.activate({
    activationId: nextId('act'),
    flagVersionId: third.version.flagVersionId,
    supersedesVersionId: version.flagVersionId,
    idempotencyKey: nextId('idem'),
  });

  held.release();
  await assert.rejects(late, (error: unknown) => codeOf(error) === 'stale-activation');

  assert.equal(gated.store.versions().length, before.versions + 2, 'both publications landed');
  assert.equal(
    gated.store.activations().length,
    before.activations + 1,
    'but only one further activation did',
  );
  assert.equal(gated.store.lifecycleEvents().length, before.lifecycle);

  const evaluation = await harness.service.evaluate({ flagKey: FLAG });
  assert.equal(evaluation.flagVersionId, third.version.flagVersionId, 'the winner is what runs');
  assert.equal(evaluation.enabled, true);
});

test('two different concurrent publications both land, with different version numbers', async () => {
  // Publishing is not activating, so two definitions can coexist. What must not happen is two
  // rows claiming the same version number, which would make "the definition of the day" ambiguous.
  const harness = build();
  await harness.service.publish(publishRequest({ state: 'off' }));
  await harness.service.publish(publishRequest({ state: 'on' }));

  const numbers = harness.repository.versions().map((entry) => entry.version);
  assert.deepEqual([...numbers].sort(), [1, 2]);
});

test('a second kill or retirement for one flag is refused', async () => {
  const { harness } = await withActiveFlag(build());
  const kill = {
    eventId: nextId('evt'),
    flagKey: FLAG,
    reason: 'incident 4471: supplier feed quoting in the wrong currency',
    idempotencyKey: nextId('idem'),
  };
  await harness.service.kill(kill);

  await assert.rejects(
    harness.service.kill({
      eventId: nextId('evt'),
      flagKey: FLAG,
      reason: 'incident 4471 again',
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'flag-terminated');
      return true;
    },
    'a second kill would rewrite when the feature actually stopped',
  );
  assert.equal(harness.repository.lifecycleEvents().length, 1);
});

// ---------------------------------------------------------------------------
// Append-only
// ---------------------------------------------------------------------------

test('the port offers no way to update or delete anything', () => {
  const repository = new InMemoryFeatureFlagRepository();
  const operations: string[] = [];
  void repository.withTransaction(async (tx) => {
    let proto: object | null = Object.getPrototypeOf(tx) as object;
    while (proto !== null && proto !== Object.prototype) {
      operations.push(...Object.getOwnPropertyNames(proto));
      proto = Object.getPrototypeOf(proto) as object | null;
    }
    return Promise.resolve();
  });

  const mutating = operations.filter((name) => /update|delete|remove|set[A-Z]|edit/i.test(name));
  assert.deepEqual(mutating, [], `the transaction offers ${mutating.join(', ')}`);
});

test('a refused transaction leaves no partial history behind', async () => {
  const harness = build();
  const published = await harness.service.publish(publishRequest());

  await assert.rejects(
    harness.repository.withTransaction(async (tx) => {
      await tx.insertActivation({
        activationId: nextId('act'),
        flagKey: FLAG,
        flagVersionId: published.version.flagVersionId,
        supersedesVersionId: null,
        activatedAt: '2026-04-01T12:00:00Z',
        activatedBy: { kind: 'system', id: 'k07-release-console' },
        idempotencyKey: nextId('idem'),
        requestFingerprint: 'f'.repeat(64),
      });
      throw new Error('the caller changed its mind');
    }),
  );

  assert.equal(harness.repository.activations().length, 0, 'half an activation is not one');
  assert.equal((await harness.service.evaluate({ flagKey: FLAG })).reason, 'no-such-flag');
});

test('a record handed back cannot be edited into the store', async () => {
  const harness = build();
  const published = await harness.service.publish(
    publishRequest({
      state: 'targeted',
      rules: [{ kind: 'attribute-in', attribute: 'country', values: ['country_gb001'] }],
    }),
  );

  assert.throws(() => {
    (published.version.rules[0] as { attribute: string }).attribute = 'cohort';
  });
  assert.throws(() => {
    (published.version.supportedScopes as string[]).push('account');
  });

  const stored = harness.repository.versions()[0];
  assert.deepEqual(stored?.rules[0], {
    kind: 'attribute-in',
    attribute: 'country',
    values: ['country_gb001'],
  });
});
