/**
 * K-11 Commerce Unit Registry — lifecycle, idempotency, races and append-only history (FND-005c).
 *
 * The scenario behind this file is two registrars changing one category at the same time.
 *
 * Both read the version in force, both publish, both activate. If the store lets both activations
 * land, the registry's history says two definitions described listings at once — and every listing
 * created in between holds a `typeVersionId` that may or may not be the one that described it.
 * There is no later query that can decide which, because the disagreement is the history itself.
 * So activation is **guarded**, and the guard is checked at commit against the store as it stands
 * rather than against the snapshot the transaction read.
 *
 * The idempotency cases are the same risk arriving through a retry: a key reused with a changed
 * parent must not converge, because converging hands back the id of a category the caller did not
 * register — and that id is copied into every listing created under it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommerceUnitError,
  CommerceUnitRegistryService,
  InMemoryCommerceUnitRepository,
  type CommerceUnitRepository,
  type CommerceUnitTransaction,
  type UnitTypeVersion,
} from '../kernel/commerce-unit-registry/index.ts';

import {
  AUTHORITY,
  BRANCH,
  FixedClock,
  PLATFORM_REGISTRAR,
  RISK_POLICY,
  ROOT,
  build,
  nextId,
  publishRequest,
  withActiveType,
  withLineage,
} from './helpers/commerce-unit-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof CommerceUnitError ? error.code : undefined;

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
class GatedRepository implements CommerceUnitRepository {
  readonly store = new InMemoryCommerceUnitRepository();
  #hold: Promise<void> | null = null;
  #signal: (() => void) | null = null;

  holdNextAt(hold: Promise<void>, signal: () => void): void {
    this.#hold = hold;
    this.#signal = signal;
  }

  async withTransaction<T>(body: (tx: CommerceUnitTransaction) => Promise<T>): Promise<T> {
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

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

test('a published type is not in force until it is activated', async () => {
  const harness = build();
  const published = await harness.service.publish(publishRequest());
  assert.equal(published.version.version, 1);

  await assert.rejects(
    harness.service.resolve({ typeKey: ROOT }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'no-such-type');
      assert.match((error as Error).message, /no version defines/);
      return true;
    },
    'a category nobody activated describes nothing',
  );

  await harness.service.activate({
    activationId: nextId('act'),
    typeVersionId: published.version.typeVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });
  assert.equal((await harness.service.resolve({ typeKey: ROOT })).version, 1);
});

test('version numbers are assigned by the store and count up per type', async () => {
  const harness = build();
  for (const expected of [1, 2, 3]) {
    const published = await harness.service.publish(publishRequest());
    assert.equal(published.version.version, expected);
  }
});

test('activating a version that does not exist is refused', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.activate({
      activationId: nextId('act'),
      typeVersionId: 'typever_01HQZXNOTHER',
      supersedesVersionId: null,
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'no-such-version');
      assert.match((error as Error).message, /Publish it before activating it/);
      return true;
    },
  );
});

test('a retired type accepts no further writes, and its versions stay readable', async () => {
  const { harness, version } = await withActiveType();
  await harness.service.retire({
    retirementId: nextId('ret'),
    typeKey: ROOT,
    reason: 'the category was folded into the new taxonomy',
    idempotencyKey: nextId('idem'),
  });

  await assert.rejects(harness.service.publish(publishRequest()), (error: unknown) => {
    assert.equal(codeOf(error), 'type-retired');
    assert.match((error as Error).message, /make the retirement advisory/);
    return true;
  });
  await assert.rejects(harness.service.resolve({ typeKey: ROOT }), (error: unknown) => {
    assert.equal(codeOf(error), 'type-retired');
    assert.match((error as Error).message, /still reference them/);
    return true;
  });

  // The version listings were created under is still there, unchanged.
  const stored = harness.repository
    .versions()
    .find((entry) => entry.typeVersionId === version.typeVersionId);
  assert.deepEqual(stored?.measures, version.measures, 'retirement is not erasure');
});

// ---------------------------------------------------------------------------
// Policy provenance
// ---------------------------------------------------------------------------

test('activation pins the K-06 policy version, and K-11 reads nothing else from it', async () => {
  const harness = build();
  harness.policy.answerWith({ policyVersionId: 'polver_01HQZXPINNED' });
  await withActiveType(harness, { riskPolicyKey: RISK_POLICY });

  const resolved = await harness.service.resolve({ typeKey: ROOT });
  assert.equal(resolved.riskPolicyKey, RISK_POLICY);
  assert.equal(resolved.riskPolicyVersionId, 'polver_01HQZXPINNED');
  assert.match(resolved.explanation, /pins risk policy version polver_01HQZXPINNED/);

  assert.equal(harness.policy.asked.length, 1, 'asked once, at activation');
  assert.equal(harness.policy.asked[0]?.policyKey, RISK_POLICY);
});

test('K-06 is not consulted for a type that names no risk policy', async () => {
  const { harness } = await withActiveType();
  assert.deepEqual(harness.policy.asked, []);
  assert.equal((await harness.service.resolve({ typeKey: ROOT })).riskPolicyVersionId, null);
});

test('a risk policy K-06 cannot resolve refuses the activation rather than pinning nothing', async () => {
  const harness = build();
  harness.policy.answerWith({ refuseWith: new Error('no version of that policy is in force') });
  const published = await harness.service.publish(publishRequest({ riskPolicyKey: RISK_POLICY }));

  await assert.rejects(
    harness.service.activate({
      activationId: nextId('act'),
      typeVersionId: published.version.typeVersionId,
      supersedesVersionId: null,
      idempotencyKey: nextId('idem'),
    }),
    /no version of that policy is in force/,
    'a version id recorded without being resolved would look like evidence',
  );
  assert.equal(harness.repository.activations().length, 0);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('an identical retry converges rather than publishing twice', async () => {
  const harness = build();
  const request = publishRequest();

  const first = await harness.service.publish(request);
  const second = await harness.service.publish(request);

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.deepEqual(second.version, first.version);
  assert.equal(harness.repository.versions().length, 1);
});

test('a key reused with any authority-bearing input changed is refused', async () => {
  const harness = build();
  const request = publishRequest();
  await harness.service.publish(request);

  const changes: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a changed parent', { parentTypeKey: BRANCH }],
    ['a changed kind', { kind: 'used-product' }],
    ['a changed type key', { typeKey: BRANCH }],
    ['a changed measure set', { measures: [{ family: 'goods', unit: 'tonne' }] }],
    ['an added risk policy', { riskPolicyKey: RISK_POLICY }],
    ['a changed version id', { typeVersionId: nextId('typever') }],
    ['an added window', { effectiveFrom: '2026-05-01T00:00:00Z' }],
  ];

  for (const [why, change] of changes) {
    await assert.rejects(
      harness.service.publish({ ...request, ...change }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'idempotency-key-reuse', why);
        assert.match((error as Error).message, /copied into every listing/);
        return true;
      },
      `${why} under the same key must be refused`,
    );
  }
  assert.equal(harness.repository.versions().length, 1);
});

test('a retry that differs only in the order the measures were written still converges', async () => {
  // The canonical form exists for this: two requests saying the same thing are one request.
  const harness = build();
  const base = publishRequest({
    measures: [
      { family: 'goods', unit: 'kilogram' },
      { family: 'goods', unit: 'each' },
    ],
  });

  const first = await harness.service.publish(base);
  const second = await harness.service.publish({
    ...base,
    measures: [
      { family: 'goods', unit: 'each' },
      { family: 'goods', unit: 'kilogram' },
    ],
  });

  assert.equal(second.deduplicated, true);
  assert.equal(second.version.typeVersionId, first.version.typeVersionId);
});

test('an idempotent activation and retirement each converge', async () => {
  const harness = build();
  const published = await harness.service.publish(publishRequest());
  const activate = {
    activationId: nextId('act'),
    typeVersionId: published.version.typeVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  };
  await harness.service.activate(activate);
  assert.equal((await harness.service.activate(activate)).deduplicated, true);
  assert.equal(harness.repository.activations().length, 1);

  const retire = {
    retirementId: nextId('ret'),
    typeKey: ROOT,
    reason: 'folded into the new taxonomy',
    idempotencyKey: nextId('idem'),
  };
  await harness.service.retire(retire);
  assert.equal((await harness.service.retire(retire)).deduplicated, true);
  assert.equal(harness.repository.retirements().length, 1);

  await assert.rejects(
    harness.service.retire({ ...retire, reason: 'a different reason entirely' }),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
    'the reason is part of the record, so it is part of the request being retried',
  );
});

// ---------------------------------------------------------------------------
// The activation guard
// ---------------------------------------------------------------------------

test('two registrars activating different versions: one wins and one is told it lost', async () => {
  const harness = build();
  const versions: UnitTypeVersion[] = [];
  for (let index = 0; index < 3; index += 1) {
    versions.push((await harness.service.publish(publishRequest())).version);
  }

  await harness.service.activate({
    activationId: nextId('act'),
    typeVersionId: versions[0]?.typeVersionId ?? '',
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });
  await harness.service.activate({
    activationId: nextId('act'),
    typeVersionId: versions[1]?.typeVersionId ?? '',
    supersedesVersionId: versions[0]?.typeVersionId ?? null,
    idempotencyKey: nextId('idem'),
  });

  await assert.rejects(
    harness.service.activate({
      activationId: nextId('act'),
      typeVersionId: versions[2]?.typeVersionId ?? '',
      supersedesVersionId: versions[0]?.typeVersionId ?? null,
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'stale-activation');
      assert.match((error as Error).message, /Re-read the version in force/);
      return true;
    },
  );

  assert.equal(harness.repository.activations().length, 2, 'the loser wrote nothing');
  assert.equal((await harness.service.resolve({ typeKey: ROOT })).version, 2);
});

test('two first activations for one type cannot both land', async () => {
  // The NULL case, which a plain unique constraint would miss: NULLs do not conflict.
  const harness = build();
  const first = (await harness.service.publish(publishRequest())).version;
  const second = (await harness.service.publish(publishRequest())).version;

  await harness.service.activate({
    activationId: nextId('act'),
    typeVersionId: first.typeVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });
  await assert.rejects(
    harness.service.activate({
      activationId: nextId('act'),
      typeVersionId: second.typeVersionId,
      supersedesVersionId: null,
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => codeOf(error) === 'stale-activation',
  );
});

test('an activation that loses the race at commit writes nothing at all', async () => {
  // The interleaving a read-then-write inside one transaction would miss: the guard held when this
  // transaction read, and stopped holding before it committed.
  const repository = new GatedRepository();
  const service = new CommerceUnitRegistryService({
    repository,
    clock: new FixedClock(),
    configuration: build().configuration,
    registrar: PLATFORM_REGISTRAR,
  });

  const versions: UnitTypeVersion[] = [];
  for (let index = 0; index < 3; index += 1) {
    versions.push((await service.publish(publishRequest())).version);
  }
  await service.activate({
    activationId: nextId('act'),
    typeVersionId: versions[0]?.typeVersionId ?? '',
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  const held = new Latch();
  const ready = new Latch();
  repository.holdNextAt(held.promise, () => ready.release());

  const losing = repository.withTransaction(async (tx) => {
    await tx.insertActivation({
      activationId: nextId('act'),
      typeKey: ROOT,
      typeVersionId: versions[2]?.typeVersionId ?? '',
      supersedesVersionId: versions[0]?.typeVersionId ?? null,
      riskPolicyVersionId: null,
      activatedAt: '2026-04-01T12:00:00Z',
      activatedBy: { kind: 'system', id: AUTHORITY },
      idempotencyKey: nextId('idem'),
      requestFingerprint: 'e'.repeat(64),
    });
  });

  await ready.promise;
  await service.activate({
    activationId: nextId('act'),
    typeVersionId: versions[1]?.typeVersionId ?? '',
    supersedesVersionId: versions[0]?.typeVersionId ?? null,
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
});

test('two identical concurrent publications produce one version', async () => {
  const harness = build();
  const request = publishRequest();

  const outcomes = await Promise.allSettled([
    harness.service.publish(request),
    harness.service.publish(request),
  ]);

  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    2,
    'an identical retry converges rather than failing',
  );
  assert.equal(harness.repository.versions().length, 1);
});

test('a second retirement for one type is refused', async () => {
  const { harness } = await withActiveType();
  const retire = {
    retirementId: nextId('ret'),
    typeKey: ROOT,
    reason: 'folded into the new taxonomy',
    idempotencyKey: nextId('idem'),
  };
  await harness.service.retire(retire);

  await assert.rejects(
    harness.service.retire({
      retirementId: nextId('ret'),
      typeKey: ROOT,
      reason: 'folded again',
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => codeOf(error) === 'type-retired',
  );
  assert.equal(harness.repository.retirements().length, 1);
});

// ---------------------------------------------------------------------------
// Append-only
// ---------------------------------------------------------------------------

test('the port offers no way to update or delete anything', () => {
  const repository = new InMemoryCommerceUnitRepository();
  const operations: string[] = [];
  void repository.withTransaction((tx) => {
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
  const { harness } = await withLineage();
  const before = harness.repository.retirements().length;

  await assert.rejects(
    harness.repository.withTransaction(async (tx) => {
      await tx.insertRetirement({
        retirementId: nextId('ret'),
        typeKey: ROOT,
        reason: 'about to change my mind',
        retiredAt: '2026-04-01T12:00:00Z',
        retiredBy: { kind: 'system', id: AUTHORITY },
        idempotencyKey: nextId('idem'),
        requestFingerprint: 'f'.repeat(64),
      });
      throw new Error('the caller changed its mind');
    }),
  );

  assert.equal(harness.repository.retirements().length, before, 'half a retirement is not one');
  assert.equal((await harness.service.resolve({ typeKey: ROOT })).version, 1);
});
