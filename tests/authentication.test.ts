/**
 * K-02 Authentication — the contract, the verifier boundary, and the MFA policy (FND-004c).
 *
 * One claim dominates this suite: **the caller does not decide.** Everything else K-02 does is
 * bookkeeping, and bookkeeping around a decision the caller made is not authentication. So the
 * tests are weighted towards the ways a caller might try to make the decision itself, and towards
 * the ways a verifier's answer might not be about the question that was asked.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ASSURANCE_LEVELS,
  ASSERTED_AUTHENTICATION_FIELDS,
  AuthenticationError,
  AuthenticationService,
  DEFAULT_MFA_POLICY,
  FACTOR_CATEGORIES,
  FOREIGN_FIELDS,
  IDENTITY_REFUSALS,
  InMemoryAuthenticationRepository,
  NO_SUBJECTS,
  ProviderRegistry,
  refusingVerifier,
  satisfiesPolicy,
  type AuthenticateRequest,
  type BindRequest,
} from '../kernel/authentication/index.ts';
import { IdentityService, InMemoryIdentityRepository } from '../kernel/identity/index.ts';

import {
  BINDING_REFERENCE,
  FixedClock,
  KNOWN_SUBJECT,
  PROVIDER,
  SequenceEntropy,
  StubSubjectLookup,
  StubVerifier,
  authenticateRequest,
  bindRequest,
  build,
} from './helpers/authentication-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AuthenticationError ? error.code : undefined;

// ---------------------------------------------------------------------------
// The caller does not decide
// ---------------------------------------------------------------------------

test('a request that asserts an authentication outcome is refused by name', async () => {
  // The security check of the whole component. Each of these is something only the verifier may
  // say, and a component that accepted one would be formatting its caller's opinion.
  const asserted: ReadonlyArray<readonly [string, unknown]> = [
    ['authenticated', true],
    ['isAuthenticated', true],
    ['verified', true],
    ['factors', ['knowledge', 'possession']],
    ['factorCategories', ['possession']],
    ['assurance', 'hardware-backed'],
    ['assuranceLevel', 'multi-factor'],
    ['mfaSatisfied', true],
    ['assertion', { assertionId: 'asrt_forged0001' }],
    ['assertionId', 'asrt_forged0001'],
    ['verifiedAt', '2026-04-01T12:00:00Z'],
    ['subjectVerified', true],
    ['trustLevel', 'high'],
    ['skipVerification', true],
    ['bypass', true],
  ];

  for (const [field, value] of asserted) {
    const { service, repository, verifier } = build();
    await service.bind(bindRequest());

    await assert.rejects(
      service.authenticate({ ...authenticateRequest(), [field]: value } as AuthenticateRequest),
      (error: unknown) => {
        assert.equal(
          codeOf(error),
          'caller-asserted-authentication',
          `"${field}" was accepted from the caller`,
        );
        assert.match((error as AuthenticationError).message, /verifier/i);
        return true;
      },
      `passing "${field}" must be refused, not ignored`,
    );

    assert.equal(verifier.challenges.length, 0, 'and the verifier was never even asked');
    assert.equal(repository.sessions().length, 0);
  }
});

test('every asserted-authentication field explains why the caller may not set it', () => {
  for (const [field, why] of Object.entries(ASSERTED_AUTHENTICATION_FIELDS)) {
    assert.ok(why.length > 25, `${field} needs a real explanation, not a label`);
    assert.match(
      why,
      /verifier|computed here|derived|no such thing/i,
      `${field} does not say who decides instead: "${why}"`,
    );
  }
});

test('a raw credential in a request is refused, and never reaches storage or an error', async () => {
  for (const field of ['password', 'passwordHash', 'secret', 'privateKey', 'otp', 'pin']) {
    const { service, repository } = build();
    await service.bind(bindRequest());

    await assert.rejects(
      service.authenticate({
        ...authenticateRequest(),
        [field]: 'hunter2-the-actual-secret',
      } as AuthenticateRequest),
      (error: unknown) => {
        assert.equal(codeOf(error), 'foreign-concern', field);
        assert.ok(
          !(error as Error).message.includes('hunter2-the-actual-secret'),
          `the refusal for "${field}" echoed the credential back into the error`,
        );
        return true;
      },
    );

    assert.equal(
      JSON.stringify(repository.sessions()).includes('hunter2'),
      false,
      'nothing about the credential reached the store',
    );
  }
});

test('a caller cannot choose a session secret', async () => {
  // The other half of "the caller does not decide". If `sessionToken` were accepted, anybody could
  // mint the session they wanted and then present it.
  for (const field of ['sessionToken', 'token', 'tokenHash']) {
    const { service } = build();
    await service.bind(bindRequest());

    await assert.rejects(
      service.authenticate({
        ...authenticateRequest(),
        [field]: 'a'.repeat(43),
      } as AuthenticateRequest),
      (error: unknown) => codeOf(error) === 'foreign-concern',
      `"${field}" must not be accepted`,
    );
  }
});

test('an unrecognised field is refused rather than silently dropped', async () => {
  const { service } = build();
  await service.bind(bindRequest());
  await assert.rejects(
    service.authenticate({ ...authenticateRequest(), nickname: 'ally' } as AuthenticateRequest),
    (error: unknown) => {
      assert.equal(codeOf(error), 'foreign-concern');
      assert.match((error as AuthenticationError).message, /silently dropped/i);
      return true;
    },
  );
});

test('fields owned by other components are refused with the owner named', async () => {
  for (const [field, expected] of [
    ['accountId', /K-03 Accounts/],
    ['roles', /K-04 Permissions/],
    ['permissions', /authentication is not authorisation/],
    ['capabilities', /Capability & Verification/],
    ['subjectKind', /K-01 Identity/],
    ['email', /personal data/],
    ['ipAddress', /personal data/],
  ] as const) {
    const { service } = build();
    await service.bind(bindRequest());
    await assert.rejects(
      service.authenticate({ ...authenticateRequest(), [field]: 'x' } as AuthenticateRequest),
      (error: unknown) => {
        assert.equal(codeOf(error), 'foreign-concern', field);
        assert.match((error as AuthenticationError).message, expected);
        return true;
      },
    );
  }

  for (const [field, why] of Object.entries(FOREIGN_FIELDS)) {
    assert.ok(why.length > 20, `${field} needs a real explanation`);
  }
});

// ---------------------------------------------------------------------------
// The verifier boundary
// ---------------------------------------------------------------------------

test('the happy path asks the verifier and records what it answered', async () => {
  const harness = build();
  await harness.service.bind(bindRequest());
  const result = await harness.service.authenticate(
    authenticateRequest({ evidenceId: 'evid_01HQZXHAPPY01', sessionId: 'sess_01HQZXHAPPY01' }),
  );

  assert.equal(harness.verifier.challenges.length, 1, 'the verifier was asked exactly once');
  assert.equal(harness.verifier.challenges[0]?.provider, PROVIDER);
  assert.equal(harness.verifier.challenges[0]?.providerReference, BINDING_REFERENCE);
  assert.deepEqual(harness.verifier.challenges[0]?.proof, { kind: 'opaque-proof-material' });

  assert.equal(result.deduplicated, false);
  assert.equal(result.evidence.subjectId, KNOWN_SUBJECT);
  assert.deepEqual([...result.evidence.factors], ['possession']);
  assert.equal(result.evidence.assurance, 'single-factor');
  assert.equal(result.session.subjectId, KNOWN_SUBJECT);
  assert.equal(result.session.rotationCount, 0);
  assert.equal(result.session.revokedAt, null);
});

test('an assertion about a different provider or reference is refused', async () => {
  for (const [why, override] of [
    ['a different provider', { provider: 'totp-app' }],
    ['a different reference', { providerReference: 'ref_01HQZXSOMEONE' }],
  ] as const) {
    const verifier = new StubVerifier({ override });
    const harness = build({ verifier });
    await harness.service.bind(bindRequest());

    await assert.rejects(
      harness.service.authenticate(authenticateRequest()),
      (error: unknown) => {
        assert.equal(codeOf(error), 'invalid-assertion', why);
        return true;
      },
      `an assertion for ${why} must not authenticate this binding`,
    );
    assert.equal(harness.repository.sessions().length, 0);
  }
});

test('an assertion past its own expiry is refused, judged by this platform’s clock', async () => {
  // A verifier with a slow clock must not be able to extend the life of its own assertions.
  const verifier = new StubVerifier({
    verifiedAt: '2026-04-01T11:00:00Z',
    expiresAt: '2026-04-01T11:05:00Z',
  });
  const harness = build({ verifier });
  await harness.service.bind(bindRequest());

  await assert.rejects(
    harness.service.authenticate(authenticateRequest()),
    (error: unknown) => {
      assert.equal(codeOf(error), 'assertion-expired');
      assert.match((error as AuthenticationError).message, /captured in transit/i);
      return true;
    },
  );
});

test('a nonsensical assertion is refused rather than interpreted', async () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['expiry before verification', { verifiedAt: '2026-04-01T12:00:00Z', expiresAt: '2026-04-01T11:00:00Z' }],
    ['a non-string verifiedAt', { verifiedAt: 12345 }],
    ['a null expiresAt', { expiresAt: null }],
  ];

  for (const [why, override] of cases) {
    const harness = build({ verifier: new StubVerifier({ override: override as never }) });
    await harness.service.bind(bindRequest());
    await assert.rejects(
      harness.service.authenticate(authenticateRequest()),
      (error: unknown) => {
        assert.ok(
          ['invalid-assertion', 'assertion-expired'].includes(String(codeOf(error))),
          `${why} got ${String(codeOf(error))}`,
        );
        return true;
      },
      `${why} must be refused`,
    );
  }
});

test('a verifier that refuses produces a refusal that repeats nothing it said', async () => {
  // A provider's error is exactly the kind of object that carries a fragment of the proof.
  const secretInError = new Error('bad password: hunter2 does not match stored hash abc123');
  const harness = build({ verifier: new StubVerifier({ refuseWith: secretInError }) });
  await harness.service.bind(bindRequest());

  await assert.rejects(harness.service.authenticate(authenticateRequest()), (error: unknown) => {
    assert.equal(codeOf(error), 'invalid-assertion');
    const message = (error as Error).message;
    assert.ok(!message.includes('hunter2'), 'the refusal repeated the credential');
    assert.ok(!message.includes('abc123'), 'the refusal repeated the stored hash');
    assert.match(message, /deliberately not repeated/i);
    return true;
  });
});

test('a registered provider with no verifier refuses rather than skipping verification', async () => {
  const repository = new InMemoryAuthenticationRepository();
  const providers = new ProviderRegistry([
    { provider: PROVIDER, description: 'A provider whose verifier was never wired in.' },
  ]);
  const service = new AuthenticationService({
    repository,
    providers,
    verifiers: [],
    subjects: new StubSubjectLookup(),
    clock: new FixedClock(),
    entropy: new SequenceEntropy(),
  });

  await service.bind(bindRequest());
  await assert.rejects(service.authenticate(authenticateRequest()), (error: unknown) => {
    assert.equal(codeOf(error), 'unknown-provider');
    assert.match((error as AuthenticationError).message, /treating an unverifiable proof/i);
    return true;
  });
});

test('the refusing verifier is what a missing provider adapter actually means', async () => {
  const harness = build({ verifiers: [refusingVerifier(PROVIDER)] });
  await harness.service.bind(bindRequest());
  await assert.rejects(
    harness.service.authenticate(authenticateRequest()),
    (error: unknown) => codeOf(error) === 'invalid-assertion',
  );
});

test('an unregistered provider is refused, and says nothing is registered when nothing is', async () => {
  const empty = new ProviderRegistry([]);
  assert.throws(
    () => empty.requireProvider('passkey'),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unknown-provider');
      assert.match((error as AuthenticationError).message, /None is registered/i);
      assert.match((error as AuthenticationError).message, /not a reason to skip verification/i);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// MFA policy
// ---------------------------------------------------------------------------

test('the policy counts distinct categories, so two of one factor is still one', () => {
  const policy = { minimumFactorCategories: 2, minimumAssurance: 'multi-factor' as const };
  assert.equal(satisfiesPolicy(['knowledge', 'possession'], 'multi-factor', policy), true);
  assert.equal(
    satisfiesPolicy(['knowledge', 'knowledge'], 'multi-factor', policy),
    false,
    'two passwords are not two factors',
  );
  assert.equal(satisfiesPolicy(['knowledge', 'possession'], 'single-factor', policy), false);
  assert.equal(satisfiesPolicy(['knowledge', 'possession'], 'hardware-backed', policy), true);
});

test('an authentication that does not meet the provider policy is refused', async () => {
  const verifier = new StubVerifier({ factors: ['knowledge'], assurance: 'single-factor' });
  const harness = build({
    verifier,
    policy: { minimumFactorCategories: 2, minimumAssurance: 'multi-factor' },
  });
  await harness.service.bind(bindRequest());

  await assert.rejects(harness.service.authenticate(authenticateRequest()), (error: unknown) => {
    assert.equal(codeOf(error), 'insufficient-factors');
    assert.match((error as AuthenticationError).message, /requires at least 2 factor categories/);
    assert.match((error as AuthenticationError).message, /confirmed 1 \(knowledge\) at single-factor/);
    return true;
  });
  assert.equal(harness.repository.sessions().length, 0, 'and no session was issued');
});

test('an authentication that meets a raised policy succeeds', async () => {
  const verifier = new StubVerifier({
    factors: ['knowledge', 'possession'],
    assurance: 'multi-factor',
  });
  const harness = build({
    verifier,
    policy: { minimumFactorCategories: 2, minimumAssurance: 'multi-factor' },
  });
  await harness.service.bind(bindRequest());

  const result = await harness.service.authenticate(authenticateRequest());
  assert.equal(result.session.assurance, 'multi-factor');
  assert.deepEqual([...result.session.factors], ['knowledge', 'possession']);
});

test('a provider may raise the platform floor and may never lower it', () => {
  const floor = { minimumFactorCategories: 2, minimumAssurance: 'multi-factor' as const };

  assert.doesNotThrow(
    () =>
      new ProviderRegistry(
        [
          {
            provider: 'hardware-key',
            description: 'Raises the floor to hardware-backed authentication.',
            policy: { minimumFactorCategories: 2, minimumAssurance: 'hardware-backed' },
          },
        ],
        floor,
      ),
  );

  for (const [why, policy] of [
    ['fewer categories', { minimumFactorCategories: 1, minimumAssurance: 'multi-factor' as const }],
    ['weaker assurance', { minimumFactorCategories: 2, minimumAssurance: 'single-factor' as const }],
  ] as const) {
    assert.throws(
      () =>
        new ProviderRegistry(
          [{ provider: 'weak-provider', description: `A provider declaring ${why}.`, policy }],
          floor,
        ),
      (error: unknown) => {
        assert.equal(codeOf(error), 'insufficient-factors', why);
        assert.match((error as AuthenticationError).message, /would make the floor advisory/i);
        return true;
      },
      `a provider declaring ${why} than the floor must be refused at construction`,
    );
  }
});

test('a nonsensical policy is refused at construction', () => {
  for (const policy of [
    { minimumFactorCategories: 0, minimumAssurance: 'single-factor' as const },
    { minimumFactorCategories: 4, minimumAssurance: 'single-factor' as const },
    { minimumFactorCategories: 1.5, minimumAssurance: 'single-factor' as const },
    { minimumFactorCategories: 1, minimumAssurance: 'very-sure' as never },
  ]) {
    assert.throws(
      () => new ProviderRegistry([], policy),
      (error: unknown) => codeOf(error) === 'insufficient-factors',
    );
  }

  assert.deepEqual(DEFAULT_MFA_POLICY, {
    minimumFactorCategories: 1,
    minimumAssurance: 'single-factor',
  });
});

test('the registries are closed and documented', () => {
  assert.deepEqual([...FACTOR_CATEGORIES], ['knowledge', 'possession', 'inherence']);
  assert.deepEqual([...ASSURANCE_LEVELS], ['single-factor', 'multi-factor', 'hardware-backed']);

  // Categories rather than mechanisms is what makes "multi-factor" mean anything.
  for (const mechanism of ['password', 'totp', 'sms', 'passkey', 'biometric', 'email']) {
    assert.ok(
      !(FACTOR_CATEGORIES as readonly string[]).includes(mechanism),
      `"${mechanism}" is a mechanism, not a category — K-02 must not learn how a proof works`,
    );
  }
});

// ---------------------------------------------------------------------------
// Bindings, subjects and identifiers
// ---------------------------------------------------------------------------

test('a binding for a subject K-01 does not know is refused before anything is written', async () => {
  const harness = build({ known: [] });
  await assert.rejects(
    harness.service.bind(bindRequest()),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unknown-subject');
      assert.match((error as AuthenticationError).message, /invent a party to authenticate/i);
      return true;
    },
  );
  assert.equal(harness.repository.bindings().length, 0);
  assert.equal(harness.repository.transactionsCommitted, 0);
});

test('authenticating against a reference nobody bound is refused', async () => {
  const harness = build();
  await assert.rejects(harness.service.authenticate(authenticateRequest()), (error: unknown) => {
    assert.equal(codeOf(error), 'unknown-binding');
    assert.match((error as AuthenticationError).message, /authenticate nobody in particular/i);
    return true;
  });
  assert.equal(harness.verifier.challenges.length, 0, 'the verifier was not troubled');
});

test('the default lookup fails closed', async () => {
  const service = new AuthenticationService({
    repository: new InMemoryAuthenticationRepository(),
    providers: new ProviderRegistry([
      { provider: PROVIDER, description: 'A provider used to check the fail-closed default.' },
    ]),
    verifiers: [new StubVerifier()],
    subjects: NO_SUBJECTS,
    clock: new FixedClock(),
    entropy: new SequenceEntropy(),
  });

  await assert.rejects(
    service.bind(bindRequest()),
    (error: unknown) => codeOf(error) === 'unknown-subject',
  );
});

test('the real K-01 service satisfies the lookup contract', async () => {
  const identity = new IdentityService(new InMemoryIdentityRepository());
  const service = new AuthenticationService({
    repository: new InMemoryAuthenticationRepository(),
    providers: new ProviderRegistry([
      { provider: PROVIDER, description: 'A provider used to check the real K-01 wiring.' },
    ]),
    verifiers: [new StubVerifier()],
    subjects: identity,
    clock: new FixedClock(),
    entropy: new SequenceEntropy(),
  });

  await assert.rejects(
    service.bind(bindRequest({ subjectId: 'sub_01HQZXREALK02A' })),
    (error: unknown) => codeOf(error) === 'unknown-subject',
  );

  await identity.create({
    subjectId: 'sub_01HQZXREALK02A',
    kind: 'person',
    createdAt: '2026-04-01T12:00:00Z',
    origin: { kind: 'human', id: 'ops-alice-console' },
    idempotencyKey: 'idem_01HQZXSUBJK02',
  });

  const bound = await service.bind(bindRequest({ subjectId: 'sub_01HQZXREALK02A' }));
  assert.equal(bound.binding.subjectId, 'sub_01HQZXREALK02A');
});

test('natural, PII-shaped and credential-shaped identifiers are refused on every field', async () => {
  const cases: ReadonlyArray<readonly [keyof BindRequest, string, string]> = [
    ['bindingId', 'alice@example.com', 'natural-identifier'],
    ['bindingId', 'alice.smith', 'natural-identifier'],
    ['bindingId', 'bind_1', 'malformed-identifier'],
    ['providerReference', 'alice@example.com', 'natural-identifier'],
    ['providerReference', '0771234567', 'natural-identifier'],
    ['providerReference', 'api_key_for_alice', 'secret-bearing-input'],
    ['idempotencyKey', 'passport-X1234567', 'natural-identifier'],
    ['subjectId', 'example.com', 'natural-identifier'],
  ];

  for (const [field, value, expected] of cases) {
    const harness = build({ known: [KNOWN_SUBJECT, value] });
    await assert.rejects(
      harness.service.bind(bindRequest({ [field]: value })),
      (error: unknown) => {
        assert.ok(error instanceof AuthenticationError, `${field}=${value} leaked a foreign error`);
        assert.equal(codeOf(error), expected, `${field}=${value}`);
        return true;
      },
    );
  }

  assert.deepEqual(Object.keys(IDENTITY_REFUSALS).sort(), [
    'malformed-identifier',
    'natural-identifier',
    'secret-bearing-input',
  ]);
});

test('one provider reference authenticates one subject', async () => {
  const harness = build({ known: [KNOWN_SUBJECT, 'sub_01HQZXOTHER001'] });
  await harness.service.bind(bindRequest({ bindingId: 'bind_01HQZXFIRST01' }));

  await assert.rejects(
    harness.service.bind(
      bindRequest({ bindingId: 'bind_01HQZXSECOND1', subjectId: 'sub_01HQZXOTHER001' }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'duplicate-binding');
      assert.match((error as AuthenticationError).message, /let two parties share a login/i);
      return true;
    },
  );
  assert.equal(harness.repository.bindings().length, 1);
});

test('the service exposes no bypass, no update and no delete', () => {
  const { service } = build();
  const operations = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(service) as object | null;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  operations.delete('constructor');

  assert.deepEqual(
    [...operations].sort(),
    ['authenticate', 'bind', 'bindingsForSubject', 'findSession', 'revoke', 'rotate', 'validate'],
    'anything else would be a way to reach a session without presenting its secret',
  );

  const dangerous = [...operations].filter((name) =>
    /bypass|impersonat|assume|elevate|force|unsafe|trust|delete|purge|updateSession|setAssurance/i.test(
      name,
    ),
  );
  assert.deepEqual(dangerous, []);
});
