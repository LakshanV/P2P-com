/**
 * K-07 Feature Flags — percentage rollout, at the boundaries (FND-004e).
 *
 * A rollout has exactly two ways to be wrong, and both are silent.
 *
 * **Instability.** If the bucket moves between requests, a user watches a feature appear and
 * vanish, and an operator watching error rates at 10% is watching a population that keeps
 * changing. Nothing here reads a clock or a random source, and the determinism cases below pin
 * that: the same key hashes to the same bucket across calls, across service instances and across
 * the version's other fields changing.
 *
 * **Boundary error.** At 0% a rollout must include *nobody* — the case that matters most, because
 * a flag published at zero is one nobody has started yet, and an off-by-one there enables a risky
 * feature for whoever happens to hash to zero. At 100% it must include everybody, or a completed
 * rollout leaves a residue of users who never get the feature and nobody can explain why.
 *
 * The distribution cases are deliberately loose. They are not tests of SHA-256; they exist so that
 * a change substituting a hash with poor low-bit behaviour is noticed rather than merely reviewed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BUCKET_COUNT, bucketOf, inRollout } from '../kernel/feature-flags/index.ts';

import { FLAG, SALT, build, withActiveFlag } from './helpers/feature-flag-fixtures.ts';

/** A population of opaque subject keys, generated the way real ones would look. */
const population = (count: number): readonly string[] =>
  Array.from({ length: count }, (_, index) => `sub_01HQZXROLL${String(index).padStart(6, '0')}`);

// ---------------------------------------------------------------------------
// The boundaries
// ---------------------------------------------------------------------------

test('a 0% rollout includes nobody, including bucket zero', () => {
  assert.equal(inRollout(0, 0), false, 'bucket 0 at 0% is the off-by-one that matters');
  for (const bucket of [0, 1, 4999, 9999]) {
    assert.equal(inRollout(bucket, 0), false, `bucket ${bucket} at 0%`);
  }
});

test('a 100% rollout includes everybody, including the last bucket', () => {
  for (const bucket of [0, 1, 4999, BUCKET_COUNT - 1]) {
    assert.equal(inRollout(bucket, 100), true, `bucket ${bucket} at 100%`);
  }
});

test('a whole percent is exactly one hundred buckets, with no bucket on both sides', () => {
  for (const percentage of [1, 7, 50, 99]) {
    const ceiling = percentage * 100;
    assert.equal(
      inRollout(ceiling - 1, percentage),
      true,
      `${percentage}% includes ${ceiling - 1}`,
    );
    assert.equal(inRollout(ceiling, percentage), false, `${percentage}% excludes ${ceiling}`);
  }

  // And the count is exact rather than approximately right.
  const included = Array.from({ length: BUCKET_COUNT }, (_, bucket) =>
    inRollout(bucket, 25),
  ).filter(Boolean).length;
  assert.equal(included, 2500, '25% of ten thousand buckets is exactly 2500');
});

test('a rollout only ever widens as the percentage rises', () => {
  // Monotonicity is what makes "increase to 20%" safe: nobody who had the feature loses it.
  const keys = population(500);
  let previous = new Set<string>();
  for (const percentage of [0, 5, 10, 25, 50, 100]) {
    const included = new Set(
      keys.filter((key) => inRollout(bucketOf(FLAG, SALT, key), percentage)),
    );
    for (const key of previous) {
      assert.ok(included.has(key), `${key} lost the feature when the rollout widened`);
    }
    previous = included;
  }
  assert.equal(previous.size, 500, 'and at 100% everybody is in');
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test('the same subject hashes to the same bucket, always', () => {
  const key = 'sub_01HQZXSTABLE01';
  const first = bucketOf(FLAG, SALT, key);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(bucketOf(FLAG, SALT, key), first);
  }
  assert.ok(first >= 0 && first < BUCKET_COUNT, `bucket ${first} is out of range`);
});

test('two flags at the same percentage do not select the same population', () => {
  // Otherwise the 10% who received the first risky feature are exactly the 10% who receive the
  // second, and the third, and the platform has one unlucky cohort carrying every rollout.
  const keys = population(2000);
  const first = new Set(keys.filter((key) => inRollout(bucketOf(FLAG, SALT, key), 10)));
  const second = new Set(
    keys.filter((key) => inRollout(bucketOf('commerce.supplier-autopricing', SALT, key), 10)),
  );

  const overlap = [...first].filter((key) => second.has(key)).length;
  assert.ok(first.size > 100, 'the first rollout selected a usable sample');
  assert.ok(
    overlap < first.size * 0.5,
    `${overlap} of ${first.size} subjects are in both 10% rollouts; the flag key is not ` +
      'separating the populations',
  );
});

test('a new salt redraws the population, which is what publishing one is for', () => {
  const keys = population(2000);
  const before = new Set(keys.filter((key) => inRollout(bucketOf(FLAG, SALT, key), 20)));
  const after = new Set(
    keys.filter((key) => inRollout(bucketOf(FLAG, 'salt02HQZXFLAG02', key), 20)),
  );

  const overlap = [...before].filter((key) => after.has(key)).length;
  assert.ok(
    overlap < before.size * 0.6,
    `a new salt left ${overlap} of ${before.size} subjects in the same rollout; it is not redrawing`,
  );
});

test('the bucket distribution is not obviously skewed', () => {
  // Not a test of SHA-256. It exists so that swapping in a hash with poor low-bit behaviour, or
  // dropping the modulo, is caught by a run rather than by a reviewer.
  const counts = new Array<number>(10).fill(0);
  for (const key of population(10_000)) {
    const decile = Math.floor(bucketOf(FLAG, SALT, key) / (BUCKET_COUNT / 10));
    counts[decile] = (counts[decile] ?? 0) + 1;
  }
  for (const [decile, count] of counts.entries()) {
    assert.ok(
      count > 700 && count < 1300,
      `decile ${decile} holds ${count} of 10000 subjects; the distribution is skewed`,
    );
  }
});

// ---------------------------------------------------------------------------
// Through the service
// ---------------------------------------------------------------------------

test('a percentage rollout with no subject key is off rather than random', async () => {
  const harness = build();
  await withActiveFlag(harness, { state: 'percentage', percentage: 100 });

  const evaluation = await harness.service.evaluate({ flagKey: FLAG });
  assert.equal(evaluation.enabled, false, 'even at 100%, with nothing to bucket');
  assert.equal(evaluation.reason, 'missing-subject-key');
  assert.match(evaluation.explanation, /not a rollout/);
  assert.equal(evaluation.bucket, null);
});

test('an evaluation reports the bucket it used, so a rollout can be reasoned about', async () => {
  const harness = build();
  await withActiveFlag(harness, { state: 'percentage', percentage: 50 });

  const key = 'sub_01HQZXBUCKET01';
  const evaluation = await harness.service.evaluate({ flagKey: FLAG, subjectKey: key });

  assert.equal(evaluation.bucket, bucketOf(FLAG, SALT, key));
  assert.equal(evaluation.enabled, inRollout(evaluation.bucket ?? -1, 50));
  assert.match(evaluation.explanation, /bucket \d+ of 10000/);
});

test('0% and 100% behave through the whole service, not only in the arithmetic', async () => {
  const keys = population(50);

  const none = build();
  await withActiveFlag(none, { state: 'percentage', percentage: 0 });
  for (const key of keys) {
    const evaluation = await none.service.evaluate({ flagKey: FLAG, subjectKey: key });
    assert.equal(evaluation.enabled, false, `${key} was included in a 0% rollout`);
    assert.equal(evaluation.reason, 'percentage-excluded');
  }

  const all = build();
  await withActiveFlag(all, { state: 'percentage', percentage: 100 });
  for (const key of keys) {
    const evaluation = await all.service.evaluate({ flagKey: FLAG, subjectKey: key });
    assert.equal(evaluation.enabled, true, `${key} was excluded from a 100% rollout`);
    assert.equal(evaluation.reason, 'percentage-included');
  }
});

test('a percentage outside 0–100, or not a whole number, is refused at publication', async () => {
  const harness = build();
  for (const percentage of [-1, 101, 12.5, Number.NaN]) {
    await assert.rejects(
      withActiveFlag(build(), { state: 'percentage', percentage }),
      (error: unknown) => (error as { code?: string }).code === 'malformed-record',
      `percentage ${percentage} must be refused`,
    );
  }
  void harness;
});
