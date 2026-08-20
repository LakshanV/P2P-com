/**
 * K-06 Policy Engine — lifecycle, idempotency, races and append-only history (FND-005b).
 *
 * The scenario behind this file is two people changing a commission rate at the same time.
 *
 * Both read the version in force, both publish, both activate. If the store lets both activations
 * land, the policy's history says two versions were authoritative at once — and every transaction
 * priced in between holds a `policy_version_id` that may or may not describe what it was charged.
 * That is unrecoverable: there is no later query that can decide which one applied. So activation
 * is **guarded**, and the guard is checked at commit against the store as it stands rather than
 * against the snapshot the transaction read.
 *
 * The idempotency cases are the same risk arriving through a retry. A key reused with a changed
 * rate must not converge, because converging would hand the caller a version id describing a policy
 * it did not write — and that id is what gets pinned into a financial record as the explanation for
 * an amount it never justified.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryPolicyRepository,
  PolicyError,
  PolicyService,
  type PolicyRepository,
  type PolicyVersion,
  type PolicyTransaction,
} from '../kernel/policy-engine/index.ts';

import {
  AUTHORITY,
  FixedClock,
  POLICY,
  POLICY_CONSOLE,
  SELLER,
  build,
  draftRequest,
  nextId,
  rate,
  withActivePolicy,
} from './helpers/policy-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof PolicyError ? error.code : undefined;

const outputs = (units: string) => ({
  rate: { kind: 'decimal', value: rate(units) },
  holdSeconds: { kind: 'duration-seconds', value: 0 },
});

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
class GatedRepository implements PolicyRepository {
  readonly store = new InMemoryPolicyRepository();
  #hold: Promise<void> | null = null;
  #signal: (() => void) | null = null;

  holdNextAt(hold: Promise<void>, signal: () => void): void {
    this.#hold = hold;
    this.#signal = signal;
  }

  async withTransaction<T>(body: (tx: PolicyTransaction) => Promise<T>): Promise<T> {
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

test('a draft is not a version, and a version is not in force', async () => {
  const harness = build();
  const drafted = await harness.service.draft(draftRequest());

  assert.equal(harness.repository.versions().length, 0, 'drafting publishes nothing');
  await assert.rejects(
    harness.service.evaluate({ policyKey: POLICY }),
    (error: unknown) => codeOf(error) === 'no-such-policy',
    'a draft decides nothing',
  );

  const published = await harness.service.publish({
    policyVersionId: nextId('polver'),
    draftId: drafted.draft.draftId,
    idempotencyKey: nextId('idem'),
  });
  assert.equal(published.version.version, 1);
  assert.equal(published.version.draftId, drafted.draft.draftId, 'traceable to what was reviewed');
  await assert.rejects(
    harness.service.evaluate({ policyKey: POLICY }),
    (error: unknown) => codeOf(error) === 'no-such-policy',
    'publishing is not activating',
  );

  await harness.service.activate({
    activationId: nextId('act'),
    policyVersionId: published.version.policyVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });
  assert.equal((await harness.service.evaluate({ policyKey: POLICY })).version, 1);
});

test('a version is published from a draft verbatim, with no way to change the content', async () => {
  // The publish request carries no rules, no schema and no outputs, so what goes live is what was
  // reviewed. A field that could change it would make review advisory.
  const harness = build();
  const drafted = await harness.service.draft(
    draftRequest({ rules: [{ ruleId: 'rule_01HQZXREVIEW1', selector: {}, condition: null, outputs: outputs('1000') }] }),
  );

  await assert.rejects(
    harness.service.publish({
      policyVersionId: nextId('polver'),
      draftId: drafted.draft.draftId,
      rules: [{ ruleId: 'rule_01HQZXSNEAKY1', selector: {}, condition: null, outputs: outputs('9000') }],
      idempotencyKey: nextId('idem'),
    } as never),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as Error).message, /does not accept the field "rules"/);
      return true;
    },
  );

  const published = await harness.service.publish({
    policyVersionId: nextId('polver'),
    draftId: drafted.draft.draftId,
    idempotencyKey: nextId('idem'),
  });
  assert.deepEqual(published.version.rules, drafted.draft.rules);
});

test('version numbers are assigned by the store and count up per policy', async () => {
  const harness = build();
  for (const expected of [1, 2, 3]) {
    const drafted = await harness.service.draft(draftRequest());
    const published = await harness.service.publish({
      policyVersionId: nextId('polver'),
      draftId: drafted.draft.draftId,
      idempotencyKey: nextId('idem'),
    });
    assert.equal(published.version.version, expected);
  }

  await assert.rejects(
    harness.service.publish({
      policyVersionId: nextId('polver'),
      draftId: 'draft_01HQZXNOTHERE',
      version: 7,
      idempotencyKey: nextId('idem'),
    } as never),
    (error: unknown) => codeOf(error) === 'malformed-record',
    'a caller choosing its own version number could publish under an older one',
  );
});

test('publishing a draft that does not exist is refused', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.publish({
      policyVersionId: nextId('polver'),
      draftId: 'draft_01HQZXNOTHERE',
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'no-such-version');
      assert.match((error as Error).message, /something that was reviewed/);
      return true;
    },
  );
});

test('a retired policy accepts no further writes, and its versions stay readable', async () => {
  const { harness, version } = await withActivePolicy();
  await harness.service.retire({
    retirementId: nextId('ret'),
    policyKey: POLICY,
    reason: 'the commission model moved to the new tier structure',
    idempotencyKey: nextId('idem'),
  });

  await assert.rejects(
    harness.service.draft(draftRequest()),
    (error: unknown) => {
      assert.equal(codeOf(error), 'policy-retired');
      assert.match((error as Error).message, /make the retirement advisory/);
      return true;
    },
  );

  // The version transactions were priced under is still there, unchanged.
  const stored = harness.repository
    .versions()
    .find((entry) => entry.policyVersionId === version.policyVersionId);
  assert.deepEqual(stored?.rules, version.rules, 'retirement is not erasure');
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('an identical retry converges rather than drafting twice', async () => {
  const harness = build();
  const request = draftRequest();

  const first = await harness.service.draft(request);
  const second = await harness.service.draft(request);

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.deepEqual(second.draft, first.draft);
  assert.equal(harness.repository.drafts().length, 1);
});

test('a key reused with any authority-bearing input changed is refused', async () => {
  const harness = build();
  const request = draftRequest();
  await harness.service.draft(request);

  const changes: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a changed rate', { rules: [{ ruleId: 'rule_01HQZXGLOBAL1', selector: {}, condition: null, outputs: outputs('9999') }] }],
    ['a changed rule id', { rules: [{ ruleId: 'rule_01HQZXRENAME1', selector: {}, condition: null, outputs: outputs('1000') }] }],
    ['a narrowed selector', { rules: [{ ruleId: 'rule_01HQZXGLOBAL1', selector: { seller: SELLER }, condition: null, outputs: outputs('1000') }] }],
    ['a changed draft id', { draftId: nextId('draft') }],
    ['added defaults', { defaultOutputs: outputs('500') }],
    ['changed notes', { notes: 'approved by the commercial committee' }],
  ];

  for (const [why, change] of changes) {
    await assert.rejects(
      harness.service.draft({ ...request, ...change }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'idempotency-key-reuse', why);
        assert.match((error as Error).message, /pinned into a financial record/);
        return true;
      },
      `${why} under the same key must be refused`,
    );
  }
  assert.equal(harness.repository.drafts().length, 1);
});

test('a retry that differs only in key order or decimal spelling still converges', async () => {
  // The canonical form exists for this: two requests that say the same thing are the same request.
  const harness = build();
  const key = nextId('idem');
  const draftId = nextId('draft');
  const base = {
    draftId,
    policyKey: POLICY,
    outputSchema: {
      holdSeconds: { kind: 'duration-seconds', minimum: 0, maximum: 7_776_000 },
      rate: { kind: 'decimal', scale: 4, minimum: rate('0'), maximum: rate('10000') },
    },
    rules: [{ ruleId: 'rule_01HQZXORDER01', selector: {}, condition: null, outputs: outputs('1000') }],
    idempotencyKey: key,
  };

  const first = await harness.service.draft(base);
  const second = await harness.service.draft({
    ...base,
    outputSchema: {
      rate: { kind: 'decimal', scale: 4, minimum: rate('0'), maximum: rate('10000') },
      holdSeconds: { kind: 'duration-seconds', minimum: 0, maximum: 7_776_000 },
    },
  });

  assert.equal(second.deduplicated, true);
  assert.equal(second.draft.draftId, first.draft.draftId);
});

test('an idempotent publish, activation and retirement each converge', async () => {
  const harness = build();
  const drafted = await harness.service.draft(draftRequest());
  const publish = {
    policyVersionId: nextId('polver'),
    draftId: drafted.draft.draftId,
    idempotencyKey: nextId('idem'),
  };
  const first = await harness.service.publish(publish);
  assert.equal((await harness.service.publish(publish)).deduplicated, true);
  assert.equal(harness.repository.versions().length, 1);

  const activate = {
    activationId: nextId('act'),
    policyVersionId: first.version.policyVersionId,
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  };
  await harness.service.activate(activate);
  assert.equal((await harness.service.activate(activate)).deduplicated, true);
  assert.equal(harness.repository.activations().length, 1);

  const retire = {
    retirementId: nextId('ret'),
    policyKey: POLICY,
    reason: 'superseded by the new tier structure',
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

test('two operators activating different versions: one wins and one is told it lost', async () => {
  const harness = build();
  const versions: PolicyVersion[] = [];
  for (let index = 0; index < 3; index += 1) {
    const drafted = await harness.service.draft(draftRequest());
    versions.push(
      (
        await harness.service.publish({
          policyVersionId: nextId('polver'),
          draftId: drafted.draft.draftId,
          idempotencyKey: nextId('idem'),
        })
      ).version,
    );
  }

  await harness.service.activate({
    activationId: nextId('act'),
    policyVersionId: versions[0]?.policyVersionId ?? '',
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  // Both operators read the first as in force and both decide to move on from it.
  await harness.service.activate({
    activationId: nextId('act'),
    policyVersionId: versions[1]?.policyVersionId ?? '',
    supersedesVersionId: versions[0]?.policyVersionId ?? null,
    idempotencyKey: nextId('idem'),
  });

  await assert.rejects(
    harness.service.activate({
      activationId: nextId('act'),
      policyVersionId: versions[2]?.policyVersionId ?? '',
      supersedesVersionId: versions[0]?.policyVersionId ?? null,
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'stale-activation');
      assert.match((error as Error).message, /Re-read the version in force/);
      return true;
    },
  );

  assert.equal(harness.repository.activations().length, 2, 'the loser wrote nothing');
  assert.equal((await harness.service.evaluate({ policyKey: POLICY })).version, 2);
});

test('two first activations for one policy cannot both land', async () => {
  // The NULL case, which a plain unique constraint would miss: NULLs do not conflict.
  const harness = build();
  const made: PolicyVersion[] = [];
  for (let index = 0; index < 2; index += 1) {
    const drafted = await harness.service.draft(draftRequest());
    made.push(
      (
        await harness.service.publish({
          policyVersionId: nextId('polver'),
          draftId: drafted.draft.draftId,
          idempotencyKey: nextId('idem'),
        })
      ).version,
    );
  }

  await harness.service.activate({
    activationId: nextId('act'),
    policyVersionId: made[0]?.policyVersionId ?? '',
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });
  await assert.rejects(
    harness.service.activate({
      activationId: nextId('act'),
      policyVersionId: made[1]?.policyVersionId ?? '',
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
  const service = new PolicyService({
    repository,
    clock: new FixedClock(),
    authority: POLICY_CONSOLE,
  });

  const versions: PolicyVersion[] = [];
  for (let index = 0; index < 3; index += 1) {
    const drafted = await service.draft(draftRequest());
    versions.push(
      (
        await service.publish({
          policyVersionId: nextId('polver'),
          draftId: drafted.draft.draftId,
          idempotencyKey: nextId('idem'),
        })
      ).version,
    );
  }
  await service.activate({
    activationId: nextId('act'),
    policyVersionId: versions[0]?.policyVersionId ?? '',
    supersedesVersionId: null,
    idempotencyKey: nextId('idem'),
  });

  const held = new Latch();
  const ready = new Latch();
  repository.holdNextAt(held.promise, () => ready.release());

  const losing = repository.withTransaction(async (tx) => {
    await tx.insertActivation({
      activationId: nextId('act'),
      policyKey: POLICY,
      policyVersionId: versions[2]?.policyVersionId ?? '',
      supersedesVersionId: versions[0]?.policyVersionId ?? null,
      activatedAt: '2026-04-01T12:00:00Z',
      activatedBy: { kind: 'system', id: AUTHORITY },
      idempotencyKey: nextId('idem'),
      requestFingerprint: 'e'.repeat(64),
    });
  });

  await ready.promise;

  await service.activate({
    activationId: nextId('act'),
    policyVersionId: versions[1]?.policyVersionId ?? '',
    supersedesVersionId: versions[0]?.policyVersionId ?? null,
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

test('two identical concurrent drafts produce one draft', async () => {
  const harness = build();
  const request = draftRequest();

  const [first, second] = await Promise.allSettled([
    harness.service.draft(request),
    harness.service.draft(request),
  ]);

  assert.equal(
    [first, second].filter((outcome) => outcome.status === 'fulfilled').length,
    2,
    'an identical retry converges rather than failing',
  );
  assert.equal(harness.repository.drafts().length, 1);
});

// ---------------------------------------------------------------------------
// Append-only
// ---------------------------------------------------------------------------

test('the port offers no way to update or delete anything', () => {
  const repository = new InMemoryPolicyRepository();
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
  const harness = build();
  const drafted = await harness.service.draft(draftRequest());

  await assert.rejects(
    harness.repository.withTransaction(async (tx) => {
      await tx.insertRetirement({
        retirementId: nextId('ret'),
        policyKey: POLICY,
        reason: 'changed my mind halfway through',
        retiredAt: '2026-04-01T12:00:00Z',
        retiredBy: { kind: 'system', id: AUTHORITY },
        idempotencyKey: nextId('idem'),
        requestFingerprint: 'f'.repeat(64),
      });
      throw new Error('the caller changed its mind');
    }),
  );

  assert.equal(harness.repository.retirements().length, 0, 'half a retirement is not one');
  assert.equal(harness.repository.drafts().length, 1, 'and the draft is untouched');
  assert.equal(drafted.draft.policyKey, POLICY);
});
