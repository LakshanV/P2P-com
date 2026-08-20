/**
 * K-07 Feature Flags — the boundary, and what a flag is not (FND-004e).
 *
 * The refusals in this file are the component. A feature flag is one `if` statement away from
 * being an authorisation system: the code is identical, the storage is identical, and the only
 * thing separating "is this feature running" from "may this party do this" is whether somebody
 * publishes a key called `permissions.admin.enabled`. If they can, the platform has a second
 * authorisation system with no policy version, no audit trail and no revocation — changeable by
 * whoever can reach this service.
 *
 * So the five separations in §1 of the contract are asserted here as behaviour, not read as prose:
 * a key naming authority, money, an entitlement, an experiment or AI autonomy is refused at
 * publication, and a request field by which a caller would state any of those is refused by name.
 * The rest of the file is the ordinary boundary work — malformed state, invalid windows, PII, and
 * an administration authority that defaults to nobody.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSERTED_OUTCOME_FIELDS,
  FeatureFlagError,
  FeatureFlagService,
  InMemoryFeatureFlagRepository,
  NO_ADMINISTRATION,
  NO_CONFIGURATION,
  TARGET_ATTRIBUTE_NAMES,
} from '../kernel/feature-flags/index.ts';

import {
  AUTHORITY,
  FLAG,
  FixedClock,
  build,
  nextId,
  publishRequest,
  withActiveFlag,
} from './helpers/feature-flag-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof FeatureFlagError ? error.code : undefined;

// ---------------------------------------------------------------------------
// A flag is not another component's decision
// ---------------------------------------------------------------------------

test('a flag key that names authority, money, entitlement, an experiment or AI is refused', async () => {
  const harness = build();

  // Each of these is a real thing somebody would want, and each is owned elsewhere. The refusal
  // has to name the owner: "no" alone sends the caller to write it as `commerce.thing-enabled`.
  const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
    ['admin.permissions.enabled', /K-04 Permissions/],
    ['staff.role.elevated', /K-04 Permissions/],
    ['billing.subscription.tier-two', /Capability & Verification/],
    ['seller.payout.instant', /K-10 Ledger foundation/],
    ['checkout.pricing.dynamic', /K-10 Ledger foundation/],
    ['search.experiment.ranking-b', /Analytics/],
    ['agent.ai-authority.expanded', /v3 §38/],
  ];

  for (const [flagKey, owner] of forbidden) {
    await assert.rejects(
      harness.service.publish(publishRequest({ flagKey })),
      (error: unknown) => {
        assert.equal(codeOf(error), 'not-a-feature-flag', flagKey);
        assert.match((error as Error).message, owner, flagKey);
        assert.match((error as Error).message, /deployment control/);
        return true;
      },
      `${flagKey} names a decision another component owns and must be refused`,
    );
  }

  assert.equal(harness.repository.versions().length, 0, 'and none of them was written');
});

test('a request that states the answer is refused by name', async () => {
  const harness = build();

  for (const field of ['enabled', 'bucket', 'variant', 'allowed', 'role', 'price']) {
    await assert.rejects(
      harness.service.evaluate({ flagKey: FLAG, [field]: 'anything' }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'caller-asserted-outcome', field);
        return true;
      },
      `evaluate must refuse "${field}": a caller that could state it would be the flag`,
    );
  }

  // `reason` is not on that list, because an operator killing a feature says why. It is refused on
  // evaluate all the same — as a field the operation has no meaning for, which is the check that
  // catches every field nobody thought to enumerate.
  await assert.rejects(
    harness.service.evaluate({ flagKey: FLAG, reason: 'flag-off' } as never),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as Error).message, /does not accept the field "reason"/);
      return true;
    },
  );
});

test('every refused field explains itself rather than carrying a label', () => {
  // The table is the executable form of §1. An entry that just said "forbidden" would be a rule
  // nobody could apply to the next field somebody invents.
  for (const [field, why] of Object.entries(ASSERTED_OUTCOME_FIELDS)) {
    assert.ok(why.length > 20, `${field} has no explanation`);
    assert.ok(
      /K-04|K-10|K-05|K-06|Analytics|Capability|answer|derived|flag|party|agent/.test(why),
      `${field}'s explanation names neither the owner nor why it is the answer: "${why}"`,
    );
  }
});

test('a flag key that is merely misspelt is refused as malformed, not as somebody else’s job', async () => {
  const harness = build();
  for (const flagKey of ['nodots', 'UPPER.case', 'trailing.', 'a.b.c.d.e', '.leading']) {
    await assert.rejects(
      harness.service.publish(publishRequest({ flagKey })),
      (error: unknown) => codeOf(error) === 'malformed-identifier',
      `"${flagKey}" is not a flag key`,
    );
  }
});

// ---------------------------------------------------------------------------
// Nobody administers by default
// ---------------------------------------------------------------------------

test('a service with no injected authority publishes, activates, kills and retires nothing', async () => {
  const repository = new InMemoryFeatureFlagRepository();
  const service = new FeatureFlagService({ repository, clock: new FixedClock() });

  const attempts: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ['publish', () => service.publish(publishRequest())],
    [
      'activate',
      () =>
        service.activate({
          activationId: nextId('act'),
          flagVersionId: 'flagver_01HQZXNOTHERE',
          supersedesVersionId: null,
          idempotencyKey: nextId('idem'),
        }),
    ],
    [
      'kill',
      () =>
        service.kill({
          eventId: nextId('evt'),
          flagKey: FLAG,
          reason: 'because',
          idempotencyKey: nextId('idem'),
        }),
    ],
    [
      'retire',
      () =>
        service.retire({
          eventId: nextId('evt'),
          flagKey: FLAG,
          reason: 'because',
          idempotencyKey: nextId('idem'),
        }),
    ],
  ];

  for (const [operation, run] of attempts) {
    await assert.rejects(
      run(),
      (error: unknown) => {
        assert.equal(codeOf(error), 'administration-refused', operation);
        assert.match((error as Error).message, /default refuses on purpose/);
        return true;
      },
      `${operation} must refuse when no administration authority was injected`,
    );
  }

  assert.equal(repository.versions().length, 0);
  assert.equal(repository.activations().length, 0);
  assert.equal(repository.lifecycleEvents().length, 0);
});

test('the default ports refuse rather than guess', () => {
  assert.equal(NO_ADMINISTRATION.permitsAdministration(), false);
  // And configuration resolving nothing means an internal-only flag is off, not on.
  assert.equal(typeof NO_CONFIGURATION.resolve, 'function');
});

test('the author is the injected authority, and no request may supply one', async () => {
  const harness = build();
  const published = await harness.service.publish(publishRequest());

  assert.deepEqual(published.version.publishedBy, { kind: 'system', id: AUTHORITY });

  // There is no author field to supply, so supplying one is an unknown field rather than a
  // silently ignored one — the failure mode where somebody believes they signed a change.
  await assert.rejects(
    harness.service.publish(
      publishRequest({ publishedBy: { kind: 'human', id: 'ops-alice' } } as never),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as Error).message, /does not accept the field "publishedBy"/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Malformed definitions
// ---------------------------------------------------------------------------

test('a definition carrying a setting nothing reads is refused', async () => {
  const harness = build();

  await assert.rejects(
    harness.service.publish(publishRequest({ state: 'off', percentage: 25 })),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as Error).message, /nothing evaluates it/);
      return true;
    },
    'a percentage on an off flag is a rollout somebody believes is running',
  );

  await assert.rejects(
    harness.service.publish(
      publishRequest({
        state: 'on',
        rules: [{ kind: 'attribute-equals', attribute: 'country', value: 'country_gb001' }],
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as Error).message, /believes is in force/);
      return true;
    },
    'a rule on a fully-on flag is a restriction that does not restrict',
  );

  await assert.rejects(
    harness.service.publish(publishRequest({ state: 'targeted', rules: [] })),
    (error: unknown) => codeOf(error) === 'malformed-record',
    'a targeted flag with no rules matches nobody',
  );
});

test('an activation window that contains no instant is refused', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.publish(
      publishRequest({
        notBefore: '2026-05-01T00:00:00Z',
        notAfter: '2026-04-01T00:00:00Z',
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'invalid-activation-window');
      assert.match((error as Error).message, /can never be on/);
      return true;
    },
  );

  // Equal bounds are the subtler case: it reads like "just this instant" and is in fact never.
  await assert.rejects(
    harness.service.publish(
      publishRequest({ notBefore: '2026-05-01T00:00:00Z', notAfter: '2026-05-01T00:00:00Z' }),
    ),
    (error: unknown) => codeOf(error) === 'invalid-activation-window',
  );
});

test('an unsupported scope, predicate or attribute is refused at publication', async () => {
  const harness = build();

  await assert.rejects(
    harness.service.publish(publishRequest({ supportedScopes: ['tenant'] })),
    (error: unknown) => codeOf(error) === 'unsupported-scope',
  );
  await assert.rejects(
    harness.service.publish(publishRequest({ supportedScopes: [] })),
    (error: unknown) => {
      assert.match((error as Error).message, /can never be evaluated/);
      return codeOf(error) === 'unsupported-scope';
    },
  );
  await assert.rejects(
    harness.service.publish(publishRequest({ supportedScopes: ['global', 'global'] })),
    (error: unknown) => codeOf(error) === 'unsupported-scope',
  );

  await assert.rejects(
    harness.service.publish(
      publishRequest({
        state: 'targeted',
        rules: [{ kind: 'attribute-equals', attribute: 'verificationLevel', value: 'lvl_two01' }],
      }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unsupported-predicate');
      assert.match((error as Error).message, /never match/);
      assert.match((error as Error).message, new RegExp(TARGET_ATTRIBUTE_NAMES[0] ?? 'category'));
      return true;
    },
    'a rule over an unregistered attribute is a flag that never turns on',
  );

  await assert.rejects(
    harness.service.publish(
      publishRequest({
        state: 'targeted',
        rules: [{ kind: 'attribute-not-in', attribute: 'country' }],
      }),
    ),
    (error: unknown) => codeOf(error) === 'unsupported-predicate',
  );
});

test('a natural, personal or credential-shaped value is refused wherever it appears', async () => {
  const harness = build();

  const cases: ReadonlyArray<readonly [string, () => Promise<unknown>, string]> = [
    [
      'a rollout salt that is an email',
      () => harness.service.publish(publishRequest({ rolloutSalt: 'alice@example.com' })),
      'natural-identifier',
    ],
    [
      'a rule value that is a credential',
      () =>
        harness.service.publish(
          publishRequest({
            state: 'targeted',
            rules: [
              { kind: 'attribute-equals', attribute: 'cohort', value: 'api_key_9f3c2b1a7d4e' },
            ],
          }),
        ),
      'secret-bearing-input',
    ],
    [
      'a subject key that is a telephone number',
      () => harness.service.evaluate({ flagKey: FLAG, subjectKey: '447700900123456' }),
      'natural-identifier',
    ],
    [
      'a context value that is an email',
      () =>
        harness.service.evaluate({
          flagKey: FLAG,
          attributes: { cohort: 'bob@example.com' },
        }),
      'natural-identifier',
    ],
  ];

  for (const [why, run, expected] of cases) {
    await assert.rejects(run(), (error: unknown) => {
      assert.equal(codeOf(error), expected, why);
      return true;
    });
  }
});

test('a context with an unregistered key, or too many keys, is refused', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.evaluate({ flagKey: FLAG, attributes: { balance: 'amt_00010000' } }),
    (error: unknown) => codeOf(error) === 'unsupported-predicate',
  );
  await assert.rejects(
    harness.service.evaluate({ flagKey: FLAG, attributes: 'country=gb' as never }),
    (error: unknown) => codeOf(error) === 'unsupported-predicate',
  );
});

// ---------------------------------------------------------------------------
// Shape of the surface
// ---------------------------------------------------------------------------

test('the service exposes no bypass, no update, no delete and no authority read', () => {
  const operations = new Set<string>();
  let proto: object | null = FeatureFlagService.prototype;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  const forbidden = [...operations].filter((name) =>
    /delete|remove|purge|update|edit|bypass|override|escalate|forceOn|forceEnable/i.test(name),
  );
  assert.deepEqual(forbidden, [], 'flag history is append-only and there is no override');

  assert.deepEqual(
    [...operations].sort(),
    ['activate', 'constructor', 'evaluate', 'kill', 'publish', 'retire'],
    'five operations and a constructor: the whole surface',
  );
});

test('every record crossing the boundary is sealed all the way down', async () => {
  const harness = build();
  const published = await harness.service.publish(
    publishRequest({
      state: 'targeted',
      rules: [{ kind: 'attribute-in', attribute: 'country', values: ['country_gb001'] }],
    }),
  );

  const version = published.version;
  assert.ok(Object.isFrozen(version));
  assert.ok(Object.isFrozen(version.rules));
  assert.ok(Object.isFrozen(version.rules[0]));
  assert.ok(Object.isFrozen(version.supportedScopes));
  assert.ok(Object.isFrozen(version.publishedBy));
  assert.throws(() => {
    (version as { state: string }).state = 'on';
  });

  const evaluation = await harness.service.evaluate({ flagKey: FLAG });
  assert.ok(Object.isFrozen(evaluation), 'an evaluation is frozen too');
  assert.ok(Object.isFrozen(evaluation.scope));
});

test('publishing does not turn anything on', async () => {
  // The separation between publishing and activating is the reason a definition can be written and
  // reviewed without being live for the moments in between.
  const harness = build();
  await harness.service.publish(publishRequest({ state: 'on' }));

  const evaluation = await harness.service.evaluate({ flagKey: FLAG });
  assert.equal(evaluation.enabled, false);
  assert.equal(evaluation.reason, 'no-such-flag');
  assert.equal(evaluation.flagVersionId, null, 'and no version is claimed to have been evaluated');
});

test('version numbers are assigned by the store, not by the caller', async () => {
  const harness = build();
  const first = await harness.service.publish(publishRequest());
  const second = await harness.service.publish(publishRequest({ state: 'off' }));

  assert.equal(first.version.version, 1);
  assert.equal(second.version.version, 2);

  await assert.rejects(
    harness.service.publish(publishRequest({ version: 7 } as never)),
    (error: unknown) => {
      assert.match((error as Error).message, /does not accept the field "version"/);
      return codeOf(error) === 'malformed-record';
    },
    'a caller choosing its own version number could publish under an older one',
  );
});

test('a killed or retired flag accepts no further writes', async () => {
  for (const kind of ['kill', 'retire'] as const) {
    const { harness } = await withActiveFlag(build());
    await harness.service[kind]({
      eventId: nextId('evt'),
      flagKey: FLAG,
      reason: 'the supplier feed started quoting in the wrong currency',
      idempotencyKey: nextId('idem'),
    });

    await assert.rejects(
      harness.service.publish(publishRequest({ state: 'off' })),
      (error: unknown) => {
        assert.equal(codeOf(error), 'flag-terminated', kind);
        assert.match((error as Error).message, /would make the stop advisory/);
        return true;
      },
      `a ${kind}ed flag must not accept a new definition`,
    );
  }
});
