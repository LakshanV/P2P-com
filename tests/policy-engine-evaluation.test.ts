/**
 * K-06 Policy Engine — precedence, temporal bounds and failing closed (FND-005b).
 *
 * The case this file is really about is a commission rate that depends on row order.
 *
 * Two rules both match a transaction and both bind the same number of scope dimensions. Pick the
 * first and the answer depends on the order the rows came back in — which is stable until a query
 * plan changes, and then quietly is not. Pick the highest and the platform overcharges; pick the
 * lowest and it undercharges. Every one of those is a difference nobody would find, because each
 * transaction looks individually plausible. So K-06 **refuses**: `ambiguous-precedence` says the
 * author did not decide this case, and the author has to.
 *
 * The other half is failing closed. A fact a matching rule needs but the request omitted is a
 * refusal, not a fall-through to a less specific rule — otherwise leaving out `sellerTier` would
 * quietly buy the caller the global rate, which is the cheapest possible way to underpay.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PolicyError } from '../kernel/policy-engine/index.ts';

import {
  CATEGORY,
  COUNTRY,
  POLICY,
  SELLER,
  build,
  nextId,
  rate,
  withActivePolicy,
} from './helpers/policy-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof PolicyError ? error.code : undefined;

const outputs = (units: string, hold = 0) => ({
  rate: { kind: 'decimal', value: rate(units) },
  holdSeconds: { kind: 'duration-seconds', value: hold },
});

/** The v3 §24 example: a global rate, a category rate, and a rate for one seller. */
const LADDER = [
  { ruleId: 'rule_01HQZXGLOBAL2', selector: {}, condition: null, outputs: outputs('1000') },
  {
    ruleId: 'rule_01HQZXCATEG01',
    selector: { category: CATEGORY },
    condition: null,
    outputs: outputs('1200'),
  },
  {
    ruleId: 'rule_01HQZXSELLER1',
    selector: { category: CATEGORY, seller: SELLER },
    condition: null,
    outputs: outputs('800'),
  },
] as const;

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test('the most specific matching rule decides', async () => {
  const { harness } = await withActivePolicy(build(), { rules: LADDER });

  const global = await harness.service.evaluate({
    policyKey: POLICY,
    facts: { category: 'cat_01HQZXOTHER1', seller: 'sel_01HQZXOTHER01' },
  });
  assert.equal(global.ruleId, 'rule_01HQZXGLOBAL2');
  assert.deepEqual(global.outputs.rate, { kind: 'decimal', value: rate('1000') });

  const category = await harness.service.evaluate({
    policyKey: POLICY,
    facts: { category: CATEGORY, seller: 'sel_01HQZXOTHER01' },
  });
  assert.equal(category.ruleId, 'rule_01HQZXCATEG01');

  const seller = await harness.service.evaluate({
    policyKey: POLICY,
    facts: { category: CATEGORY, seller: SELLER },
  });
  assert.equal(seller.ruleId, 'rule_01HQZXSELLER1');
  assert.deepEqual(seller.outputs.rate, { kind: 'decimal', value: rate('800') });
  assert.match(seller.explanation, /most specific of 3 matching rule/);
});

test('two equally specific matching rules are refused, not resolved by order', async () => {
  const { harness } = await withActivePolicy(build(), {
    rules: [
      {
        ruleId: 'rule_01HQZXBYCOUNT',
        selector: { country: COUNTRY },
        condition: null,
        outputs: outputs('1000'),
      },
      {
        ruleId: 'rule_01HQZXBYCATEG',
        selector: { category: CATEGORY },
        condition: null,
        outputs: outputs('1500'),
      },
    ],
  });

  await assert.rejects(
    harness.service.evaluate({ policyKey: POLICY, facts: { country: COUNTRY, category: CATEGORY } }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'ambiguous-precedence');
      assert.match((error as Error).message, /rule_01HQZXBYCOUNT/);
      assert.match((error as Error).message, /rule_01HQZXBYCATEG/);
      assert.match((error as Error).message, /depend on row order/);
      return true;
    },
    'picking one would make the commission depend on the order rows came back in',
  );

  // The ambiguity is genuinely about the overlap: with both facts supplied but only one
  // matching, the same policy decides cleanly. Note that both facts must still be *supplied* —
  // omitting one leaves a rule undecidable, which is `missing-fact` rather than a fall-through.
  assert.equal(
    (
      await harness.service.evaluate({
        policyKey: POLICY,
        facts: { country: COUNTRY, category: 'cat_01HQZXOTHER1' },
      })
    ).ruleId,
    'rule_01HQZXBYCOUNT',
  );

  await assert.rejects(
    harness.service.evaluate({ policyKey: POLICY, facts: { country: COUNTRY } }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'missing-fact');
      assert.match((error as Error).message, /category/);
      return true;
    },
    'a rule that turns on category cannot be decided without it, and must not be skipped',
  );
});

test('two rules binding the same scope with no condition are refused at authoring', async () => {
  // Earlier than evaluation, because at evaluation a transaction is waiting.
  const harness = build();
  await assert.rejects(
    harness.service.draft({
      draftId: nextId('draft'),
      policyKey: POLICY,
      outputSchema: {
        rate: { kind: 'decimal', scale: 4, minimum: rate('0'), maximum: rate('10000') },
        holdSeconds: { kind: 'duration-seconds', minimum: 0, maximum: 7_776_000 },
      },
      rules: [
        { ruleId: 'rule_01HQZXCLASH01', selector: { seller: SELLER }, condition: null, outputs: outputs('1000') },
        { ruleId: 'rule_01HQZXCLASH02', selector: { seller: SELLER }, condition: null, outputs: outputs('2000') },
      ],
      idempotencyKey: nextId('idem'),
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'ambiguous-precedence');
      assert.match((error as Error).message, /both match whenever either does/);
      return true;
    },
  );
});

test('a condition separates two rules that bind the same scope', async () => {
  // The legitimate version of the case above: same specificity, but the conditions are disjoint.
  const { harness } = await withActivePolicy(build(), {
    rules: [
      {
        ruleId: 'rule_01HQZXBAND001',
        selector: { seller: SELLER },
        condition: { kind: 'amount-below', amount: rate('10000000') },
        outputs: outputs('1500'),
      },
      {
        ruleId: 'rule_01HQZXBAND002',
        selector: { seller: SELLER },
        condition: { kind: 'amount-at-least', amount: rate('10000000') },
        outputs: outputs('1000'),
      },
    ],
  });

  assert.equal(
    (
      await harness.service.evaluate({
        policyKey: POLICY,
        facts: { seller: SELLER, amount: rate('5000000') },
      })
    ).ruleId,
    'rule_01HQZXBAND001',
  );
});

// ---------------------------------------------------------------------------
// Failing closed
// ---------------------------------------------------------------------------

test('a fact a matching rule needs but the request omitted is a refusal', async () => {
  const { harness } = await withActivePolicy(build(), { rules: LADDER });

  await assert.rejects(
    harness.service.evaluate({ policyKey: POLICY, facts: { category: CATEGORY } }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'missing-fact');
      assert.match((error as Error).message, /seller/);
      assert.match((error as Error).message, /less specific rule/);
      return true;
    },
    'omitting seller must not quietly award the category rate',
  );
});

test('a missing-fact refusal names facts and never their values', async () => {
  const { harness } = await withActivePolicy(build(), {
    rules: [
      {
        ruleId: 'rule_01HQZXPRIVAT1',
        selector: { seller: 'sel_01HQZXPRIVATE' },
        condition: null,
        outputs: outputs('1000'),
      },
    ],
    defaultOutputs: outputs('500'),
  });

  await assert.rejects(harness.service.evaluate({ policyKey: POLICY }), (error: unknown) => {
    const message = (error as Error).message;
    assert.equal(codeOf(error), 'missing-fact');
    assert.match(message, /seller/);
    assert.ok(!message.includes('sel_01HQZXPRIVATE'), `the refusal quoted a value: ${message}`);
    return true;
  });
});

test('no rule matching and no declared defaults is a refusal, not a zero', async () => {
  const { harness } = await withActivePolicy(build(), {
    rules: [
      {
        ruleId: 'rule_01HQZXONLYGB1',
        selector: { country: COUNTRY },
        condition: null,
        outputs: outputs('1000'),
      },
    ],
  });

  await assert.rejects(
    harness.service.evaluate({ policyKey: POLICY, facts: { country: 'country_fr0001' } }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'no-matching-rule');
      assert.match((error as Error).message, /no implicit zero/);
      return true;
    },
  );
});

test('declared defaults apply, and say so', async () => {
  const { harness, version } = await withActivePolicy(build(), {
    rules: [
      {
        ruleId: 'rule_01HQZXONLYGB2',
        selector: { country: COUNTRY },
        condition: null,
        outputs: outputs('1000'),
      },
    ],
    defaultOutputs: outputs('500', 60),
  });

  const decision = await harness.service.evaluate({
    policyKey: POLICY,
    facts: { country: 'country_fr0001' },
  });
  assert.equal(decision.reason, 'default-applied');
  assert.equal(decision.ruleId, null);
  assert.deepEqual(decision.outputs.rate, { kind: 'decimal', value: rate('500') });
  assert.equal(decision.policyVersionId, version.policyVersionId, 'and it is still pinned');
  assert.match(decision.explanation, /defaults the version declares/);
});

test('an unknown policy, and a retired one, both refuse', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.evaluate({ policyKey: 'commerce.never-published' }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'no-such-policy');
      assert.match((error as Error).message, /no version ever justified/);
      return true;
    },
  );

  const { harness: live } = await withActivePolicy();
  await live.service.retire({
    retirementId: nextId('ret'),
    policyKey: POLICY,
    reason: 'the commission model moved to the new tier structure',
    idempotencyKey: nextId('idem'),
  });
  await assert.rejects(
    live.service.evaluate({ policyKey: POLICY }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'policy-retired');
      assert.match((error as Error).message, /remain readable/);
      return true;
    },
  );
});

test('a published but unactivated version decides nothing', async () => {
  const harness = build();
  const drafted = await harness.service.draft({
    draftId: nextId('draft'),
    policyKey: POLICY,
    outputSchema: {
      rate: { kind: 'decimal', scale: 4, minimum: rate('0'), maximum: rate('10000') },
      holdSeconds: { kind: 'duration-seconds', minimum: 0, maximum: 7_776_000 },
    },
    rules: [{ ruleId: 'rule_01HQZXNOTLIVE', selector: {}, condition: null, outputs: outputs('1000') }],
    idempotencyKey: nextId('idem'),
  });
  await harness.service.publish({
    policyVersionId: nextId('polver'),
    draftId: drafted.draft.draftId,
    idempotencyKey: nextId('idem'),
  });

  await assert.rejects(
    harness.service.evaluate({ policyKey: POLICY }),
    (error: unknown) => codeOf(error) === 'no-such-policy',
    'publishing is not activating',
  );
});

// ---------------------------------------------------------------------------
// Temporal bounds
// ---------------------------------------------------------------------------

test('a version outside its effective window decides nothing', async () => {
  const harness = build();
  await withActivePolicy(
    harness,
    {},
    { effectiveFrom: '2026-04-01T13:00:00Z', effectiveUntil: '2026-04-01T15:00:00Z' },
  );

  const at = async (now: string) => {
    harness.clock.set(now);
    return harness.service.evaluate({ policyKey: POLICY }).then(
      (decision) => decision.reason,
      (error: unknown) => codeOf(error),
    );
  };

  assert.equal(await at('2026-04-01T12:59:59Z'), 'version-not-effective', 'a second before');
  assert.equal(await at('2026-04-01T13:00:00Z'), 'rule-matched', 'the opening instant is inside');
  assert.equal(await at('2026-04-01T15:00:00Z'), 'rule-matched', 'the closing instant is inside');
  assert.equal(await at('2026-04-01T15:00:00.000001Z'), 'version-not-effective', 'a microsecond after');
});

test('an evaluation may be replayed as of a historic instant', async () => {
  // The mechanism v3 §35 needs: re-running a version against the facts of the day.
  const harness = build();
  await withActivePolicy(harness, {}, { effectiveUntil: '2026-04-01T13:00:00Z' });

  harness.clock.set('2026-05-01T00:00:00Z');
  await assert.rejects(
    harness.service.evaluate({ policyKey: POLICY }),
    (error: unknown) => codeOf(error) === 'version-not-effective',
  );

  const replayed = await harness.service.evaluate({
    policyKey: POLICY,
    at: '2026-04-01T12:30:00Z',
  });
  assert.equal(replayed.evaluatedAt, '2026-04-01T12:30:00Z');
  assert.equal(replayed.reason, 'rule-matched');
});

test('a window that contains no instant is refused at publication', async () => {
  const harness = build();
  const drafted = await harness.service.draft({
    draftId: nextId('draft'),
    policyKey: POLICY,
    outputSchema: {
      rate: { kind: 'decimal', scale: 4, minimum: rate('0'), maximum: rate('10000') },
      holdSeconds: { kind: 'duration-seconds', minimum: 0, maximum: 7_776_000 },
    },
    rules: [{ ruleId: 'rule_01HQZXBADWIND', selector: {}, condition: null, outputs: outputs('1000') }],
    idempotencyKey: nextId('idem'),
  });

  for (const [why, window] of [
    ['reversed', { effectiveFrom: '2026-05-01T00:00:00Z', effectiveUntil: '2026-04-01T00:00:00Z' }],
    ['equal', { effectiveFrom: '2026-05-01T00:00:00Z', effectiveUntil: '2026-05-01T00:00:00Z' }],
  ] as const) {
    await assert.rejects(
      harness.service.publish({
        policyVersionId: nextId('polver'),
        draftId: drafted.draft.draftId,
        ...window,
        idempotencyKey: nextId('idem'),
      }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'invalid-effective-window', why);
        assert.match((error as Error).message, /reads as scheduled and can never apply/);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Determinism and reproducibility
// ---------------------------------------------------------------------------

test('the same version, facts and instant give the same answer, every time', async () => {
  const { harness } = await withActivePolicy(build(), { rules: LADDER });
  const request = { policyKey: POLICY, facts: { category: CATEGORY, seller: SELLER }, at: '2026-04-01T12:00:00Z' };

  const first = await harness.service.evaluate(request);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(await harness.service.evaluate(request), first, 'evaluation is not stable');
  }
});

test('an evaluation writes nothing', async () => {
  const { harness } = await withActivePolicy();
  const before = {
    drafts: harness.repository.drafts().length,
    versions: harness.repository.versions().length,
    activations: harness.repository.activations().length,
  };

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await harness.service.evaluate({ policyKey: POLICY });
  }

  assert.deepEqual(
    {
      drafts: harness.repository.drafts().length,
      versions: harness.repository.versions().length,
      activations: harness.repository.activations().length,
    },
    before,
  );
});

// ---------------------------------------------------------------------------
// K-05, and only where the specification needs it
// ---------------------------------------------------------------------------

test('a configured output resolves through K-05 and pins the version it returned', async () => {
  const harness = build();
  harness.configuration.answerWith({ value: 'lvl_01HQZXHIGH01', versionId: 'cfgver_01HQZXAAA1' });

  await withActivePolicy(harness, {
    outputSchema: {
      rate: { kind: 'decimal', scale: 4, minimum: rate('0'), maximum: rate('10000') },
      riskThreshold: { kind: 'configured', key: 'risk.threshold.default' },
    } as unknown as Record<string, unknown>,
    rules: [
      {
        ruleId: 'rule_01HQZXCONFIG1',
        selector: {},
        condition: null,
        outputs: {
          rate: { kind: 'decimal', value: rate('1000') },
          riskThreshold: { kind: 'configured', key: 'risk.threshold.default' },
        },
      },
    ],
  });

  const decision = await harness.service.evaluate({ policyKey: POLICY });
  assert.deepEqual(decision.outputs.riskThreshold, {
    kind: 'configured',
    key: 'risk.threshold.default',
    value: 'lvl_01HQZXHIGH01',
    configurationVersionId: 'cfgver_01HQZXAAA1',
  });
  assert.deepEqual(decision.configurationVersions, { 'risk.threshold.default': 'cfgver_01HQZXAAA1' });
  assert.equal(harness.configuration.asked.length, 1);
  assert.equal(harness.configuration.asked[0]?.key, 'risk.threshold.default');
});

test('K-05 is not consulted for a policy that declares no configured output', async () => {
  const { harness } = await withActivePolicy();
  await harness.service.evaluate({ policyKey: POLICY });
  assert.deepEqual(harness.configuration.asked, []);
});

test('a configured output K-05 cannot resolve refuses the evaluation', async () => {
  const harness = build();
  await withActivePolicy(harness, {
    outputSchema: {
      riskThreshold: { kind: 'configured', key: 'risk.threshold.default' },
    } as unknown as Record<string, unknown>,
    rules: [
      {
        ruleId: 'rule_01HQZXCONFIG2',
        selector: {},
        condition: null,
        outputs: { riskThreshold: { kind: 'configured', key: 'risk.threshold.default' } },
      },
    ],
  });

  harness.configuration.answerWith({ refuseWith: new Error('no configuration version') });
  await assert.rejects(
    harness.service.evaluate({ policyKey: POLICY }),
    /no configuration version/,
    'a value nobody supplied must not become a default',
  );
});
