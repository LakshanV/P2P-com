/**
 * K-02 Authentication — session secrets, expiry, rotation, revocation and replay (FND-004c).
 *
 * A session secret is the only thing in this repository worth stealing on its own: holding one *is*
 * being the subject, for as long as the session lives. So this suite is about the four ways that
 * goes wrong — the secret leaks, the session outlives its usefulness, a stale holder writes over a
 * fresh one, and an assertion is presented twice — and about the property that makes the first of
 * those survivable: **the secret exists in exactly one place, for exactly one moment.**
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthenticationError,
  REDACTED,
  REVOCATION_REASONS,
  SessionToken,
  TOKEN_HASH,
  hashToken,
  hashesEqual,
} from '../kernel/authentication/index.ts';

import {
  RepeatingEntropy,
  StubVerifier,
  authenticateRequest,
  bindRequest,
  build,
  signIn,
} from './helpers/authentication-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AuthenticationError ? error.code : undefined;

// ---------------------------------------------------------------------------
// The secret exists once
// ---------------------------------------------------------------------------

test('a session secret is revealed exactly once', async () => {
  const harness = build();
  await harness.service.bind(bindRequest());
  const result = await harness.service.authenticate(authenticateRequest());

  const secret = result.token.reveal();
  assert.match(secret, /^[A-Za-z0-9_-]{43,}$/);
  assert.equal(result.token.revealed, true);

  assert.throws(
    () => result.token.reveal(),
    (error: unknown) => {
      assert.equal(codeOf(error), 'invalid-token');
      assert.match((error as AuthenticationError).message, /would be holding it/i);
      return true;
    },
    'a component that could re-read the secret would, in effect, have stored it',
  );
});

test('a session secret cannot reach a log, a template or a JSON body by accident', () => {
  // The failure mode this guards is not `log(token.secret)` — nobody writes that. It is
  // `log({ result })`, which is what everybody writes.
  const token = new SessionToken('S'.repeat(43));

  assert.equal(String(token), REDACTED);
  assert.equal(`${token}`, REDACTED);
  assert.equal(token.toJSON(), REDACTED);
  assert.equal(JSON.stringify({ token }), `{"token":"${REDACTED}"}`);
  assert.equal(JSON.stringify(token), `"${REDACTED}"`);

  const inspected = (
    token as unknown as Record<symbol, () => string>
  )[Symbol.for('nodejs.util.inspect.custom')]();
  assert.equal(inspected, REDACTED, 'console.log and assertion diffs redact too');

  assert.ok(!JSON.stringify({ token }).includes('SSS'), 'no fragment of the secret survives');
});

test('nothing the service returns or stores contains the secret', async () => {
  const harness = build();
  await harness.service.bind(bindRequest());
  const result = await harness.service.authenticate(authenticateRequest());
  const secret = result.token.reveal();

  const serialisedResult = JSON.stringify({
    session: result.session,
    evidence: result.evidence,
  });
  assert.ok(!serialisedResult.includes(secret), 'the returned session carries no secret');

  const serialisedStore = JSON.stringify({
    sessions: harness.repository.sessions(),
    evidence: harness.repository.evidence(),
    bindings: harness.repository.bindings(),
  });
  assert.ok(!serialisedStore.includes(secret), 'and neither does anything stored');
  assert.match(result.session.tokenHash, TOKEN_HASH);
  assert.equal(result.session.tokenHash, hashToken(secret));
});

test('a refusal never echoes a presented secret', async () => {
  const harness = build();
  const { secret } = await signIn(harness);
  const wrong = `${secret.slice(0, -1)}Z`;

  await assert.rejects(harness.service.validate(wrong), (error: unknown) => {
    assert.equal(codeOf(error), 'invalid-token');
    assert.ok(!(error as Error).message.includes(wrong), 'the refusal repeated the presented value');
    assert.ok(!(error as Error).message.includes(secret));
    return true;
  });
});

test('an entropy source that degrades is refused rather than issuing a guessable session', async () => {
  for (const bad of ['short', '', 'has spaces in it and is long enough to be forty three chars']) {
    assert.throws(
      () => new SessionToken(bad),
      (error: unknown) => codeOf(error) === 'insufficient-entropy',
      `"${bad.slice(0, 12)}" must not become a session secret`,
    );
  }
});

test('an entropy source that repeats itself cannot issue a second session', async () => {
  // Two sessions with one secret means two parties holding one session. The uniqueness of the
  // hash is what makes a degraded source visible instead of catastrophic.
  const harness = build({ entropy: new RepeatingEntropy(), known: ['sub_01HQZXKNOWN0001'] });
  await harness.service.bind(bindRequest());
  await harness.service.authenticate(authenticateRequest());

  harness.verifier.answerWith({});
  await assert.rejects(
    harness.service.authenticate(authenticateRequest()),
    (error: unknown) => {
      assert.equal(codeOf(error), 'insufficient-entropy');
      assert.match((error as AuthenticationError).message, /repeating itself/i);
      return true;
    },
  );
  assert.equal(harness.repository.sessions().length, 1);
});

test('hashes compare in constant time and only as hashes', () => {
  const a = hashToken('A'.repeat(43));
  const b = hashToken('B'.repeat(43));

  assert.equal(hashesEqual(a, a), true);
  assert.equal(hashesEqual(a, b), false);
  assert.equal(hashesEqual(a, 'not-a-hash'), false, 'a malformed hash is never equal to anything');
  assert.equal(hashesEqual('', ''), false);
});

// ---------------------------------------------------------------------------
// Validation and expiry
// ---------------------------------------------------------------------------

test('a live session validates, and returns no secret', async () => {
  const harness = build();
  const { sessionId, secret } = await signIn(harness);

  const session = await harness.service.validate(secret);
  assert.equal(session.sessionId, sessionId);
  assert.ok(!JSON.stringify(session).includes(secret));
});

test('a secret that matches nothing is refused without saying which part was wrong', async () => {
  const harness = build();
  await signIn(harness);

  await assert.rejects(harness.service.validate('Z'.repeat(43)), (error: unknown) => {
    assert.equal(codeOf(error), 'invalid-token');
    // One refusal for "no such session" and "wrong secret". Distinguishing them tells an attacker
    // which session ids exist.
    assert.match((error as AuthenticationError).message, /does not match a live session/);
    return true;
  });

  for (const bad of ['', 'short', null, undefined, 12345]) {
    await assert.rejects(
      harness.service.validate(bad as unknown as string),
      (error: unknown) => codeOf(error) === 'invalid-token',
    );
  }
});

test('a session stops validating at its idle expiry', async () => {
  const harness = build({ sessionPolicy: { absoluteLifetimeSeconds: 3600, idleTimeoutSeconds: 60 } });
  const { secret } = await signIn(harness);

  harness.clock.set('2026-04-01T12:00:59Z');
  await harness.service.validate(secret);

  harness.clock.set('2026-04-01T12:01:00Z');
  await assert.rejects(harness.service.validate(secret), (error: unknown) => {
    assert.equal(codeOf(error), 'session-expired');
    assert.match((error as AuthenticationError).message, /idle expiry/i);
    return true;
  });
});

test('a session stops validating at its absolute expiry however often it is rotated', async () => {
  // The hard stop is what stops a session living for ever by being used.
  const harness = build({ sessionPolicy: { absoluteLifetimeSeconds: 120, idleTimeoutSeconds: 60 } });
  const { sessionId, secret: issued } = await signIn(harness);
  let secret = issued;

  harness.clock.set('2026-04-01T12:00:50Z');
  const first = await harness.service.rotate({ sessionId, presentedToken: secret });
  secret = first.token.reveal();
  assert.equal(first.session.absoluteExpiresAt, '2026-04-01T12:02:00Z', 'never moved');

  harness.clock.set('2026-04-01T12:01:40Z');
  const second = await harness.service.rotate({ sessionId, presentedToken: secret });
  secret = second.token.reveal();
  assert.equal(
    second.session.idleExpiresAt,
    '2026-04-01T12:02:00Z',
    'the idle window is capped at the absolute stop rather than reaching past it',
  );

  harness.clock.set('2026-04-01T12:02:00Z');
  await assert.rejects(harness.service.validate(secret), (error: unknown) => {
    assert.equal(codeOf(error), 'session-expired');
    assert.match((error as AuthenticationError).message, /absolute expiry/i);
    return true;
  });
});

test('validation is read-only: it does not extend the idle window', async () => {
  // "Idle" here means "not rotated", not "not read". A validation that wrote would make every
  // read a write, and the component says which operation keeps a session alive by naming it.
  const harness = build({ sessionPolicy: { absoluteLifetimeSeconds: 3600, idleTimeoutSeconds: 60 } });
  const { sessionId, secret } = await signIn(harness);
  const before = await harness.service.findSession(sessionId);

  harness.clock.set('2026-04-01T12:00:30Z');
  await harness.service.validate(secret);

  const after = await harness.service.findSession(sessionId);
  assert.deepEqual(after, before, 'validation changed stored state');
  assert.equal(harness.repository.sessions()[0]?.idleExpiresAt, '2026-04-01T12:01:00Z');
});

test('a session policy whose idle window exceeds its absolute lifetime is refused', () => {
  assert.throws(
    () => build({ sessionPolicy: { absoluteLifetimeSeconds: 60, idleTimeoutSeconds: 120 } }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as AuthenticationError).message, /would never apply/i);
      return true;
    },
  );

  for (const policy of [
    { absoluteLifetimeSeconds: 0, idleTimeoutSeconds: 0 },
    { absoluteLifetimeSeconds: -1, idleTimeoutSeconds: 1 },
    { absoluteLifetimeSeconds: 1.5, idleTimeoutSeconds: 1 },
  ]) {
    assert.throws(
      () => build({ sessionPolicy: policy }),
      (error: unknown) => codeOf(error) === 'malformed-record',
    );
  }
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test('rotation replaces the secret and invalidates the old one', async () => {
  const harness = build();
  const { sessionId, secret } = await signIn(harness);

  const rotated = await harness.service.rotate({ sessionId, presentedToken: secret });
  const next = rotated.token.reveal();

  assert.notEqual(next, secret);
  assert.equal(rotated.session.rotationCount, 1);
  assert.equal(rotated.session.tokenHash, hashToken(next));

  await harness.service.validate(next);
  await assert.rejects(
    harness.service.validate(secret),
    (error: unknown) => codeOf(error) === 'invalid-token',
    'the secret that was rotated away must stop working immediately',
  );
});

test('rotation never moves the absolute expiry', async () => {
  const harness = build();
  const { sessionId, secret } = await signIn(harness);
  const before = await harness.service.findSession(sessionId);

  harness.clock.set('2026-04-01T12:10:00Z');
  const rotated = await harness.service.rotate({ sessionId, presentedToken: secret });

  assert.equal(rotated.session.absoluteExpiresAt, before?.absoluteExpiresAt);
  assert.notEqual(rotated.session.idleExpiresAt, before?.idleExpiresAt);
  assert.equal(rotated.session.issuedAt, before?.issuedAt);
  assert.equal(rotated.session.subjectId, before?.subjectId);
  assert.equal(rotated.session.evidenceId, before?.evidenceId);
});

test('a stale rotation loses safely and never overwrites the winner', async () => {
  const harness = build();
  const { sessionId, secret } = await signIn(harness);

  const winner = await harness.service.rotate({ sessionId, presentedToken: secret });
  const winningSecret = winner.token.reveal();

  // A second caller still holding the original secret.
  await assert.rejects(
    harness.service.rotate({ sessionId, presentedToken: secret }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'invalid-token');
      assert.match((error as AuthenticationError).message, /may already have been rotated away/i);
      return true;
    },
  );

  const live = await harness.service.validate(winningSecret);
  assert.equal(live.rotationCount, 1, "the loser did not write over the winner's rotation");
  assert.equal(harness.repository.sessions()[0]?.tokenHash, hashToken(winningSecret));
});

test('an expired or revoked session cannot be rotated back into use', async () => {
  const expired = build({
    sessionPolicy: { absoluteLifetimeSeconds: 3600, idleTimeoutSeconds: 60 },
  });
  const first = await signIn(expired);
  expired.clock.set('2026-04-01T12:01:00Z');
  await assert.rejects(
    expired.service.rotate({ sessionId: first.sessionId, presentedToken: first.secret }),
    (error: unknown) => codeOf(error) === 'session-expired',
  );

  const revoked = build();
  const second = await signIn(revoked);
  await revoked.service.revoke({ sessionId: second.sessionId, reason: 'signed-out' });
  await assert.rejects(
    revoked.service.rotate({ sessionId: second.sessionId, presentedToken: second.secret }),
    (error: unknown) => codeOf(error) === 'session-revoked',
  );
});

test('rotating a session that does not exist is refused', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.rotate({ sessionId: 'sess_01HQZXNOSUCH1', presentedToken: 'A'.repeat(43) }),
    (error: unknown) => codeOf(error) === 'no-such-session',
  );
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

test('revocation ends a session immediately and records why', async () => {
  const harness = build();
  const { sessionId, secret } = await signIn(harness);

  const revoked = await harness.service.revoke({ sessionId, reason: 'operator-revoked' });
  assert.equal(revoked.revokedAt, '2026-04-01T12:00:00Z');
  assert.equal(revoked.revocationReason, 'operator-revoked');

  await assert.rejects(harness.service.validate(secret), (error: unknown) => {
    assert.equal(codeOf(error), 'session-revoked');
    assert.match((error as AuthenticationError).message, /operator-revoked/);
    return true;
  });
});

test('revoking twice converges on the first revocation rather than rewriting it', async () => {
  // Signing out twice is not an error, and the first revocation is the one that counts — a second
  // that overwrote the instant would move the record of when access actually ended.
  const harness = build();
  const { sessionId } = await signIn(harness);

  const first = await harness.service.revoke({ sessionId, reason: 'signed-out' });
  harness.clock.set('2026-04-01T12:05:00Z');
  const second = await harness.service.revoke({ sessionId, reason: 'operator-revoked' });

  assert.deepEqual(second, first, 'the second revocation changed nothing');
  assert.equal(second.revokedAt, '2026-04-01T12:00:00Z');
  assert.equal(second.revocationReason, 'signed-out');
});

test('an unknown revocation reason is refused', async () => {
  const harness = build();
  const { sessionId } = await signIn(harness);

  await assert.rejects(
    harness.service.revoke({ sessionId, reason: 'because-i-said-so' as never }),
    (error: unknown) => codeOf(error) === 'malformed-record',
  );
  assert.deepEqual([...REVOCATION_REASONS], [
    'signed-out',
    'rotated-out',
    'operator-revoked',
    'security-event',
  ]);
});

test('revoking a session that does not exist is refused', async () => {
  const harness = build();
  await assert.rejects(
    harness.service.revoke({ sessionId: 'sess_01HQZXNOSUCH1', reason: 'signed-out' }),
    (error: unknown) => codeOf(error) === 'no-such-session',
  );
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test('a verifier assertion authenticates exactly once', async () => {
  // The same assertion presented twice, under different idempotency keys, is a replay — whether
  // the second presentation is an attack or a confused client.
  const verifier = new StubVerifier({ override: { assertionId: 'asrt_01HQZXFIXED01' } });
  const harness = build({ verifier });
  await harness.service.bind(bindRequest());

  await harness.service.authenticate(authenticateRequest());
  await assert.rejects(harness.service.authenticate(authenticateRequest()), (error: unknown) => {
    assert.equal(codeOf(error), 'assertion-replayed');
    assert.match((error as AuthenticationError).message, /whether or not the presenter meant it/i);
    return true;
  });

  assert.equal(harness.repository.sessions().length, 1, 'no second session was issued');
  assert.equal(harness.repository.evidence().length, 1);
});

test('a genuine retry is recognised by its idempotency key, not refused as a replay', async () => {
  // The distinction that makes replay protection usable. A caller retrying after a timeout must
  // not be told it attacked the platform.
  const harness = build();
  await harness.service.bind(bindRequest());
  const request = authenticateRequest({
    evidenceId: 'evid_01HQZXRETRY01',
    sessionId: 'sess_01HQZXRETRY01',
    idempotencyKey: 'idem_01HQZXRETRY01',
  });

  const first = await harness.service.authenticate(request);
  const second = await harness.service.authenticate({ ...request });

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.session.sessionId, first.session.sessionId);
  assert.equal(harness.repository.sessions().length, 1);
  assert.equal(
    harness.verifier.challenges.length,
    1,
    'the retry did not re-present the proof, which would have been refused as a replay',
  );
});

test('a retry receives the session and never a second secret', async () => {
  const harness = build();
  await harness.service.bind(bindRequest());
  const request = authenticateRequest({ idempotencyKey: 'idem_01HQZXONCE001' });

  await harness.service.authenticate(request);
  const retry = await harness.service.authenticate({ ...request });

  assert.equal(retry.deduplicated, true);
  assert.throws(
    () => retry.token.reveal(),
    (error: unknown) => codeOf(error) === 'invalid-token',
    'a retry that received a fresh secret would mint a second live session for one authentication',
  );
});

test('a key reused for a different authentication fails closed', async () => {
  const harness = build();
  await harness.service.bind(bindRequest());
  const first = authenticateRequest({
    evidenceId: 'evid_01HQZXREUSE01',
    sessionId: 'sess_01HQZXREUSE01',
    idempotencyKey: 'idem_01HQZXREUSE01',
  });
  await harness.service.authenticate(first);

  for (const [why, mutation] of [
    ['a different evidence id', { evidenceId: 'evid_01HQZXOTHER01' }],
    ['a different session id', { sessionId: 'sess_01HQZXOTHER01' }],
  ] as const) {
    await assert.rejects(
      harness.service.authenticate({ ...first, ...mutation }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'idempotency-key-reuse', why);
        assert.match((error as AuthenticationError).message, /did not ask for/i);
        return true;
      },
      `${why} must not be returned as if it were the original`,
    );
  }
});
