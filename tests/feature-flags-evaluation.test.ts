/**
 * K-07 Feature Flags — evaluation, precedence and failing closed (FND-004e).
 *
 * Two claims are tested here, and the second is the one that matters during an incident.
 *
 * **Every uncertainty is off.** An unknown flag, a retired one, a scope the version was not
 * published for, a rule naming an attribute the request did not supply, a percentage rollout with
 * no subject key, a deployment stage K-05 could not resolve — all disabled. A flag system that
 * guessed "probably on" would fail towards the risky answer for exactly the functions v3 §36 says
 * need one: autonomous purchasing, AI negotiation, referral payouts.
 *
 * **The kill switch outranks everything.** Not "usually wins" — is checked first, before the
 * version is even looked at, so stopping a feature at two in the morning never depends on what any
 * definition says. The cases below try to beat it with a fully-on version, a fresh publication and
 * a fresh activation, and none of them can.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FeatureFlagError,
  evaluate,
  matches,
  type EvaluationInput,
} from '../kernel/feature-flags/index.ts';

import {
  FLAG,
  SUBJECT_KEY,
  build,
  nextId,
  publishRequest,
  storedVersion,
  withActiveFlag,
} from './helpers/feature-flag-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof FeatureFlagError ? error.code : undefined;

/** A pure evaluation input, for the cases that are about `decide.ts` rather than the service. */
function input(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    flagKey: FLAG,
    version: storedVersion(),
    lifecycle: [],
    scope: { level: 'global', id: '' },
    subjectKey: SUBJECT_KEY,
    attributes: {},
    now: '2026-04-01T12:00:00Z',
    deploymentStage: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unknown is off
// ---------------------------------------------------------------------------

test('a flag nobody published evaluates to off', async () => {
  const harness = build();
  const evaluation = await harness.service.evaluate({ flagKey: 'commerce.never-published' });

  assert.equal(evaluation.enabled, false);
  assert.equal(evaluation.reason, 'no-such-flag');
  assert.equal(evaluation.flagVersionId, null);
  assert.match(evaluation.explanation, /a typo must never enable a code path/);
});

test('an active flag evaluates from the version that was activated, not the newest published', async () => {
  // The distinction the activation chain exists for: publishing is not deploying.
  const { harness, version } = await withActiveFlag(build(), { state: 'on' });
  const newer = await harness.service.publish(publishRequest({ state: 'off' }));

  const evaluation = await harness.service.evaluate({ flagKey: FLAG });
  assert.equal(evaluation.enabled, true);
  assert.equal(evaluation.flagVersionId, version.flagVersionId);
  assert.notEqual(evaluation.flagVersionId, newer.version.flagVersionId);
  assert.equal(evaluation.version, 1, 'and the explanation names version 1, which is what ran');
});

// ---------------------------------------------------------------------------
// The kill switch outranks everything
// ---------------------------------------------------------------------------

test('a kill switch beats a fully-on version, and cannot be undone by publishing over it', async () => {
  const { harness } = await withActiveFlag(build(), { state: 'on' });
  assert.equal((await harness.service.evaluate({ flagKey: FLAG })).enabled, true);

  await harness.service.kill({
    eventId: nextId('evt'),
    flagKey: FLAG,
    reason: 'the supplier feed started quoting in the wrong currency',
    idempotencyKey: nextId('idem'),
  });

  const killed = await harness.service.evaluate({ flagKey: FLAG });
  assert.equal(killed.enabled, false);
  assert.equal(killed.reason, 'kill-switch');
  assert.match(killed.explanation, /outranks every published version/);

  // And the obvious way somebody would try to undo it.
  await assert.rejects(
    harness.service.publish(publishRequest({ state: 'on' })),
    (error: unknown) => codeOf(error) === 'flag-terminated',
    'republishing over a kill would make the emergency stop advisory',
  );
});

test('the kill switch is checked before the version, so a malformed definition cannot outlive it', () => {
  // A pure case, because the service would refuse to store this version at all. It proves the
  // ordering in decide.ts rather than the ordering the service happens to produce.
  const answer = evaluate(
    input({
      version: storedVersion({ state: 'on' }),
      lifecycle: [
        {
          eventId: 'evt_01HQZXKILL0001',
          flagKey: FLAG,
          kind: 'kill',
          reason: 'incident 4471',
          recordedAt: '2026-04-01T11:00:00Z',
          recordedBy: { kind: 'system', id: 'k07-release-console' },
          idempotencyKey: 'idem_01HQZXKILL001',
          requestFingerprint: 'd'.repeat(64),
        },
      ],
    }),
  );
  assert.equal(answer.enabled, false);
  assert.equal(answer.reason, 'kill-switch');
});

test('a retired flag is off, and says so as retirement rather than as an unknown flag', async () => {
  const { harness } = await withActiveFlag(build(), { state: 'on' });
  await harness.service.retire({
    eventId: nextId('evt'),
    flagKey: FLAG,
    reason: 'the feature shipped to everybody a quarter ago',
    idempotencyKey: nextId('idem'),
  });

  const evaluation = await harness.service.evaluate({ flagKey: FLAG });
  assert.equal(evaluation.enabled, false);
  assert.equal(evaluation.reason, 'flag-retired');
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

test('a flag evaluated at a level it was not published for is off', async () => {
  const { harness } = await withActiveFlag(build(), {
    state: 'on',
    supportedScopes: ['account'],
  });

  const wrong = await harness.service.evaluate({ flagKey: FLAG });
  assert.equal(wrong.enabled, false);
  assert.equal(wrong.reason, 'unsupported-scope');
  assert.match(wrong.explanation, /more widely than anybody chose/);

  const right = await harness.service.evaluate({
    flagKey: FLAG,
    scope: { level: 'account', id: 'acct_01HQZXFLAG001' },
  });
  assert.equal(right.enabled, true);
  assert.deepEqual(right.scope, { level: 'account', id: 'acct_01HQZXFLAG001' });
});

test('a scope level that does not exist is refused rather than evaluated', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.evaluate({ flagKey: FLAG, scope: { level: 'tenant', id: 'x' } as never }),
    (error: unknown) => codeOf(error) === 'unsupported-scope',
  );
  await assert.rejects(
    harness.service.evaluate({ flagKey: FLAG, scope: { level: 'global', id: 'something' } }),
    (error: unknown) => codeOf(error) === 'unsupported-scope',
    'a global scope carries no id, and one that does is a request nobody meant',
  );
});

// ---------------------------------------------------------------------------
// Temporal bounds
// ---------------------------------------------------------------------------

test('a flag is off before its window opens and after it closes', async () => {
  const harness = build();
  await withActiveFlag(harness, {
    state: 'on',
    notBefore: '2026-04-01T13:00:00Z',
    notAfter: '2026-04-01T15:00:00Z',
  });

  const at = async (now: string) => {
    harness.clock.set(now);
    return harness.service.evaluate({ flagKey: FLAG });
  };

  assert.equal((await at('2026-04-01T12:59:59Z')).enabled, false, 'a second before it opens');
  assert.equal((await at('2026-04-01T12:59:59Z')).reason, 'outside-activation-window');
  assert.equal((await at('2026-04-01T13:00:00Z')).enabled, true, 'the opening instant is inside');
  assert.equal((await at('2026-04-01T14:00:00Z')).enabled, true);
  assert.equal((await at('2026-04-01T15:00:00Z')).enabled, true, 'the closing instant is inside');
  assert.equal((await at('2026-04-01T15:00:00.000001Z')).enabled, false, 'a microsecond after');
  assert.equal((await at('2026-04-01T15:00:00.000001Z')).reason, 'outside-activation-window');
});

test('an open-ended window bounds only the end it names', async () => {
  const harness = build();
  await withActiveFlag(harness, { state: 'on', notAfter: '2026-04-01T13:00:00Z' });

  harness.clock.set('2020-01-01T00:00:00Z');
  assert.equal((await harness.service.evaluate({ flagKey: FLAG })).enabled, true);
  harness.clock.set('2026-04-01T13:00:01Z');
  assert.equal((await harness.service.evaluate({ flagKey: FLAG })).enabled, false);
});

// ---------------------------------------------------------------------------
// Internal-only, and K-05
// ---------------------------------------------------------------------------

test('an internal-only flag is on in an internal deployment and off in production', async () => {
  const harness = build();
  await withActiveFlag(harness, { state: 'internal-only' });

  harness.configuration.answerWith({ stage: 'internal' });
  const internal = await harness.service.evaluate({ flagKey: FLAG });
  assert.equal(internal.enabled, true);
  assert.equal(internal.reason, 'internal-only');

  harness.configuration.answerWith({ stage: 'production' });
  const production = await harness.service.evaluate({ flagKey: FLAG });
  assert.equal(production.enabled, false);
  assert.equal(production.reason, 'not-internal-deployment');
});

test('an unresolvable deployment stage is treated as not internal', async () => {
  // The direction matters: an internal pilot must not leak into production because nobody wired
  // configuration up, or because K-05 was unavailable for a moment.
  const harness = build();
  await withActiveFlag(harness, { state: 'internal-only' });

  for (const [why, options] of [
    ['no value at all', {}],
    ['a value K-07 does not recognise', { stage: 'staging' }],
    ['a value of the wrong type', { stage: 7 }],
    ['K-05 refusing outright', { refuseWith: new Error('no configuration version') }],
  ] as const) {
    harness.configuration.answerWith(options);
    const evaluation = await harness.service.evaluate({ flagKey: FLAG });
    assert.equal(evaluation.enabled, false, why);
    assert.equal(evaluation.reason, 'deployment-stage-unknown', why);
  }
});

test('K-05 is asked for exactly one registered key, and only when a version needs it', async () => {
  const harness = build();
  await withActiveFlag(harness, { state: 'on' });

  await harness.service.evaluate({ flagKey: FLAG });
  assert.deepEqual(harness.configuration.asked, [], 'a fully-on flag needs no configuration');

  const { harness: internal } = await withActiveFlag(build(), { state: 'internal-only' });
  internal.configuration.answerWith({ stage: 'internal' });
  await internal.service.evaluate({ flagKey: FLAG });

  assert.equal(internal.configuration.asked.length, 1);
  assert.equal(internal.configuration.asked[0]?.key, 'platform.deployment.stage');
});

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

test('a targeted flag is on for a matching request and off for one that does not match', async () => {
  const harness = build();
  await withActiveFlag(harness, {
    state: 'targeted',
    supportedScopes: ['global', 'country'],
    rules: [{ kind: 'attribute-in', attribute: 'country', values: ['country_gb001', 'country_lk01'] }],
  });

  const matched = await harness.service.evaluate({
    flagKey: FLAG,
    attributes: { country: 'country_gb001' },
  });
  assert.equal(matched.enabled, true);
  assert.equal(matched.reason, 'targeting-matched');

  const unmatched = await harness.service.evaluate({
    flagKey: FLAG,
    attributes: { country: 'country_fr01' },
  });
  assert.equal(unmatched.enabled, false);
  assert.equal(unmatched.reason, 'targeting-unmatched');
});

test('a rule naming an attribute the request did not supply is off, not excluded', async () => {
  // The distinction is the point: the caller has not been left out of a rollout, they have asked a
  // question this component cannot answer, and the explanation must tell them which attribute.
  const harness = build();
  await withActiveFlag(harness, {
    state: 'targeted',
    rules: [{ kind: 'attribute-equals', attribute: 'category', value: 'cat_01HQZXELEC' }],
  });

  const evaluation = await harness.service.evaluate({ flagKey: FLAG, attributes: {} });
  assert.equal(evaluation.enabled, false);
  assert.equal(evaluation.reason, 'missing-context');
  assert.match(evaluation.explanation, /category/);
  assert.match(evaluation.explanation, /context that is not there/);
});

test('an all-rule with a definite mismatch does not need the missing attribute', () => {
  // `all` is settled by any definite false, because the rule cannot match whatever the missing
  // attribute turns out to be. Treating it as undecidable would report a missing-context error for
  // a request that was going to be excluded regardless.
  const rule = {
    kind: 'all' as const,
    of: [
      { kind: 'attribute-equals' as const, attribute: 'country', value: 'country_gb001' },
      { kind: 'attribute-equals' as const, attribute: 'channel', value: 'channel_web01' },
    ],
  };
  assert.equal(matches(rule, { country: 'country_fr01' }), false, 'settled by the mismatch');
  assert.equal(matches(rule, { country: 'country_gb001' }), null, 'undecidable without channel');
  assert.equal(
    matches(rule, { country: 'country_gb001', channel: 'channel_web01' }),
    true,
  );
});

test('an any-rule is settled by any definite match', () => {
  const rule = {
    kind: 'any' as const,
    of: [
      { kind: 'attribute-equals' as const, attribute: 'country', value: 'country_gb001' },
      { kind: 'attribute-equals' as const, attribute: 'cohort', value: 'coh_01HQZXPILOT' },
    ],
  };
  assert.equal(matches(rule, { country: 'country_gb001' }), true);
  assert.equal(matches(rule, { country: 'country_fr01' }), null, 'undecidable without cohort');
  assert.equal(matches(rule, { country: 'country_fr01', cohort: 'coh_01HQZXOTHER' }), false);
});

// ---------------------------------------------------------------------------
// What an explanation may say
// ---------------------------------------------------------------------------

test('an explanation names the version and never the context it was given', async () => {
  // An explanation is the thing most likely to end up in a log line. One that quoted the values it
  // matched would put whatever a caller passed as context into every log that mentions this flag.
  const harness = build();
  const { version } = await withActiveFlag(harness, {
    state: 'targeted',
    supportedScopes: ['global', 'account'],
    rules: [{ kind: 'attribute-equals', attribute: 'cohort', value: 'coh_01HQZXPILOT' }],
  });

  const secretish = 'coh_01HQZXPILOT';
  const subject = 'sub_01HQZXPRIVATE1';
  const evaluation = await harness.service.evaluate({
    flagKey: FLAG,
    scope: { level: 'account', id: 'acct_01HQZXPRIVATE' },
    subjectKey: subject,
    attributes: { cohort: secretish },
  });

  assert.equal(evaluation.enabled, true);
  assert.match(evaluation.explanation, new RegExp(version.flagVersionId));
  assert.ok(
    !evaluation.explanation.includes(secretish),
    `the explanation quoted a context value: "${evaluation.explanation}"`,
  );
  assert.ok(
    !evaluation.explanation.includes(subject),
    'the explanation quoted the subject key, which is the thing being bucketed',
  );
  assert.ok(
    !evaluation.explanation.includes('acct_01HQZXPRIVATE'),
    'the explanation quoted the scope id',
  );
});

test('a missing-context explanation names attributes and still never names values', async () => {
  const harness = build();
  await withActiveFlag(harness, {
    state: 'targeted',
    rules: [
      { kind: 'attribute-equals', attribute: 'cohort', value: 'coh_01HQZXPRIVAT' },
      { kind: 'attribute-equals', attribute: 'channel', value: 'channel_web01' },
    ],
  });

  const evaluation = await harness.service.evaluate({ flagKey: FLAG });
  assert.match(evaluation.explanation, /channel/);
  assert.match(evaluation.explanation, /cohort/);
  assert.ok(!evaluation.explanation.includes('coh_01HQZXPRIVAT'));
  assert.ok(!evaluation.explanation.includes('channel_web01'));
});

test('the same inputs produce the same answer, every time', async () => {
  const harness = build();
  await withActiveFlag(harness, { state: 'percentage', percentage: 37 });

  const request = { flagKey: FLAG, subjectKey: SUBJECT_KEY };
  const first = await harness.service.evaluate(request);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(await harness.service.evaluate(request), first, 'evaluation is not stable');
  }
});

test('an evaluation writes nothing', async () => {
  const harness = build();
  await withActiveFlag(harness, { state: 'on' });
  const versions = harness.repository.versions().length;
  const activations = harness.repository.activations().length;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await harness.service.evaluate({ flagKey: FLAG });
  }

  assert.equal(harness.repository.versions().length, versions);
  assert.equal(harness.repository.activations().length, activations);
  assert.equal(harness.repository.lifecycleEvents().length, 0);
});
