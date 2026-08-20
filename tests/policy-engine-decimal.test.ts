/**
 * K-06 Policy Engine — exact decimals, at the boundaries (FND-005b).
 *
 * This file is about one number: `216.04800000000003`.
 *
 * That is what a double produces for `1234.56 * 0.175`, and it is why no rate in this component is
 * ever a `number`. The failure it causes is not loud. A commission rounds correctly on most totals
 * and incorrectly on some; the difference is a penny; the penny appears in a reconciliation report
 * three weeks later with no way to trace which transaction it came from. v3 §38 requires
 * deterministic services for exactly the operations that read these values — commissions, refunds,
 * settlements, reserves, payouts — and determinism means the arithmetic gives the same answer every
 * time, not that it gives it quickly.
 *
 * So the cases below are about exactness rather than about arithmetic: comparison across scales,
 * the boundary of a threshold band, values a double could not hold, and every shape of "this is a
 * number, not a decimal" being refused at the point somebody could still fix it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  MAX_DIGITS,
  MAX_SCALE,
  PolicyError,
  assertDecimal,
  compareDecimals,
  decimalFromText,
  decimalToText,
  decimalsEqual,
  isNegative,
  isZero,
  refuseFloatingPoint,
} from '../kernel/policy-engine/index.ts';

import { POLICY, build, draftRequest, rate, withActivePolicy } from './helpers/policy-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof PolicyError ? error.code : undefined;

// ---------------------------------------------------------------------------
// Exactness
// ---------------------------------------------------------------------------

test('a decimal round-trips through text without losing a digit', () => {
  const cases: ReadonlyArray<readonly [{ units: string; scale: number }, string]> = [
    [{ units: '17500', scale: 4 }, '1.7500'],
    [{ units: '1000', scale: 4 }, '0.1000'],
    [{ units: '0', scale: 4 }, '0.0000'],
    [{ units: '-2500', scale: 4 }, '-0.2500'],
    [{ units: '123456789', scale: 0 }, '123456789'],
    [{ units: '1', scale: 9 }, '0.000000001'],
    [{ units: '-1', scale: 9 }, '-0.000000001'],
    [{ units: '999999999999999999999999999999', scale: 0 }, '999999999999999999999999999999'],
  ];

  for (const [decimal, text] of cases) {
    assert.equal(decimalToText(decimal), text, `${decimal.units}e-${decimal.scale}`);
    assert.deepEqual(
      decimalFromText(text, 'value'),
      decimal,
      `"${text}" did not parse back to what produced it`,
    );
  }
});

test('a value a double cannot hold survives exactly', () => {
  // 0.1 + 0.2, and the product that motivates the whole module.
  const exact = decimalFromText('216.048', 'value');
  assert.equal(decimalToText(exact), '216.048');
  // The double is wrong, and *which way* it is wrong is a V8 detail — so the assertion is that
  // it differs, not what it differs by. Pinning the wrong digits would be testing the float.
  assert.notEqual(String(1234.56 * 0.175), '216.048', 'the double cannot hold this product');
  assert.notEqual(decimalToText(exact), String(1234.56 * 0.175));
  assert.notEqual(String(0.1 + 0.2), '0.3');

  const third = decimalFromText('0.333333333', 'value');
  assert.equal(decimalToText(third), '0.333333333', 'nine digits, none of them rounded');
});

test('comparison is exact across scales, and equality follows the quantity', () => {
  assert.equal(compareDecimals(rate('150', 2), rate('15000', 4)), 0, '1.50 equals 1.5000');
  assert.ok(decimalsEqual(rate('150', 2), rate('15000', 4)));
  assert.equal(compareDecimals(rate('15001', 4), rate('150', 2)), 1);
  assert.equal(compareDecimals(rate('14999', 4), rate('150', 2)), -1);

  // The case a float gets wrong: two values a hundred-millionth apart.
  assert.equal(compareDecimals(rate('100000001', 9), rate('100000000', 9)), 1);
  assert.equal(compareDecimals(rate('-1', 4), rate('0', 4)), -1);
});

test('a stored decimal keeps the scale its author wrote', () => {
  // "17.5%" and "17.5000%" say different things about how precisely somebody meant it, so a
  // decimal is never trimmed on the way through.
  assert.equal(decimalToText(rate('17500', 4)), '1.7500');
  assert.equal(decimalToText(rate('175', 2)), '1.75');
  assert.ok(
    decimalsEqual(rate('17500', 4), rate('175', 2)),
    'and they are still the same quantity',
  );
});

test('zero and sign are exact at any scale', () => {
  assert.ok(isZero(rate('0', 0)));
  assert.ok(isZero(rate('0', 9)));
  assert.ok(!isZero(rate('1', 9)));
  assert.ok(isNegative(rate('-1', 4)));
  assert.ok(!isNegative(rate('0', 4)));
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('a number where a decimal belongs is refused as lossy, not as malformed', () => {
  // The distinction matters: `{ rate: 0.175 }` is not a typo. It is a value that will keep working
  // until it is one a double cannot hold, and the message has to say so.
  for (const value of [0.175, 1, 0, -2.5, 1e21]) {
    assert.throws(
      () => {
        refuseFloatingPoint(value, 'rate');
      },
      (error: unknown) => {
        assert.equal(codeOf(error), 'lossy-numeric-value', String(value));
        assert.match((error as Error).message, /exact decimals/);
        return true;
      },
    );
  }
  // And it says nothing about values that are not numbers.
  refuseFloatingPoint({ units: '1', scale: 0 }, 'rate');
  refuseFloatingPoint('1', 'rate');
});

test('a malformed significand or scale is refused', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['a units field that is a number', { units: 17500, scale: 4 }],
    ['a scale that is text', { units: '17500', scale: '4' }],
    ['a leading zero', { units: '017500', scale: 4 }],
    ['a decimal point in the significand', { units: '175.00', scale: 4 }],
    ['an exponent', { units: '1e5', scale: 4 }],
    ['a thousands separator', { units: '17,500', scale: 4 }],
    ['a negative scale', { units: '1', scale: -1 }],
    ['a fractional scale', { units: '1', scale: 1.5 }],
    ['a scale beyond the bound', { units: '1', scale: MAX_SCALE + 1 }],
    ['too many digits', { units: '1'.repeat(MAX_DIGITS + 1), scale: 0 }],
    ['no object at all', null],
    ['an empty significand', { units: '', scale: 0 }],
    ['NaN as the scale', { units: '1', scale: Number.NaN }],
  ];

  for (const [why, value] of cases) {
    assert.throws(
      () => assertDecimal(value, 'rate'),
      (error: unknown) => {
        assert.ok(
          codeOf(error) === 'malformed-decimal' || codeOf(error) === 'lossy-numeric-value',
          `${why}: ${String(codeOf(error))}`,
        );
        return true;
      },
      `${why} must be refused`,
    );
  }
});

test('scientific notation, Infinity and NaN are refused when read back', () => {
  // The adapter reads `numeric` as text. These are the shapes PostgreSQL or a hand-written row
  // could produce that are not policy values.
  for (const text of ['1e5', 'Infinity', '-Infinity', 'NaN', '', '1.', '.5', '+1', '1 000']) {
    assert.throws(
      () => decimalFromText(text, 'rate'),
      (error: unknown) => codeOf(error) === 'malformed-decimal',
      `"${text}" must be refused`,
    );
  }
  assert.throws(
    () => decimalFromText(216.048, 'rate'),
    (error: unknown) => {
      assert.match((error as Error).message, /never converts it to a double/);
      return codeOf(error) === 'malformed-decimal';
    },
    'a number arriving from the driver means the column is not numeric-as-text',
  );
});

// ---------------------------------------------------------------------------
// Through the whole component
// ---------------------------------------------------------------------------

test('a policy value outside its declared range is refused at authoring', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.draft(
      draftRequest({
        rules: [
          {
            ruleId: 'rule_01HQZXOUTOFR1',
            selector: {},
            condition: null,
            outputs: {
              rate: { kind: 'decimal', value: rate('100001') },
              holdSeconds: { kind: 'duration-seconds', value: 0 },
            },
          },
        ],
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unsupported-output');
      assert.match((error as Error).message, /outside the declared range/);
      return true;
    },
  );
});

test('a value whose scale differs from the declared one is refused rather than coerced', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.draft(
      draftRequest({
        rules: [
          {
            ruleId: 'rule_01HQZXSCALE01',
            selector: {},
            condition: null,
            outputs: {
              rate: { kind: 'decimal', value: rate('175', 2) },
              holdSeconds: { kind: 'duration-seconds', value: 0 },
            },
          },
        ],
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-decimal');
      assert.match((error as Error).message, /statement of how precisely/);
      return true;
    },
  );
});

test('an amount threshold decides exactly at its boundary', async () => {
  // The case a float gets wrong. A band boundary at 1000.0000 must include 1000.0000 in the
  // at-least branch and exclude it from the below branch, at every scale the amount is written in.
  const { harness } = await withActivePolicy(build(), {
    rules: [
      {
        ruleId: 'rule_01HQZXSMALL01',
        selector: {},
        condition: { kind: 'amount-below', amount: rate('10000000') },
        outputs: {
          rate: { kind: 'decimal', value: rate('1500') },
          holdSeconds: { kind: 'duration-seconds', value: 0 },
        },
      },
      {
        ruleId: 'rule_01HQZXLARGE01',
        selector: {},
        condition: { kind: 'amount-at-least', amount: rate('10000000') },
        outputs: {
          rate: { kind: 'decimal', value: rate('1000') },
          holdSeconds: { kind: 'duration-seconds', value: 0 },
        },
      },
    ],
  });

  const at = async (amount: { units: string; scale: number }) =>
    (await harness.service.evaluate({ policyKey: POLICY, facts: { amount } })).ruleId;

  assert.equal(await at(rate('9999999')), 'rule_01HQZXSMALL01', 'a ten-thousandth below');
  assert.equal(await at(rate('10000000')), 'rule_01HQZXLARGE01', 'exactly at the boundary');
  assert.equal(await at(rate('10000001')), 'rule_01HQZXLARGE01', 'a ten-thousandth above');
  // The same quantity written at a different scale decides the same way.
  assert.equal(await at(rate('1000', 0)), 'rule_01HQZXLARGE01', 'scale 0, same quantity');
  assert.equal(await at(rate('100000000000', 8)), 'rule_01HQZXLARGE01', 'scale 8, same quantity');
});

test('an amount supplied as a number is refused before it can decide a band', async () => {
  const { harness } = await withActivePolicy();
  await assert.rejects(
    harness.service.evaluate({ policyKey: POLICY, facts: { amount: 1000.5 } }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'lossy-numeric-value');
      assert.match((error as Error).message, /decides a commission band incorrectly/);
      return true;
    },
  );
});

test('there is no floating-point arithmetic anywhere in the component', () => {
  // A structural check, because the failure it prevents is invisible in a passing test: a `*` or a
  // `parseFloat` over a rate would produce right answers until it did not.
  const source = [
    'decimal.ts',
    'decide.ts',
    'service.ts',
    'validate.ts',
    'registry.ts',
    'postgres-repository.ts',
  ]
    .map((file) => readFileSync(`kernel/policy-engine/${file}`, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, ' ');

  for (const forbidden of [
    'parseFloat',
    'Number.parseFloat',
    'toFixed',
    'Math.round',
    'Math.pow',
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `${forbidden} appears in the policy engine; policy values are exact and never rounded here`,
    );
  }
});
