/**
 * K-11 Commerce Unit Registry — the boundary, and the vocabulary (FND-005c).
 *
 * The claim this file holds is one sentence from v3 §12: *never hardcode commerce assumptions
 * around one category.* A registry is how that stops being advice — but only if the register is
 * closed. If any string is a kind and any string is a unit, then the vocabulary is a naming
 * convention with a database behind it, and the first two modules to use it will spell the same
 * unit differently and never find out.
 *
 * So the kinds are v3 §11's ten, the units are v3 §12's, and a unit must belong to a family its
 * kind allows: a vehicle sold by the night is refused, not stored. The rest is the ownership
 * boundary — no price, no currency, no conversion factor, no tax rule, no display text — enforced
 * by name rather than by convention, because each of those is a component that exists or will, and
 * a second copy here is where two systems start disagreeing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSERTED_OUTCOME_FIELDS,
  CommerceUnitError,
  CommerceUnitRegistryService,
  InMemoryCommerceUnitRepository,
  MEASURE_FAMILIES,
  NO_REGISTRAR,
  PINNED_VERSION_FIELDS,
  UNIT_KINDS,
  type UnitOfMeasure,
} from '../kernel/commerce-unit-registry/index.ts';

import {
  AUTHORITY,
  FixedClock,
  ROOT,
  build,
  nextId,
  publishRequest,
  withActiveType,
} from './helpers/commerce-unit-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof CommerceUnitError ? error.code : undefined;

// ---------------------------------------------------------------------------
// The vocabulary is the guide's, and it is closed
// ---------------------------------------------------------------------------

test('the kinds are exactly v3 §11’s ten', () => {
  assert.deepEqual(
    [...UNIT_KINDS],
    [
      'new-product',
      'used-product',
      'bulk-commodity',
      'vehicle',
      'accommodation',
      'service',
      'rental',
      'wholesale-lot',
      'custom-item',
      'other',
    ],
    'the kind list is the guide’s; adding to it is a decision that belongs in the guide',
  );
});

test('the units are exactly v3 §12’s, grouped as the guide groups them', () => {
  assert.deepEqual(
    [...MEASURE_FAMILIES.goods],
    ['each', 'gram', 'kilogram', 'tonne', 'litre', 'metre', 'box', 'pallet', 'lot', 'container'],
  );
  assert.deepEqual(
    [...MEASURE_FAMILIES.accommodation],
    ['night', 'week', 'month', 'room', 'property', 'guest'],
  );
  assert.deepEqual(
    [...MEASURE_FAMILIES.service],
    ['hour', 'job', 'visit', 'kilometre', 'quotation', 'fixed-package'],
  );
  assert.deepEqual([...MEASURE_FAMILIES.rental], ['hour', 'day', 'week', 'month']);

  // `hour` is in two families and means different things in each, which is why a unit is always
  // qualified: an hour of somebody's labour is not an hour of a machine's availability.
  assert.ok(MEASURE_FAMILIES.service.includes('hour'));
  assert.ok(MEASURE_FAMILIES.rental.includes('hour'));
});

test('a kind outside the register is refused, and says the list is closed', async () => {
  const harness = build();
  for (const kind of ['digital-download', 'subscription', 'NFT', '', 'new_product']) {
    await assert.rejects(
      harness.service.publish(publishRequest({ kind })),
      (error: unknown) => {
        assert.equal(codeOf(error), 'unsupported-kind', kind);
        return true;
      },
      `"${kind}" is not one of v3 §11's kinds`,
    );
  }
});

test('a unit outside the register, or unqualified, is refused', async () => {
  const harness = build();
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['a unit nobody registered', [{ family: 'goods', unit: 'dozen' }]],
    ['a family nobody registered', [{ family: 'digital', unit: 'each' }]],
    ['an unqualified unit', ['each']],
    ['no units at all', []],
    [
      'the same unit twice',
      [
        { family: 'goods', unit: 'each' },
        { family: 'goods', unit: 'each' },
      ],
    ],
  ];

  for (const [why, measures] of cases) {
    await assert.rejects(
      harness.service.publish(publishRequest({ measures: measures as readonly unknown[] })),
      (error: unknown) => {
        assert.equal(codeOf(error), 'unsupported-measure', why);
        return true;
      },
      `${why} must be refused`,
    );
  }
});

test('a unit the kind does not permit is refused as not permitted, not as unknown', async () => {
  // The distinction matters: `night` is a real unit, and the mistake is pairing it with a vehicle.
  const harness = build();
  const cases: ReadonlyArray<readonly [string, string, { family: string; unit: string }]> = [
    ['a vehicle sold by the night', 'vehicle', { family: 'accommodation', unit: 'night' }],
    ['accommodation sold by the tonne', 'accommodation', { family: 'goods', unit: 'tonne' }],
    ['a service sold by the pallet', 'service', { family: 'goods', unit: 'pallet' }],
    ['a rental sold by the job', 'rental', { family: 'service', unit: 'job' }],
  ];

  for (const [why, kind, measure] of cases) {
    await assert.rejects(
      harness.service.publish(publishRequest({ kind, measures: [measure] })),
      (error: unknown) => {
        assert.equal(codeOf(error), 'measure-not-permitted', why);
        assert.match((error as Error).message, /v3 §12 groups the units by what they are for/);
        return true;
      },
      `${why} must be refused`,
    );
  }
});

test('which kinds a deployment permits is configuration, not code', async () => {
  // v3 §11 ends with "other future permitted category", and v3 §12 forbids hardcoding commerce
  // assumptions. A marketplace that does not do accommodation should not be able to acquire an
  // accommodation category by accident.
  const harness = build();
  harness.configuration.answerWith({ permitted: ['new-product', 'used-product'] });

  await harness.service.publish(publishRequest({ kind: 'new-product' }));
  await assert.rejects(
    harness.service.publish(publishRequest({ kind: 'accommodation' })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unsupported-kind');
      assert.match((error as Error).message, /this deployment does not permit it/);
      return true;
    },
  );

  assert.equal(harness.configuration.asked[0]?.key, 'commerce.unit-kinds.permitted');
});

test('an unresolvable permitted-kinds list refuses publication rather than defaulting', async () => {
  const harness = build();
  for (const [why, options] of [
    ['K-05 refusing outright', { refuseWith: new Error('no configuration version') }],
    ['a value that is not a list', { permitted: 'everything' }],
    ['a list of the wrong shape', { permitted: [1, 2, 3] }],
  ] as const) {
    harness.configuration.answerWith(options);
    await assert.rejects(
      harness.service.publish(publishRequest()),
      (error: unknown) => {
        assert.ok(error instanceof Error, why);
        return true;
      },
      `${why} must refuse rather than permit everything`,
    );
  }
  assert.equal(harness.repository.versions().length, 0);
});

// ---------------------------------------------------------------------------
// What the registry does not own
// ---------------------------------------------------------------------------

test('a type may not carry money, tax, conversion or display text', async () => {
  const harness = build();
  const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
    ['price', /K-10 Ledger foundation/],
    ['currency', /K-10 Ledger foundation/],
    ['amount', /K-10 Ledger foundation/],
    ['taxRate', /K-06 Policy/],
    ['conversionFactor', /second place quantities are computed/],
    ['title', /display text/],
    ['description', /display text/],
    ['translations', /Localization/],
    ['allowed', /K-04 Permissions/],
    ['entitled', /Capability & Verification/],
  ];

  for (const [field, owner] of forbidden) {
    await assert.rejects(
      harness.service.publish(publishRequest({ [field]: 'anything' })),
      (error: unknown) => {
        assert.equal(codeOf(error), 'caller-asserted-outcome', field);
        assert.match((error as Error).message, owner, field);
        return true;
      },
      `a type must not carry "${field}"`,
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
      /K-04|K-06|K-10|Ledger|Capability|Localization|derived|display text|version|force|clock/i.test(
        why,
      ),
      `${field}'s explanation names neither the owner nor why it is derived: "${why}"`,
    );
  }
});

test('a natural, personal or credential-shaped value is refused wherever it appears', async () => {
  const harness = build();
  const cases: ReadonlyArray<readonly [string, () => Promise<unknown>, string]> = [
    [
      'a type version id that is an email',
      () => harness.service.publish(publishRequest({ typeVersionId: 'alice@example.com' })),
      'natural-identifier',
    ],
    [
      'an idempotency key that is a credential',
      () => harness.service.publish(publishRequest({ idempotencyKey: 'api_key_9f3c2b1a7d4e' })),
      'secret-bearing-input',
    ],
    [
      'a type key that is a telephone number',
      () => harness.service.publish(publishRequest({ typeKey: '447700900123456' })),
      'malformed-identifier',
    ],
  ];

  for (const [why, run, expected] of cases) {
    await assert.rejects(run(), (error: unknown) => {
      assert.equal(codeOf(error), expected, why);
      return true;
    });
  }
});

test('a type key that is merely misspelt is refused as malformed', async () => {
  const harness = build();
  for (const typeKey of ['UPPER.case', 'trailing.', 'a.b.c.d.e', '.leading', 'has space']) {
    await assert.rejects(
      harness.service.publish(publishRequest({ typeKey })),
      (error: unknown) => codeOf(error) === 'malformed-identifier',
      `"${typeKey}" is not a type key`,
    );
  }
});

// ---------------------------------------------------------------------------
// Nobody registers by default
// ---------------------------------------------------------------------------

test('a service with no injected registrar publishes, activates and retires nothing', async () => {
  const repository = new InMemoryCommerceUnitRepository();
  const service = new CommerceUnitRegistryService({ repository, clock: new FixedClock() });

  const attempts: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ['publish', () => service.publish(publishRequest())],
    [
      'activate',
      () =>
        service.activate({
          activationId: nextId('act'),
          typeVersionId: 'typever_01HQZXNOTHER',
          supersedesVersionId: null,
          idempotencyKey: nextId('idem'),
        }),
    ],
    [
      'retire',
      () =>
        service.retire({
          retirementId: nextId('ret'),
          typeKey: ROOT,
          reason: 'because',
          idempotencyKey: nextId('idem'),
        }),
    ],
  ];

  for (const [operation, run] of attempts) {
    await assert.rejects(run(), (error: unknown) => {
      assert.equal(codeOf(error), 'registration-refused', operation);
      assert.match((error as Error).message, /what the platform believes it is selling/);
      return true;
    });
  }
  assert.equal(repository.versions().length, 0);
});

test('the default registrar refuses, and the author is never taken from the request', async () => {
  assert.equal(NO_REGISTRAR.permitsRegistration(), false);

  const harness = build();
  const published = await harness.service.publish(publishRequest());
  assert.deepEqual(published.version.publishedBy, { kind: 'system', id: AUTHORITY });

  await assert.rejects(
    harness.service.publish(
      publishRequest({ publishedBy: { kind: 'human', id: 'ops-alice' } } as never),
    ),
    (error: unknown) => {
      assert.match((error as Error).message, /does not accept the field "publishedBy"/);
      return codeOf(error) === 'malformed-record';
    },
  );
});

// ---------------------------------------------------------------------------
// Shape of the surface
// ---------------------------------------------------------------------------

test('the service exposes no bypass, no update, no delete and no arithmetic', () => {
  const operations = new Set<string>();
  let proto: object | null = CommerceUnitRegistryService.prototype;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  const forbidden = [...operations].filter((name) =>
    /delete|remove|purge|update|edit|bypass|override|convert|price|translate/i.test(name),
  );
  assert.deepEqual(
    forbidden,
    [],
    'registry history is append-only, and K-11 converts nothing and prices nothing',
  );

  assert.deepEqual(
    [...operations].sort(),
    ['activate', 'constructor', 'publish', 'resolve', 'retire'],
    'four operations and a constructor: the whole surface',
  );
});

test('every record crossing the boundary is sealed all the way down', async () => {
  const { harness, version } = await withActiveType();

  assert.ok(Object.isFrozen(version));
  assert.ok(Object.isFrozen(version.measures));
  assert.ok(Object.isFrozen(version.measures[0]));
  assert.ok(Object.isFrozen(version.owner));
  // Cast away the `readonly`, which is all a caller in JavaScript ever had, and the push still
  // throws: the guarantee is the freeze at runtime and not the type. Asserted through
  // `UnitOfMeasure[]` rather than a hand-written `{ push }`, because the two do not overlap as
  // types and the compiler is right to say so — the point is a mutable array, not a stray method.
  assert.throws(() => {
    (version.measures as UnitOfMeasure[]).push({ family: 'goods', unit: 'lot' });
  });

  const resolved = await harness.service.resolve({ typeKey: ROOT });
  assert.ok(Object.isFrozen(resolved));
  assert.ok(Object.isFrozen(resolved.ancestry));
  assert.ok(Object.isFrozen(resolved.measures));
});

test('a type handed back cannot be edited into the store', async () => {
  const { harness, version } = await withActiveType();
  assert.throws(() => {
    (version.measures[0] as { unit: string }).unit = 'tonne';
  });

  const stored = harness.repository
    .versions()
    .find((entry) => entry.typeVersionId === version.typeVersionId);
  assert.deepEqual(stored?.measures[0], { family: 'goods', unit: 'each' });
});
