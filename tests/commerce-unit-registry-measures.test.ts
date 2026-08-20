/**
 * K-11 Commerce Unit Registry — what a unit of measure may carry (FND-005c).
 *
 * `measures[]` is the one nested structure in a publish request, and it was the one place a field
 * this component has no meaning for was **dropped instead of refused**. The top level has been
 * checked field-by-field from the start — `assertKnownFields` exists so that a typo is not
 * silently ignored — but a measure was read for `family` and `unit` and rebuilt from them, and
 * whatever else the caller attached simply did not survive the copy.
 *
 * Dropping is worse than storing here, for three reasons, and this file is one section per reason:
 *
 *   - **Nothing came back.** A caller who publishes `{ family, unit, price: 500 }` has, as far as
 *     any response tells them, recorded a price with the registry. K-11 holds no price, no
 *     currency, no conversion factor, no tax rule and no display text — every one of those belongs
 *     to a component that exists or will — so the belief is wrong, and the platform gave them no
 *     way to find that out. The same is true of `familly` spelt wrong: not an unqualified unit, a
 *     unit its author believes they qualified.
 *
 *   - **A hidden field is invisible to the fingerprint.** `canonicalMeasures` hashes `family/unit`
 *     pairs. Two publications differing *only* in what a measure secretly carried therefore
 *     fingerprint the same, so a retry on one idempotency key **converged** — and convergence hands
 *     back a type version id for a request nobody made, which is then copied into every listing
 *     created under it. K-04 shipped that hole through the key itself (§11.27); this is the same
 *     hole reached through a nested object.
 *
 *   - **Most ways of hiding a field are invisible to a reviewer too.** A prototype, a getter and a
 *     symbol key are all absent from `Object.keys` *and* from `JSON.stringify`, so the request as
 *     anybody would print it does not show them.
 *
 * The rule is an allowlist and not a denylist, which is what these tests are really pinning: a list
 * of forbidden names refuses `price` and admits `unitPrice`. Requiring exactly `family` and `unit`
 * refuses the field nobody has thought of yet.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommerceUnitError,
  MEASURE_FAMILIES,
  assertMeasure,
  canonicalMeasures,
  type UnitOfMeasure,
} from '../kernel/commerce-unit-registry/index.ts';

import { build, nextId, publishRequest } from './helpers/commerce-unit-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof CommerceUnitError ? error.code : undefined;

/** A measure that is exactly what the vocabulary says one is. */
const EACH = { family: 'goods', unit: 'each' } as const;

const rejects = (measure: unknown, why: string): void => {
  const error = (() => {
    try {
      assertMeasure(measure, 'measures[0]');
    } catch (thrown: unknown) {
      return thrown;
    }
    return null;
  })();

  assert.ok(error !== null, `${why} was accepted; a dropped field is a field somebody believes in`);
  assert.equal(codeOf(error), 'unsupported-measure', why);
};

// ---------------------------------------------------------------------------
// A field this component has no meaning for is refused, not quietly discarded
// ---------------------------------------------------------------------------

test('a measure carrying another component’s subject matter is refused', () => {
  // Financial, then display, then a secret. Each names a boundary K-11 states in its own header:
  // money belongs to K-10, display text to localization, and a credential belongs nowhere near a
  // record that is permanent and copied into every listing.
  for (const field of [
    'price',
    'unitPrice',
    'amount',
    'currency',
    'currencyCode',
    'taxRate',
    'vatRate',
    'conversionFactor',
    'factor',
    'label',
    'displayName',
    'description',
    'nameSi',
    'apiKey',
    'password',
    'token',
    'authorization',
  ]) {
    rejects({ ...EACH, [field]: 'anything' }, `a measure carrying ${field}`);
  }
});

test('a field nobody has thought of yet is refused by the same rule', () => {
  // The point of an allowlist. None of these is on any denylist that could be written, and every
  // one of them is a property somebody would believe the vocabulary carries.
  for (const field of ['weightingFactor', 'roundingMode', 'x', 'meta', '__proto__x', 'notes']) {
    rejects({ ...EACH, [field]: 1 }, `a measure carrying ${field}`);
  }
});

test('a misspelt field is refused as a field, not silently read as a missing one', () => {
  // `familly` is not "no family given". Reporting it as unqualified would send its author looking
  // for a value they supplied, spelt one letter wrong, in a request that was accepted.
  rejects({ familly: 'goods', unit: 'each' }, 'family spelt wrong');
  rejects({ family: 'goods', unitt: 'each' }, 'unit spelt wrong');
  rejects({ family: 'goods', unit: 'each', Unit: 'kilogram' }, 'unit in the wrong case');
  rejects({ family: 'goods', unit: 'each', UNIT: 'kilogram' }, 'unit shouted');
});

// ---------------------------------------------------------------------------
// The ways of hiding a field that a printed request would not show
// ---------------------------------------------------------------------------

test('a field inherited through a prototype is refused', () => {
  // `Object.keys` reports ["family", "unit"] and `JSON.stringify` prints exactly a valid measure.
  const smuggled = Object.create({ price: 500, currency: 'LKR' }) as Record<string, unknown>;
  smuggled.family = 'goods';
  smuggled.unit = 'each';

  assert.deepEqual(Object.keys(smuggled), ['family', 'unit'], 'the fixture must look innocent');
  assert.equal(JSON.stringify(smuggled), '{"family":"goods","unit":"each"}');
  assert.equal(smuggled.price, 500, 'and the value must genuinely be readable through it');

  rejects(smuggled, 'a measure inheriting a price');
});

test('a class instance is refused, however canonical its own fields look', () => {
  class Measure {
    readonly family = 'goods';
    readonly unit = 'each';
    get price(): number {
      return 500;
    }
  }
  rejects(new Measure(), 'a measure that is an instance of something');
});

test('an accessor-backed field is refused, including on family and unit themselves', () => {
  // A getter can answer differently between the read that validates and the read that stores, so
  // the type recorded need not be the type checked. Refused whichever field it backs.
  const getterOnUnit: Record<string, unknown> = { family: 'goods' };
  Object.defineProperty(getterOnUnit, 'unit', {
    get: () => 'each',
    enumerable: true,
    configurable: true,
  });
  rejects(getterOnUnit, 'a measure whose unit is a getter');

  const getterOnExtra = { ...EACH } as Record<string, unknown>;
  Object.defineProperty(getterOnExtra, 'price', {
    get: () => 500,
    enumerable: true,
    configurable: true,
  });
  rejects(getterOnExtra, 'a measure whose price is a getter');
});

test('a symbol-keyed field is refused', () => {
  const smuggled = { ...EACH, [Symbol.for('price')]: 500 } as Record<string, unknown>;
  assert.deepEqual(Object.keys(smuggled), ['family', 'unit'], 'the fixture must look innocent');
  rejects(smuggled, 'a measure with a symbol-keyed price');
});

test('a non-enumerable field is refused', () => {
  const smuggled = { ...EACH } as Record<string, unknown>;
  Object.defineProperty(smuggled, 'price', { value: 500, enumerable: false });
  assert.deepEqual(Object.keys(smuggled), ['family', 'unit'], 'the fixture must look innocent');
  rejects(smuggled, 'a measure with a non-enumerable price');
});

test('an array is refused, even one carrying the right two entries', () => {
  const smuggled = ['goods', 'each'] as unknown as Record<string, unknown>;
  smuggled.family = 'goods';
  smuggled.unit = 'each';
  rejects(smuggled, 'a measure that is an array');
});

// ---------------------------------------------------------------------------
// Through the service, which is where a caller would have been misled
// ---------------------------------------------------------------------------

test('publishing a measure with a hidden field is refused, and nothing is stored', async () => {
  const harness = build();
  const smuggled = Object.create({ price: 500 }) as Record<string, unknown>;
  smuggled.family = 'goods';
  smuggled.unit = 'each';

  await assert.rejects(
    harness.service.publish(publishRequest({ measures: [smuggled] })),
    (error: unknown) => codeOf(error) === 'unsupported-measure',
  );

  // The failure this replaces is not a wrong row — it is a *right-looking* row plus a caller who
  // believes the registry took their price. Both halves are asserted: the refusal, and the store.
  assert.equal(harness.repository.versions().length, 0, 'a refused publication stored a version');
});

test('the refusal names the field, so its author can find what was refused', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.publish(publishRequest({ measures: [{ ...EACH, currencyCode: 'LKR' }] })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unsupported-measure');
      assert.match((error as Error).message, /measures\[0\] carries the field "currencyCode"/);
      assert.match((error as Error).message, /no price, no currency/);
      return true;
    },
  );
});

test('a hidden field anywhere in the list is refused, not just in the first entry', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.publish(
      publishRequest({
        measures: [EACH, { family: 'goods', unit: 'kilogram', price: 900 }],
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unsupported-measure');
      assert.match((error as Error).message, /measures\[1\] carries the field "price"/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Idempotency: a retry may not converge across hidden data
// ---------------------------------------------------------------------------

test('the fingerprint cannot see a hidden field, which is why one may not get through', () => {
  // The mechanism, stated directly. `canonicalMeasures` hashes family/unit pairs and nothing else,
  // so if a hidden field ever reached it, two different requests would be one question. Refusing
  // at the boundary is what keeps this property safe rather than dangerous.
  const honest: readonly UnitOfMeasure[] = [{ family: 'goods', unit: 'each' }];
  // Through `unknown`, because the compiler is right that this is not a unit of measure. What is
  // being demonstrated is what the *hash* would make of one if the boundary let it past.
  const smuggled = [
    { family: 'goods', unit: 'each', price: 500 },
  ] as unknown as readonly UnitOfMeasure[];
  assert.equal(canonicalMeasures(smuggled), canonicalMeasures(honest));
});

test('a retry that adds hidden measure data is refused rather than converged', async () => {
  // The one that matters. Publish honestly, then retry the same idempotency key with the same
  // visible measures and a price attached. The fingerprints are identical — `canonicalMeasures`
  // cannot see the difference — so before this boundary existed the service answered
  // `deduplicated: true` and handed back the id of a type registered from a *different* request.
  const harness = build();
  const request = publishRequest();
  const first = await harness.service.publish(request);
  assert.equal(first.deduplicated, false);

  await assert.rejects(
    harness.service.publish({
      ...request,
      measures: [
        { ...EACH, price: 500 },
        { family: 'goods', unit: 'kilogram' },
      ],
    }),
    (error: unknown) => codeOf(error) === 'unsupported-measure',
    'a retry carrying hidden data converged instead of being refused',
  );

  assert.equal(harness.repository.versions().length, 1, 'the honest publication, and only it');
});

test('an initial request carrying hidden data leaves no key for a later retry to converge on', async () => {
  // The other direction. If the *first* call smuggles, it must not become a stored decision that a
  // later honest retry can be handed back — which is what would happen if the field were dropped:
  // the smuggled request would be the one on record, under a fingerprint that matches the honest
  // one exactly.
  const harness = build();
  const idempotencyKey = nextId('idem');
  const smuggled = publishRequest({
    idempotencyKey,
    measures: [{ ...EACH, apiKey: 'sk-not-a-real-credential-000000' }],
  });

  await assert.rejects(
    harness.service.publish(smuggled),
    (error: unknown) => codeOf(error) === 'unsupported-measure',
  );
  assert.equal(harness.repository.versions().length, 0);

  // The key is untouched, so an honest request on it is a first publication and says so.
  const honest = await harness.service.publish({ ...smuggled, measures: [EACH] });
  assert.equal(honest.deduplicated, false, 'the refused request became a decision to converge on');
  assert.deepEqual([...honest.version.measures], [EACH]);
});

// ---------------------------------------------------------------------------
// What the boundary must not have broken
// ---------------------------------------------------------------------------

test('every unit of every family in v3 §12 still validates', () => {
  for (const [family, units] of Object.entries(MEASURE_FAMILIES)) {
    for (const unit of units) {
      const measure = assertMeasure({ family, unit }, 'measures[0]');
      assert.deepEqual({ ...measure }, { family, unit });
      assert.ok(Object.isFrozen(measure), 'a validated measure crosses the boundary sealed');
    }
  }
});

test('a canonical measure with no prototype at all is accepted', () => {
  // `Object.create(null)` inherits nothing, which is the one thing this check is about. Refusing it
  // would be refusing a record that is more canonical than a literal, not less.
  const bare = Object.create(null) as Record<string, unknown>;
  bare.family = 'goods';
  bare.unit = 'each';
  assert.deepEqual({ ...assertMeasure(bare, 'measures[0]') }, EACH);
});

test('a sealed measure still validates, which is what every stored row hands back', () => {
  // Stored records are frozen on the way out and re-validated on the way back in — the in-force
  // index revalidates every version it is given. A shape check that rejected a frozen record would
  // refuse the entire catalogue on the first read.
  const sealed = Object.freeze({ family: 'service', unit: 'hour' });
  assert.deepEqual(
    { ...assertMeasure(sealed, 'measures[0]') },
    { family: 'service', unit: 'hour' },
  );
});

test('measure order still does not change the request, and a clean retry still converges', async () => {
  // The canonical sort is what makes that true, and it runs after the shape check. If the new
  // refusals had landed in the wrong place, this is the behaviour that would have broken.
  const harness = build();
  const request = publishRequest({
    measures: [
      { family: 'goods', unit: 'kilogram' },
      { family: 'goods', unit: 'each' },
    ],
  });
  const first = await harness.service.publish(request);
  assert.deepEqual(
    first.version.measures.map((measure) => measure.unit),
    ['each', 'kilogram'],
    'measures are stored in canonical order',
  );

  const retry = await harness.service.publish({
    ...request,
    measures: [
      { family: 'goods', unit: 'each' },
      { family: 'goods', unit: 'kilogram' },
    ],
  });
  assert.equal(retry.deduplicated, true, 'the same request written in another order is the same');
  assert.equal(retry.version.typeVersionId, first.version.typeVersionId);
});

test('the measure refusals that existed before still say what they said', async () => {
  const harness = build();
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ['a family nobody registered', [{ family: 'digital', unit: 'each' }], 'unsupported-measure'],
    ['an unqualified unit', ['each'], 'unsupported-measure'],
    ['no units at all', [], 'unsupported-measure'],
    ['a missing unit', [{ family: 'goods' }], 'unsupported-measure'],
    ['the same unit twice', [EACH, { family: 'goods', unit: 'each' }], 'unsupported-measure'],
    [
      'a unit the kind does not permit',
      [{ family: 'accommodation', unit: 'night' }],
      'measure-not-permitted',
    ],
  ];

  for (const [why, measures, code] of cases) {
    await assert.rejects(
      harness.service.publish(publishRequest({ measures: measures as readonly unknown[] })),
      (error: unknown) => {
        assert.equal(codeOf(error), code, why);
        return true;
      },
    );
  }
});
