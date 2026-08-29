/**
 * K-02 Authentication — MockVerifier tests.
 *
 * The mock verifier is a development/test adapter. These tests prove it behaves like a real verifier
 * (returns assertions, refuses invalid proofs, rejects provider mismatches) without ever touching an
 * external system.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthenticationService,
  InMemoryAuthenticationRepository,
  MockVerifier,
  ProviderRegistry,
  type ClockSupplier,
  type VerifierChallenge,
} from '../kernel/authentication/index.ts';
import { IdentityService, InMemoryIdentityRepository } from '../kernel/identity/index.ts';

const SUBJECT = 'sub_01HQZXMOCK0001';
const BINDING = 'bind_01HQZXMOCK0001';
const REFERENCE = 'ref_01HQZXMOCK0001';
const NOW_MS = new Date('2026-04-01T12:00:00.000Z').getTime();

const fixedClock: ClockSupplier = {
  now(): number {
    return NOW_MS;
  },
};

function challenge(proof: unknown, provider = 'mock'): VerifierChallenge {
  return {
    provider,
    providerReference: REFERENCE,
    proof,
  };
}

test('default MockVerifier accepts any non-empty string proof', async () => {
  const verifier = new MockVerifier({ clock: fixedClock });
  const assertion = await verifier.verify(challenge('any-proof'));

  assert.equal(assertion.provider, 'mock');
  assert.equal(assertion.providerReference, REFERENCE);
  assert.deepEqual(assertion.factors, ['knowledge']);
  assert.equal(assertion.assurance, 'single-factor');
  assert.equal(assertion.verifiedAt, '2026-04-01T12:00:00.000Z');
  assert.equal(assertion.expiresAt, '2026-04-01T12:05:00.000Z');
  assert.ok(assertion.assertionId.startsWith('asrt_mock_mock_ref_'));
});

test('MockVerifier refuses empty, null or undefined proofs', async () => {
  const verifier = new MockVerifier({ clock: fixedClock });

  for (const proof of ['', null, undefined]) {
    await assert.rejects(verifier.verify(challenge(proof)));
  }
});

test('MockVerifier refuses a challenge for a different provider', async () => {
  const verifier = new MockVerifier({ provider: 'mock-otp', clock: fixedClock });
  await assert.rejects(
    verifier.verify(challenge('any-proof', 'mock')),
    /MockVerifier for "mock-otp" was asked to verify a challenge for "mock"/,
  );
});

test('MockVerifier accepts a valid code from a fixed map', async () => {
  const verifier = new MockVerifier({
    provider: 'mock-otp',
    validCodes: { [REFERENCE]: '123456' },
    clock: fixedClock,
  });

  const assertion = await verifier.verify(challenge('123456', 'mock-otp'));
  assert.equal(assertion.provider, 'mock-otp');
  assert.equal(assertion.assurance, 'single-factor');
});

test('MockVerifier refuses an invalid code from a fixed map', async () => {
  const verifier = new MockVerifier({
    provider: 'mock-otp',
    validCodes: { [REFERENCE]: '123456' },
    clock: fixedClock,
  });

  await assert.rejects(verifier.verify(challenge('wrong-code', 'mock-otp')));
});

test('MockVerifier accepts a custom predicate', async () => {
  const verifier = new MockVerifier({
    isValidProof: (_reference, proof) => proof === 'open-sesame',
    factors: ['possession'],
    assurance: 'multi-factor',
    clock: fixedClock,
  });

  const assertion = await verifier.verify(challenge('open-sesame'));
  assert.deepEqual(assertion.factors, ['possession']);
  assert.equal(assertion.assurance, 'multi-factor');
  await assert.rejects(verifier.verify(challenge('open-sesame-please')));
});

test('MockVerifier rejects duplicate factors', () => {
  assert.throws(
    () =>
      new MockVerifier({
        factors: ['knowledge', 'knowledge'],
      }),
    /factors contain duplicates/,
  );
});

test('MockVerifier rejects unknown factors', () => {
  assert.throws(
    () =>
      new MockVerifier({
        factors: ['knowledge', 'magic' as 'possession'],
      }),
    /factor "magic" is not one of/,
  );
});

test('MockVerifier rejects unknown assurance', () => {
  assert.throws(
    () =>
      new MockVerifier({
        assurance: 'extreme' as 'multi-factor',
      }),
    /assurance "extreme" is not one of/,
  );
});

test('MockVerifier refuses both validCodes and isValidProof together', () => {
  assert.throws(
    () =>
      new MockVerifier({
        validCodes: { [REFERENCE]: '123456' },
        isValidProof: () => true,
      }),
    /either validCodes or isValidProof, not both/,
  );
});

test('assertion ids increment per provider reference pair', async () => {
  const verifier = new MockVerifier({ clock: fixedClock });

  const first = await verifier.verify(challenge('proof-1'));
  const second = await verifier.verify(challenge('proof-2'));
  assert.notEqual(first.assertionId, second.assertionId);
  assert.ok(second.assertionId.endsWith('_2'));
});

test('MockVerifier can authenticate a full K-02 flow', async () => {
  const identity = new IdentityService(new InMemoryIdentityRepository());
  await identity.create({
    subjectId: SUBJECT,
    kind: 'person',
    createdAt: '2026-04-01T12:00:00.000Z',
    origin: { kind: 'system', id: 'mock-test-system' },
    idempotencyKey: 'idem-mock-verifier-authn-flow',
  });

  const repository = new InMemoryAuthenticationRepository();
  const verifier = new MockVerifier({ clock: fixedClock });
  const service = new AuthenticationService({
    repository,
    providers: new ProviderRegistry([
      {
        provider: 'mock',
        description: 'A mock verifier used for local development and tests.',
      },
    ]),
    verifiers: [verifier],
    subjects: { exists: (id) => Promise.resolve(id === SUBJECT) },
    clock: { now: () => '2026-04-01T12:00:00.000Z' },
    entropy: {
      token(): string {
        return 'tok' + 'A'.repeat(40);
      },
    },
  });

  await service.bind({
    bindingId: BINDING,
    subjectId: SUBJECT,
    provider: 'mock',
    providerReference: REFERENCE,
    idempotencyKey: 'idem-mock-verifier-bind',
  });

  const session = await service.authenticate({
    evidenceId: 'evid_01HQZXMOCK0001',
    sessionId: 'sess_01HQZXMOCK0001',
    provider: 'mock',
    providerReference: REFERENCE,
    proof: 'mock-proof',
    idempotencyKey: 'idem-mock-verifier-auth',
  });

  assert.equal(session.session.subjectId, SUBJECT);
  assert.equal(session.session.assurance, 'single-factor');
  assert.deepEqual(session.session.factors, ['knowledge']);
});
