/**
 * K-02's password verifier — the first thing in this repository that can authenticate a real person.
 *
 * Before this, K-02 shipped only `mock-verifier.ts`, which accepts any non-empty string, and the
 * contract said plainly that nobody could log in. That was the top deployment blocker in the
 * traceability audit.
 *
 * What is tested here is mostly what the verifier refuses to reveal.
 *
 * **A missing account must cost the same as a wrong password.** If an unknown reference returned
 * immediately and a known one spent time hashing, the response time would answer "does this account
 * exist?" for anyone who asked — a question worth answering to an attacker long before the password
 * is. The test measures it rather than trusting the comment.
 *
 * **A failure says nothing about which failure it was.** The message is identical for an unknown
 * reference, a wrong password and a malformed proof, because the difference is an enumeration oracle.
 *
 * **The password never appears anywhere.** Not in the store, not in an error, not in the assertion.
 *
 * And one property that is about the future rather than about attackers: **parameters travel with
 * the hash**, so raising the cost later does not invalidate a single existing credential, and the
 * upgrade happens at the one moment the password is known.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryPasswordCredentialStore,
  MINIMUM_PASSWORD_LENGTH,
  PRODUCTION_PARAMETERS,
  PasswordVerifier,
  TEST_ONLY_FAST_PARAMETERS,
  WeakPasswordError,
  hashPassword,
  needsRehash,
  parseStoredHash,
  resetDecoyForTests,
  verifyPassword,
  AuthenticationService,
  InMemoryAuthenticationRepository,
  ProviderRegistry,
} from '../kernel/authentication/index.ts';
import {
  BINDING_REFERENCE,
  FixedClock,
  KNOWN_SUBJECT,
  SequenceEntropy,
  StubSubjectLookup,
} from './helpers/authentication-fixtures.ts';

const REFERENCE = 'pref_01HR0PWDsubject1';
const PASSWORD = 'correct horse battery staple';
const NOW = '2026-07-01T09:00:00.000000Z';

function build(overrides: { onRehash?: (reference: string) => void } = {}): {
  verifier: PasswordVerifier;
  store: InMemoryPasswordCredentialStore;
} {
  resetDecoyForTests();
  const store = new InMemoryPasswordCredentialStore();
  let assertions = 0;
  const verifier = new PasswordVerifier({
    store,
    now: () => NOW,
    newAssertionId: () => `asr_01HR0PWD${String((assertions += 1)).padStart(6, '0')}`,
    // Cheap on purpose. A suite at production cost takes minutes and gets deleted by somebody in a
    // hurry, which is a worse outcome than a fast suite that says it is fast.
    parameters: TEST_ONLY_FAST_PARAMETERS,
    ...(overrides.onRehash === undefined ? {} : { onRehash: overrides.onRehash }),
  });
  return { verifier, store };
}

const challenge = (reference: string, proof: unknown) => ({
  provider: 'password',
  providerReference: reference,
  proof,
});

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

test('a hash reveals nothing about the password', async () => {
  const stored = await hashPassword(PASSWORD, TEST_ONLY_FAST_PARAMETERS);

  assert.ok(!stored.includes(PASSWORD));
  assert.ok(!stored.includes('correct'));
  assert.ok(!stored.toLowerCase().includes('horse'));
  assert.match(stored, /^scrypt\$N=\d+,r=\d+,p=\d+,len=\d+\$[\w-]+\$[\w-]+$/);
});

test('the same password hashes differently every time', async () => {
  const first = await hashPassword(PASSWORD, TEST_ONLY_FAST_PARAMETERS);
  const second = await hashPassword(PASSWORD, TEST_ONLY_FAST_PARAMETERS);

  assert.notEqual(
    first,
    second,
    'a shared salt would let one rainbow table cover every account at once',
  );
  assert.ok(await verifyPassword(PASSWORD, first));
  assert.ok(await verifyPassword(PASSWORD, second));
});

test('a hash carries the parameters that made it', async () => {
  const stored = await hashPassword(PASSWORD, TEST_ONLY_FAST_PARAMETERS);
  const parsed = parseStoredHash(stored);

  assert.equal(parsed?.parameters.n, TEST_ONLY_FAST_PARAMETERS.n);
  assert.equal(parsed?.parameters.r, TEST_ONLY_FAST_PARAMETERS.r);
  assert.equal(parsed?.parameters.keyLength, 32);
  assert.equal(parsed?.salt.length, 16);
});

test('a hash made with weak parameters still verifies under its own', async () => {
  // The point of storing the parameters: raising the cost must not invalidate existing credentials.
  const stored = await hashPassword(PASSWORD, TEST_ONLY_FAST_PARAMETERS);

  assert.ok(
    await verifyPassword(PASSWORD, stored),
    'an old credential must keep working after the deployment raises its cost',
  );
  assert.equal(
    needsRehash(stored, PRODUCTION_PARAMETERS),
    true,
    'and it must be recognisable as due for an upgrade',
  );
  assert.equal(needsRehash(stored, TEST_ONLY_FAST_PARAMETERS), false);
});

test('a wrong password does not verify', async () => {
  const stored = await hashPassword(PASSWORD, TEST_ONLY_FAST_PARAMETERS);

  assert.equal(await verifyPassword('correct horse battery stapl', stored), false);
  assert.equal(await verifyPassword('', stored), false);
  assert.equal(await verifyPassword(`${PASSWORD} `, stored), false);
});

test('a corrupt stored hash is a failed authentication, not a crash', async () => {
  for (const corrupt of [
    '',
    'nonsense',
    'scrypt$$$',
    'bcrypt$x$y$z',
    'scrypt$N=0,r=8,p=1,len=32$a$b',
  ]) {
    assert.equal(
      await verifyPassword(PASSWORD, corrupt),
      false,
      `"${corrupt}" should refuse rather than throw; a caller that could tell the difference would ` +
        'have learned something about the row',
    );
  }
});

test('a password is normalised, so the same characters match however they were typed', async () => {
  // "é" as one code point and as "e" plus a combining accent are the same password to the person
  // who typed it, and their keyboard decides which one arrives.
  const composed = 'café passphrase ok';
  const decomposed = 'café passphrase ok';
  const stored = await hashPassword(composed, TEST_ONLY_FAST_PARAMETERS);

  assert.equal(await verifyPassword(decomposed, stored), true);
});

test('a password below the floor is refused, with the reason', async () => {
  await assert.rejects(
    () => hashPassword('short', TEST_ONLY_FAST_PARAMETERS),
    (error: unknown) => {
      assert.ok(error instanceof WeakPasswordError);
      assert.match(error.message, /composition rules push people towards predictable/);
      return true;
    },
  );
  await assert.rejects(() => hashPassword('x'.repeat(257), TEST_ONLY_FAST_PARAMETERS));
  // Exactly at the floor is acceptable.
  assert.ok(await hashPassword('x'.repeat(MINIMUM_PASSWORD_LENGTH), TEST_ONLY_FAST_PARAMETERS));
});

test('length is counted in characters, not UTF-16 units', async () => {
  // Twelve emoji is twelve characters to the person who typed them and twenty-four UTF-16 units.
  // A rule that counted units would behave differently by alphabet.
  const twelveEmoji = '🙂'.repeat(12);
  assert.ok(await hashPassword(twelveEmoji, TEST_ONLY_FAST_PARAMETERS));
  await assert.rejects(() => hashPassword('🙂'.repeat(11), TEST_ONLY_FAST_PARAMETERS));
});

// ---------------------------------------------------------------------------
// The verifier
// ---------------------------------------------------------------------------

test('a correct password produces a single-factor knowledge assertion', async () => {
  const { verifier } = build();
  await verifier.setPassword(REFERENCE, PASSWORD);

  const assertion = await verifier.verify(challenge(REFERENCE, PASSWORD));

  assert.equal(assertion.provider, 'password');
  assert.equal(assertion.providerReference, REFERENCE);
  assert.deepEqual(
    [...assertion.factors],
    ['knowledge'],
    'a password is one thing you know, and claiming more would defeat K-02’s MFA floor',
  );
  assert.equal(assertion.assurance, 'single-factor');
  assert.equal(assertion.verifiedAt, NOW);
  assert.equal(assertion.expiresAt, '2026-07-01T09:02:00.000000Z');
});

test('the stored credential does not contain the password', async () => {
  const { verifier, store } = build();
  await verifier.setPassword(REFERENCE, PASSWORD);

  const credential = await store.find(REFERENCE);
  assert.ok(credential !== null);
  assert.ok(!credential.storedHash.includes(PASSWORD));
  assert.ok(!JSON.stringify(credential).includes('battery'));
});

test('a wrong password is refused', async () => {
  const { verifier } = build();
  await verifier.setPassword(REFERENCE, PASSWORD);

  await assert.rejects(() => verifier.verify(challenge(REFERENCE, 'wrong password entirely')));
});

test('an unknown account and a wrong password fail identically', async () => {
  const { verifier } = build();
  await verifier.setPassword(REFERENCE, PASSWORD);

  const messages: string[] = [];
  for (const attempt of [
    challenge('pref_01HR0PWDnobody01', PASSWORD),
    challenge(REFERENCE, 'the wrong password'),
    challenge(REFERENCE, 12345),
    challenge(REFERENCE, null),
  ]) {
    try {
      await verifier.verify(attempt);
      assert.fail('should have been refused');
    } catch (error) {
      messages.push(error instanceof Error ? error.message : String(error));
    }
  }

  assert.equal(
    new Set(messages).size,
    1,
    'the difference between "no such account" and "wrong password" is an enumeration oracle, and ' +
      `these produced ${String(new Set(messages).size)} distinct messages: ${[...new Set(messages)].join(' | ')}`,
  );
  assert.equal(messages[0], 'verification failed');
});

test('an unknown account costs about as much as a known one', async () => {
  // The property this test exists for: without the decoy hash, an unknown reference returns in
  // microseconds and a known one spends milliseconds, and the response time answers "does this
  // account exist?" for anybody who asks.
  const { verifier } = build();
  await verifier.setPassword(REFERENCE, PASSWORD);

  const time = async (reference: string): Promise<number> => {
    const started = process.hrtime.bigint();
    try {
      await verifier.verify(challenge(reference, 'a wrong password of some length'));
    } catch {
      // Expected.
    }
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  // Warm the decoy and the JIT, so the measurement is of hashing rather than of first-call overhead.
  await time('pref_01HR0PWDwarmup1');
  await time(REFERENCE);

  const unknown: number[] = [];
  const known: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    unknown.push(await time(`pref_01HR0PWDghost${String(round)}`));
    known.push(await time(REFERENCE));
  }

  const median = (values: number[]): number =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

  const unknownMedian = median(unknown);
  const knownMedian = median(known);
  const ratio = unknownMedian / Math.max(knownMedian, 0.001);

  assert.ok(
    ratio > 0.2 && ratio < 5,
    'an unknown reference must cost roughly what a known one costs. Measured ' +
      `${unknownMedian.toFixed(2)}ms against ${knownMedian.toFixed(2)}ms (ratio ${ratio.toFixed(2)}). ` +
      'A large gap either way is a timing oracle for account existence',
  );
});

test('a credential hashed with weaker parameters is upgraded on the next successful login', async () => {
  const upgraded: string[] = [];
  const store = new InMemoryPasswordCredentialStore();
  resetDecoyForTests();

  // Enrolled under weak parameters, as an older deployment would have.
  await store.put({
    providerReference: REFERENCE,
    storedHash: await hashPassword(PASSWORD, { n: 256, r: 8, p: 1, keyLength: 32 }),
    updatedAt: NOW,
  });

  const verifier = new PasswordVerifier({
    store,
    now: () => NOW,
    newAssertionId: () => 'asr_01HR0PWDrehash1',
    parameters: TEST_ONLY_FAST_PARAMETERS,
    onRehash: (reference) => upgraded.push(reference),
  });

  const before = await store.find(REFERENCE);
  await verifier.verify(challenge(REFERENCE, PASSWORD));
  const after = await store.find(REFERENCE);

  assert.deepEqual(upgraded, [REFERENCE]);
  assert.notEqual(before?.storedHash, after?.storedHash);
  assert.equal(
    needsRehash(String(after?.storedHash), TEST_ONLY_FAST_PARAMETERS),
    false,
    'the one moment a password can be rehashed is the moment it is known',
  );
  assert.ok(
    await verifier.verify(challenge(REFERENCE, PASSWORD)),
    'and the password still works afterwards',
  );
});

test('a verifier refuses a challenge for a provider it does not serve', async () => {
  const { verifier } = build();
  await verifier.setPassword(REFERENCE, PASSWORD);

  await assert.rejects(
    () => verifier.verify({ provider: 'oidc', providerReference: REFERENCE, proof: PASSWORD }),
    /does not serve/,
  );
});

test('changing a password invalidates the old one', async () => {
  const { verifier } = build();
  await verifier.setPassword(REFERENCE, PASSWORD);
  await verifier.setPassword(REFERENCE, 'a different passphrase entirely');

  await assert.rejects(() => verifier.verify(challenge(REFERENCE, PASSWORD)));
  assert.ok(await verifier.verify(challenge(REFERENCE, 'a different passphrase entirely')));
});

test('two accounts with the same password have different hashes', async () => {
  const { verifier, store } = build();
  await verifier.setPassword(REFERENCE, PASSWORD);
  await verifier.setPassword('pref_01HR0PWDsubject2', PASSWORD);

  const first = await store.find(REFERENCE);
  const second = await store.find('pref_01HR0PWDsubject2');

  assert.notEqual(
    first?.storedHash,
    second?.storedHash,
    'otherwise one cracked hash would reveal every account that shared the password',
  );
  assert.deepEqual(store.references(), ['pref_01HR0PWDsubject1', 'pref_01HR0PWDsubject2']);
});

test('the production parameters are the ones OWASP recommends for interactive login', () => {
  // Pinned deliberately: a later change to these is a security decision and should have to edit a
  // test that says so.
  assert.equal(PRODUCTION_PARAMETERS.n, 131_072, 'N = 2^17');
  assert.equal(PRODUCTION_PARAMETERS.r, 8);
  assert.equal(PRODUCTION_PARAMETERS.p, 1);
  assert.equal(PRODUCTION_PARAMETERS.keyLength, 32);
  assert.ok(
    TEST_ONLY_FAST_PARAMETERS.n < PRODUCTION_PARAMETERS.n,
    'the test profile must be cheaper, and must be named so it cannot be chosen by accident',
  );
});

// ---------------------------------------------------------------------------
// The claim this slice exists to make true
// ---------------------------------------------------------------------------

test('a person with a password can sign in through the real K-02 service', async () => {
  // Everything above tests the verifier in isolation. This wires it into the actual
  // AuthenticationService and signs somebody in: a binding, a verified proof, a session and a token
  // that can be presented. Until this test existed, K-02's contract said plainly that nobody could
  // log in, and it was the top deployment blocker in the traceability audit.
  const store = new InMemoryPasswordCredentialStore();
  resetDecoyForTests();

  let assertions = 0;
  const verifier = new PasswordVerifier({
    store,
    now: () => clock.now(),
    newAssertionId: () => `asr_01HR0PWDsvc${String((assertions += 1)).padStart(5, '0')}`,
    parameters: TEST_ONLY_FAST_PARAMETERS,
  });

  const clock = new FixedClock();
  const subjects = new StubSubjectLookup();
  const service = new AuthenticationService({
    repository: new InMemoryAuthenticationRepository(),
    providers: new ProviderRegistry([
      {
        provider: 'password',
        description: 'A password verified with scrypt. One factor: something you know.',
      },
    ]),
    verifiers: [verifier],
    subjects,
    clock,
    entropy: new SequenceEntropy(),
  });

  await verifier.setPassword(BINDING_REFERENCE, PASSWORD);

  await service.bind({
    bindingId: 'bnd_01HR0PWDbinding1',
    subjectId: KNOWN_SUBJECT,
    provider: 'password',
    providerReference: BINDING_REFERENCE,
    idempotencyKey: 'idem_pwd_bind_0001',
  });

  const result = await service.authenticate({
    evidenceId: 'evd_01HR0PWDevid0001',
    sessionId: 'ses_01HR0PWDsess0001',
    provider: 'password',
    providerReference: BINDING_REFERENCE,
    proof: PASSWORD,
    idempotencyKey: 'idem_pwd_auth_0001',
  });

  assert.equal(result.session.subjectId, KNOWN_SUBJECT);
  assert.equal(result.evidence.assurance, 'single-factor');

  // The token is presented once and validates against the session.
  const presented = result.token.reveal();
  const validated = await service.validate(presented);
  assert.equal(validated.sessionId, 'ses_01HR0PWDsess0001');

  // And the wrong password does not get a session.
  await assert.rejects(() =>
    service.authenticate({
      evidenceId: 'evd_01HR0PWDevid0002',
      sessionId: 'ses_01HR0PWDsess0002',
      provider: 'password',
      providerReference: BINDING_REFERENCE,
      proof: 'not the password',
      idempotencyKey: 'idem_pwd_auth_0002',
    }),
  );
});
