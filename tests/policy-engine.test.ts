/**
 * K-06 Policy Engine — the boundary, and version pinning (FND-005b).
 *
 * The claim this file exists to hold is one sentence from v3 §35: *historic transactions retain the
 * policy version originally applied.* A caller can only keep that promise if the engine hands it
 * something to store, so the first group of cases below asserts that **every successful evaluation
 * returns a policy version id** — not sometimes, not on request, and not derivable afterwards.
 *
 * The rest is the boundary. A policy key naming authority, deployment state or credentials is
 * refused with the owner named. A request stating the answer is refused by name. A request naming
 * the version it wants to be decided by is refused too, and that one is subtle: supplying a version
 * id is an ordinary input to `publish` and, on `evaluate`, an attempt to choose the economics of
 * your own transaction — which is v3 §24 read backwards.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSERTED_OUTCOME_FIELDS,
  InMemoryPolicyRepository,
  NO_AUTHORITY,
  PINNED_VERSION_FIELDS,
  PolicyError,
  PolicyService,
} from '../kernel/policy-engine/index.ts';

import {
  AUTHORITY,
  CATEGORY,
  FixedClock,
  POLICY,
  build,
  draftRequest,
  nextId,
  rate,
  withActivePolicy,
} from './helpers/policy-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof PolicyError ? error.code : undefined;

// ---------------------------------------------------------------------------
// Version pinning: the reason this component exists
// ---------------------------------------------------------------------------

test('every successful evaluation returns the version that produced it', async () => {
  const { harness, version } = await withActivePolicy();
  const decision = await harness.service.evaluate({ policyKey: POLICY });

  assert.equal(decision.policyVersionId, version.policyVersionId);
  assert.equal(decision.version, 1);
  assert.equal(typeof decision.policyVersionId, 'string');
  assert.ok(decision.policyVersionId.length > 0, 'a caller has something to store');
  assert.equal(decision.explanation.includes(version.policyVersionId), true);
});

test('a decision taken under one version is unchanged by a later one', async () => {
  // v3 §24: changing future policy must not rewrite historical economics. The old version is still
  // readable, still says what it said, and replaying against it gives the same number.
  const { harness, version: first } = await withActivePolicy(build(), {
    rules: [
      {
        ruleId: 'rule_01HQZXORIGIN1',
        selector: {},
        condition: null,
        outputs: {
          rate: { kind: 'decimal', value: rate('1000') },
          holdSeconds: { kind: 'duration-seconds', value: 3_888_000 },
        },
      },
    ],
  });

  const before = await harness.service.evaluate({ policyKey: POLICY });
  assert.deepEqual(before.outputs.rate, { kind: 'decimal', value: rate('1000') });

  // The commission changes.
  const drafted = await harness.service.draft(
    draftRequest({
      rules: [
        {
          ruleId: 'rule_01HQZXNEWRATE',
          selector: {},
          condition: null,
          outputs: {
            rate: { kind: 'decimal', value: rate('1500') },
            holdSeconds: { kind: 'duration-seconds', value: 3_888_000 },
          },
        },
      ],
    }),
  );
  const second = await harness.service.publish({
    policyVersionId: nextId('polver'),
    draftId: drafted.draft.draftId,
    idempotencyKey: nextId('idem'),
  });
  await harness.service.activate({
    activationId: nextId('act'),
    policyVersionId: second.version.policyVersionId,
    supersedesVersionId: first.policyVersionId,
    idempotencyKey: nextId('idem'),
  });

  const after = await harness.service.evaluate({ policyKey: POLICY });
  assert.deepEqual(after.outputs.rate, { kind: 'decimal', value: rate('1500') }, 'new rate now');
  assert.notEqual(after.policyVersionId, before.policyVersionId);

  // And the version the earlier transaction pinned still says 10%.
  const pinned = harness.repository
    .versions()
    .find((entry) => entry.policyVersionId === before.policyVersionId);
  assert.deepEqual(pinned?.rules[0]?.outputs.rate, { kind: 'decimal', value: rate('1000') });
});

test('an evaluation may not name the version it wants to be decided by', async () => {
  const { harness } = await withActivePolicy();
  for (const field of Object.keys(PINNED_VERSION_FIELDS)) {
    await assert.rejects(
      harness.service.evaluate({ policyKey: POLICY, [field]: 'polver_01HQZXCHOSEN' }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'caller-asserted-outcome', field);
        return true;
      },
      `evaluate must refuse "${field}": the version in force decides, not the caller`,
    );
  }
});

test('a request that states the answer is refused by name', async () => {
  const { harness } = await withActivePolicy();
  for (const field of ['outputs', 'rate', 'commission', 'ruleId', 'total', 'allowed', 'enabled']) {
    await assert.rejects(
      harness.service.evaluate({ policyKey: POLICY, [field]: 'anything' }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'caller-asserted-outcome', field);
        return true;
      },
    );
  }
});

test('every refused field explains itself rather than carrying a label', () => {
  for (const [field, why] of Object.entries({
    ...ASSERTED_OUTCOME_FIELDS,
    ...PINNED_VERSION_FIELDS,
  })) {
    assert.ok(why.length > 20, `${field} has no explanation`);
    assert.ok(
      /K-04|K-05|K-07|K-10|Ledger|answer|derived|version|policy|force|draft/i.test(why),
      `${field}'s explanation names neither the owner nor why it is the answer: "${why}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// A policy is not another component's decision
// ---------------------------------------------------------------------------

test('a policy key naming authority, deployment state or credentials is refused', async () => {
  const harness = build();
  const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
    ['staff.permission.elevated', /K-04 Permissions/],
    ['admin.role.override', /K-04 Permissions/],
    ['checkout.feature-flag.v2', /K-07 Feature Flags/],
    ['release.kill-switch.payments', /K-07 Feature Flags/],
    ['login.session.duration', /K-02 Authentication/],
  ];

  for (const [policyKey, owner] of forbidden) {
    await assert.rejects(harness.service.draft(draftRequest({ policyKey })), (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-identifier', policyKey);
      assert.match((error as Error).message, owner, policyKey);
      return true;
    });
  }
  assert.equal(harness.repository.drafts().length, 0, 'and none of them was written');
});

test('a policy key that is merely misspelt is refused as malformed', async () => {
  const harness = build();
  for (const policyKey of ['nodots', 'UPPER.case', 'trailing.', 'a.b.c.d.e', '.leading']) {
    await assert.rejects(
      harness.service.draft(draftRequest({ policyKey })),
      (error: unknown) => codeOf(error) === 'malformed-identifier',
      `"${policyKey}" is not a policy key`,
    );
  }
});

// ---------------------------------------------------------------------------
// Nobody authors by default
// ---------------------------------------------------------------------------

test('a service with no injected authority drafts, publishes, activates and retires nothing', async () => {
  const repository = new InMemoryPolicyRepository();
  const service = new PolicyService({ repository, clock: new FixedClock() });

  const attempts: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ['draft', () => service.draft(draftRequest())],
    [
      'publish',
      () =>
        service.publish({
          policyVersionId: nextId('polver'),
          draftId: 'draft_01HQZXNOTHERE',
          idempotencyKey: nextId('idem'),
        }),
    ],
    [
      'activate',
      () =>
        service.activate({
          activationId: nextId('act'),
          policyVersionId: 'polver_01HQZXNOTHER',
          supersedesVersionId: null,
          idempotencyKey: nextId('idem'),
        }),
    ],
    [
      'retire',
      () =>
        service.retire({
          retirementId: nextId('ret'),
          policyKey: POLICY,
          reason: 'because',
          idempotencyKey: nextId('idem'),
        }),
    ],
  ];

  for (const [operation, run] of attempts) {
    await assert.rejects(run(), (error: unknown) => {
      assert.equal(codeOf(error), 'authoring-refused', operation);
      assert.match((error as Error).message, /economics of every transaction that follows/);
      return true;
    });
  }

  assert.equal(repository.drafts().length, 0);
  assert.equal(repository.versions().length, 0);
});

test('the default authority refuses, and the author is never taken from the request', async () => {
  assert.equal(NO_AUTHORITY.permitsAuthoring(), false);

  const harness = build();
  const drafted = await harness.service.draft(draftRequest());
  assert.deepEqual(drafted.draft.draftedBy, { kind: 'system', id: AUTHORITY });

  await assert.rejects(
    harness.service.draft(draftRequest({ draftedBy: { kind: 'human', id: 'ops-alice' } } as never)),
    (error: unknown) => {
      assert.match((error as Error).message, /does not accept the field "draftedBy"/);
      return codeOf(error) === 'malformed-record';
    },
  );
});

test('no agent may author policy: there is no ai origin in the component at all', async () => {
  // v3 §38 — AI must never be the financial authority. The commission rate is that authority
  // written down, so the kind is absent from the type rather than refused at the boundary.
  const harness = build();
  const drafted = await harness.service.draft(draftRequest());
  assert.notEqual(drafted.draft.draftedBy.kind, 'ai');

  // And a row claiming one is refused on decode — see the repository suite.
  assert.ok(!Object.values(drafted.draft.draftedBy).includes('ai'));
});

// ---------------------------------------------------------------------------
// Shape of the surface
// ---------------------------------------------------------------------------

test('the service exposes no bypass, no update, no delete and no arithmetic', () => {
  const operations = new Set<string>();
  let proto: object | null = PolicyService.prototype;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  const forbidden = [...operations].filter((name) =>
    /delete|remove|purge|update|edit|bypass|override|calculate|compute|apply[A-Z]/i.test(name),
  );
  assert.deepEqual(
    forbidden,
    [],
    'policy history is append-only, and K-06 returns rates rather than computing amounts',
  );

  assert.deepEqual(
    [...operations].sort(),
    ['activate', 'constructor', 'draft', 'evaluate', 'publish', 'retire'],
    'five operations and a constructor: the whole surface',
  );
});

test('every record crossing the boundary is sealed all the way down', async () => {
  const { harness, version } = await withActivePolicy(build(), {
    rules: [
      {
        ruleId: 'rule_01HQZXSEALED1',
        selector: { category: CATEGORY },
        condition: { kind: 'fact-in', fact: 'country', values: ['country_gb0001'] },
        outputs: {
          rate: { kind: 'decimal', value: rate('1750') },
          holdSeconds: { kind: 'duration-seconds', value: 0 },
        },
      },
    ],
  });

  assert.ok(Object.isFrozen(version));
  assert.ok(Object.isFrozen(version.rules));
  assert.ok(Object.isFrozen(version.rules[0]));
  assert.ok(Object.isFrozen(version.rules[0]?.selector));
  assert.ok(Object.isFrozen(version.rules[0]?.condition));
  assert.ok(Object.isFrozen(version.rules[0]?.outputs));
  assert.throws(() => {
    (version.rules[0]?.outputs.rate as { kind: string }).kind = 'boolean';
  });

  const decision = await harness.service.evaluate({
    policyKey: POLICY,
    facts: { category: CATEGORY, country: 'country_gb0001' },
  });
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.outputs));
});

test('a rate handed back cannot be edited into the store', async () => {
  const { harness, version } = await withActivePolicy();
  const stored = harness.repository
    .versions()
    .find((entry) => entry.policyVersionId === version.policyVersionId);

  assert.throws(() => {
    (version.rules[0]?.outputs.rate as { value: { units: string } }).value.units = '9999';
  });
  assert.deepEqual(stored?.rules[0]?.outputs.rate, { kind: 'decimal', value: rate('1000') });
});
