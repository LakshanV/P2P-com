/**
 * K-02 Authentication — overlapping transactions (FND-004c).
 *
 * Every other suite here tests one caller at a time. This one tests two, because the guarantee a
 * session lifecycle actually has to make is about the moment two callers act on the same session
 * at once: **one of them wins, the other is told it lost, and the loser writes nothing.**
 *
 * The failure this suite exists to prevent is subtler than a lost update. A guarded update is
 * evaluated twice — once against the snapshot the transaction read, and once against the store as
 * it stands at commit — and the caller is handed the *first* answer. If the second evaluation
 * merely skipped the write, a rotation could be told `true`, hand its caller a freshly minted
 * secret, and have that secret silently dropped: the caller believes it holds a live session, the
 * store still holds the winner's secret, and nothing anywhere raised an error. A token that
 * authenticates nothing is not a small bug in an authentication component — it is the component
 * lying about the one thing it exists to say.
 *
 * So the losing transaction is refused in full, at commit, with `stale-session-state`.
 *
 * Overlap here is arranged, not hoped for: a latch holds one transaction open in the window
 * between "the body finished" and "the commit ran", and the test opens it by hand once the other
 * transaction has committed. Two transactions that merely start close together prove nothing,
 * because nothing in the runtime promises they interleave at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthenticationError,
  AuthenticationService,
  InMemoryAuthenticationRepository,
  ProviderRegistry,
  hashToken,
  type AuthenticationRepository,
  type AuthenticationSession,
  type AuthenticationTransaction,
  type EntropySource,
  type RotationCommand,
} from '../kernel/authentication/index.ts';

import {
  FixedClock,
  PROVIDER,
  StubSubjectLookup,
  StubVerifier,
  authenticateRequest,
  bindRequest,
} from './helpers/authentication-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AuthenticationError ? error.code : undefined;

// ---------------------------------------------------------------------------
// Arranging the overlap
// ---------------------------------------------------------------------------

/** A promise the test opens by hand, so "these two transactions overlapped" is a fact. */
class Latch {
  readonly opened: Promise<void>;
  readonly open: () => void;

  constructor() {
    let release: () => void = () => undefined;
    this.opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.open = (): void => {
      release();
    };
  }
}

/**
 * The real in-memory repository, with one hook: a transaction can be held open after its body has
 * finished and before it commits.
 *
 * That window is exactly where the race lives — the caller has been told its rotation succeeded,
 * and the store has not been touched yet — so a regression about what happens there needs to be
 * able to stop time inside it. Nothing else is changed: every read, every write, every uniqueness
 * check and the commit itself are the repository's own, which is the point. A fake repository
 * would prove something about the fake.
 */
class GatedRepository implements AuthenticationRepository {
  readonly store = new InMemoryAuthenticationRepository();
  #gate: (result: unknown) => Promise<void> = () => Promise.resolve();

  /** Called with each transaction's result, after its body and before its commit. */
  gateWith(gate: (result: unknown) => Promise<void>): void {
    this.#gate = gate;
  }

  withTransaction<T>(body: (tx: AuthenticationTransaction) => Promise<T>): Promise<T> {
    return this.store.withTransaction(async (tx) => {
      const result = await body(tx);
      await this.#gate(result);
      return result;
    });
  }
}

/**
 * Hold the first transaction that performs a guarded update open until `latch` is opened.
 *
 * The service's guarded writes are the transactions whose body reports the boolean `rotateSession`
 * or `revokeSession` answered with; its reads return a session, a binding or null. So "the first
 * boolean" is the first guarded write to reach a commit, whichever operation issued it — which is
 * what makes this work for rotation against rotation and rotation against revocation alike.
 */
function holdFirstGuardedWrite(repository: GatedRepository, latch: Latch): void {
  let writes = 0;
  repository.gateWith(async (result) => {
    if (typeof result !== 'boolean') return;
    writes += 1;
    if (writes === 1) await latch.opened;
  });
}

/** Predictable secrets, kept — so a test can present the secret a *losing* rotation was handed. */
class RecordingEntropy implements EntropySource {
  readonly secrets: string[] = [];

  token(): string {
    const suffix = String(this.secrets.length + 1).padStart(4, '0');
    const secret = `tok${'A'.repeat(39)}${suffix}`;
    this.secrets.push(secret);
    return secret;
  }
}

interface Overlap {
  readonly service: AuthenticationService;
  readonly repository: GatedRepository;
  readonly entropy: RecordingEntropy;
}

/** The service, wired to a repository whose commits a test can hold open. */
function overlapping(): Overlap {
  const repository = new GatedRepository();
  const entropy = new RecordingEntropy();
  const service = new AuthenticationService({
    repository,
    providers: new ProviderRegistry([
      {
        provider: PROVIDER,
        description: 'A stub provider used by the K-02 suites; verifies nothing in production.',
      },
    ]),
    verifiers: [new StubVerifier()],
    subjects: new StubSubjectLookup(),
    clock: new FixedClock(),
    entropy,
  });
  return { service, repository, entropy };
}

async function signIn(harness: Overlap): Promise<{ sessionId: string; secret: string }> {
  await harness.service.bind(bindRequest());
  const result = await harness.service.authenticate(authenticateRequest());
  return { sessionId: result.session.sessionId, secret: result.token.reveal() };
}

// ---------------------------------------------------------------------------
// The port, directly
// ---------------------------------------------------------------------------

const ORIGINAL_HASH = 'a'.repeat(64);
const WINNING_HASH = 'b'.repeat(64);
const LOSING_HASH = 'c'.repeat(64);

/** No secret appears in these cases at all: the port stores hashes, so the tests speak in hashes. */
function seededSession(): AuthenticationSession {
  return {
    sessionId: 'sess_01HQZXOVERLAP1',
    bindingId: 'bind_01HQZXOVERLAP1',
    subjectId: 'sub_01HQZXOVERLAP1',
    evidenceId: 'evid_01HQZXOVERLAP1',
    assurance: 'single-factor',
    factors: ['possession'],
    tokenHash: ORIGINAL_HASH,
    issuedAt: '2026-04-01T12:00:00Z',
    absoluteExpiresAt: '2026-04-02T00:00:00Z',
    idleExpiresAt: '2026-04-01T12:30:00Z',
    rotationCount: 0,
    revokedAt: null,
    revocationReason: null,
    idempotencyKey: 'idem_01HQZXOVERLAP1',
  };
}

function rotationTo(nextTokenHash: string): RotationCommand {
  return {
    sessionId: 'sess_01HQZXOVERLAP1',
    expectedTokenHash: ORIGINAL_HASH,
    nextTokenHash,
    nextIdleExpiresAt: '2026-04-01T12:30:00Z',
    nextRotationCount: 1,
  };
}

test('a rotation that loses an overlapping transaction is refused, not silently dropped', async () => {
  const repository = new InMemoryAuthenticationRepository();
  repository.seed({ sessions: [seededSession()] });

  const queued = new Latch();
  const held = new Latch();

  // The loser reads the original hash, is told its rotation succeeded, and is then held open.
  const losing = repository.withTransaction(async (tx) => {
    const answered = await tx.rotateSession(rotationTo(LOSING_HASH));
    queued.open();
    await held.opened;
    return answered;
  });
  await queued.opened;

  // The winner rotates the same session from the same expected hash, and commits.
  const answeredWinner = await repository.withTransaction((tx) =>
    tx.rotateSession(rotationTo(WINNING_HASH)),
  );
  assert.equal(answeredWinner, true);

  held.open();
  await assert.rejects(
    losing,
    (error: unknown) => {
      assert.equal(codeOf(error), 'stale-session-state');
      assert.match(
        (error as AuthenticationError).message,
        /refused in full|nothing it wrote/i,
        'the refusal must say the transaction was abandoned, not that a write was skipped',
      );
      return true;
    },
    'the loser was told `true` inside its transaction; the commit is the last chance to correct it',
  );

  const [session] = repository.sessions();
  assert.equal(session?.tokenHash, WINNING_HASH, 'the winner’s secret is the live one');
  assert.equal(session?.rotationCount, 1, 'the loser did not stack a second rotation on top');
  assert.equal(repository.transactionsCommitted, 1);
  assert.equal(repository.transactionsRolledBack, 1, 'a refused commit is a rollback');
});

test('a transaction refused at commit leaves no partial writes behind', async () => {
  const repository = new InMemoryAuthenticationRepository();
  repository.seed({ sessions: [seededSession()] });

  const queued = new Latch();
  const held = new Latch();

  // Inserts *and* a guarded update in one transaction. The inserts conflict with nothing and would
  // commit happily on their own, which is the point: they must still be discarded, because they
  // are half of a decision whose other half lost.
  const losing = repository.withTransaction(async (tx) => {
    await tx.insertBinding({
      bindingId: 'bind_01HQZXPARTIAL1',
      subjectId: 'sub_01HQZXPARTIAL1',
      provider: PROVIDER,
      providerReference: 'ref_01HQZXPARTIAL1',
      createdAt: '2026-04-01T12:00:00Z',
      idempotencyKey: 'idem_01HQZXPARTIAL1',
    });
    await tx.insertEvidence({
      evidenceId: 'evid_01HQZXPARTIAL1',
      bindingId: 'bind_01HQZXPARTIAL1',
      subjectId: 'sub_01HQZXPARTIAL1',
      provider: PROVIDER,
      assertionId: 'asrt_01HQZXPARTIAL1',
      factors: ['possession'],
      assurance: 'single-factor',
      verifiedAt: '2026-04-01T11:59:30Z',
      recordedAt: '2026-04-01T12:00:00Z',
      idempotencyKey: 'idem_01HQZXPARTIAL2',
    });
    await tx.insertSession({
      ...seededSession(),
      sessionId: 'sess_01HQZXPARTIAL1',
      tokenHash: 'd'.repeat(64),
      idempotencyKey: 'idem_01HQZXPARTIAL3',
    });
    await tx.rotateSession(rotationTo(LOSING_HASH));
    queued.open();
    await held.opened;
  });
  await queued.opened;

  await repository.withTransaction((tx) => tx.rotateSession(rotationTo(WINNING_HASH)));

  held.open();
  await assert.rejects(losing, (error: unknown) => codeOf(error) === 'stale-session-state');

  assert.deepEqual(repository.bindings(), [], 'the binding belonged to the refused transaction');
  assert.deepEqual(repository.evidence(), [], 'the evidence belonged to the refused transaction');
  assert.deepEqual(
    repository.sessions().map((session) => session.sessionId),
    ['sess_01HQZXOVERLAP1'],
    'the inserted session belonged to the refused transaction too',
  );
  assert.equal(repository.sessions()[0]?.tokenHash, WINNING_HASH);
});

test('a rotation and a revocation racing at the port leave one outcome, not half of each', async () => {
  const repository = new InMemoryAuthenticationRepository();
  repository.seed({ sessions: [seededSession()] });

  const queued = new Latch();
  const held = new Latch();

  const losingRotation = repository.withTransaction(async (tx) => {
    const answered = await tx.rotateSession(rotationTo(LOSING_HASH));
    queued.open();
    await held.opened;
    return answered;
  });
  await queued.opened;

  await repository.withTransaction((tx) =>
    tx.revokeSession({
      sessionId: 'sess_01HQZXOVERLAP1',
      revokedAt: '2026-04-01T12:05:00Z',
      reason: 'security-event',
    }),
  );

  held.open();
  await assert.rejects(losingRotation, (error: unknown) => codeOf(error) === 'stale-session-state');

  const [session] = repository.sessions();
  assert.equal(session?.revokedAt, '2026-04-01T12:05:00Z');
  assert.equal(session?.revocationReason, 'security-event');
  assert.equal(
    session?.tokenHash,
    ORIGINAL_HASH,
    'a rotation that lost to a revocation must not leave a live secret on a revoked session',
  );
  assert.equal(session?.rotationCount, 0);
});

test('a guard that loses against what its own transaction can see still answers false', async () => {
  // The port's contract is unchanged for the case the transaction can actually see: a caller
  // presenting a hash that is already stale in its *own* snapshot is told `false`, and its
  // transaction commits as the no-op it is. Only a guard that loses *after* the answer was given
  // becomes a refusal, because only then is there no answer left to correct.
  const repository = new InMemoryAuthenticationRepository();
  repository.seed({ sessions: [seededSession()] });

  const answered = await repository.withTransaction((tx) =>
    tx.rotateSession({ ...rotationTo(LOSING_HASH), expectedTokenHash: 'e'.repeat(64) }),
  );

  assert.equal(answered, false);
  assert.equal(repository.transactionsCommitted, 1, 'a no-op transaction is not a refusal');
  assert.equal(repository.transactionsRolledBack, 0);
  assert.equal(repository.sessions()[0]?.tokenHash, ORIGINAL_HASH);
});

test('revoking a session that is already revoked stays a no-op rather than a refusal', async () => {
  // Signing out twice is not an error, and making the commit strict must not have made it one.
  const repository = new InMemoryAuthenticationRepository();
  repository.seed({
    sessions: [
      { ...seededSession(), revokedAt: '2026-04-01T12:00:00Z', revocationReason: 'signed-out' },
    ],
  });

  const answered = await repository.withTransaction((tx) =>
    tx.revokeSession({
      sessionId: 'sess_01HQZXOVERLAP1',
      revokedAt: '2026-04-01T12:05:00Z',
      reason: 'operator-revoked',
    }),
  );

  assert.equal(answered, false);
  assert.equal(repository.transactionsCommitted, 1);
  assert.equal(repository.sessions()[0]?.revokedAt, '2026-04-01T12:00:00Z');
  assert.equal(repository.sessions()[0]?.revocationReason, 'signed-out');
});

test('a session inserted and rotated inside one transaction commits both', async () => {
  // The guarded update is preflighted against the sessions as they stand *plus* this transaction's
  // own inserts. A transaction acting on a row it just wrote is not racing anybody, and refusing it
  // would be the strict commit overshooting.
  const repository = new InMemoryAuthenticationRepository();

  await repository.withTransaction(async (tx) => {
    await tx.insertSession(seededSession());
    assert.equal(await tx.rotateSession(rotationTo(WINNING_HASH)), true);
  });

  assert.equal(repository.transactionsCommitted, 1);
  assert.equal(repository.sessions().length, 1);
  assert.equal(repository.sessions()[0]?.tokenHash, WINNING_HASH);
  assert.equal(repository.sessions()[0]?.rotationCount, 1);
});

// ---------------------------------------------------------------------------
// The service, through the port
// ---------------------------------------------------------------------------

test('a rotation that loses hands back no token, and the secret it minted is dead', async () => {
  const harness = overlapping();
  const { sessionId, secret } = await signIn(harness);

  const held = new Latch();
  holdFirstGuardedWrite(harness.repository, held);

  // Two callers holding the same secret, rotating at once. One of them is about to lose.
  const first = harness.service.rotate({ sessionId, presentedToken: secret });
  const second = harness.service.rotate({ sessionId, presentedToken: secret });

  // Whichever reached the commit first is held open; the other runs through and wins.
  const winner = await Promise.race([first, second]);
  const winningSecret = winner.token.reveal();

  held.open();
  const outcomes = await Promise.allSettled([first, second]);
  const refused = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );

  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
    'two rotations of one session cannot both succeed: that is two live secrets',
  );
  assert.equal(refused.length, 1);
  assert.equal(codeOf(refused[0]?.reason), 'stale-session-state');

  // The losing rotation minted a secret before it lost. It was never returned — the call rejected
  // rather than resolving — and it must authenticate nothing.
  const losingSecret = harness.entropy.secrets.find(
    (candidate) => candidate !== secret && candidate !== winningSecret,
  );
  assert.ok(losingSecret !== undefined, 'the losing rotation did mint a secret');
  await assert.rejects(
    harness.service.validate(losingSecret),
    (error: unknown) => codeOf(error) === 'invalid-token',
    'a secret from a refused rotation must not validate',
  );

  const live = await harness.service.validate(winningSecret);
  assert.equal(live.rotationCount, 1, 'the loser did not write over the winner');
  assert.equal(harness.repository.store.sessions()[0]?.tokenHash, hashToken(winningSecret));
  assert.equal(harness.repository.store.sessions().length, 1);
});

test('a rotation and a revocation that overlap have exactly one authoritative outcome', async () => {
  const harness = overlapping();
  const { sessionId, secret } = await signIn(harness);

  const held = new Latch();
  holdFirstGuardedWrite(harness.repository, held);

  const rotation = harness.service.rotate({ sessionId, presentedToken: secret });
  const revocation = harness.service.revoke({ sessionId, reason: 'security-event' });

  // Settle whichever was not held, then release the one that was.
  await Promise.race([rotation.catch(() => undefined), revocation.catch(() => undefined)]);
  held.open();

  const [rotated, revoked] = await Promise.allSettled([rotation, revocation]);
  const outcomes = [rotated, revoked];
  const refused = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );

  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
    'a rotated session and a revoked session are different sessions; both cannot be the answer',
  );
  assert.equal(refused.length, 1);
  assert.equal(codeOf(refused[0]?.reason), 'stale-session-state');

  const stored = harness.repository.store.sessions()[0];
  assert.equal(harness.repository.store.sessions().length, 1);

  if (revoked.status === 'fulfilled') {
    assert.equal(stored?.revokedAt, '2026-04-01T12:00:00Z');
    assert.equal(stored?.revocationReason, 'security-event');
    assert.equal(stored?.rotationCount, 0, 'the refused rotation left nothing behind');
    assert.equal(
      stored?.tokenHash,
      hashToken(secret),
      'the refused rotation must not have replaced the secret on a revoked session',
    );
    const losingSecret = harness.entropy.secrets.find((candidate) => candidate !== secret);
    assert.ok(losingSecret !== undefined);
    await assert.rejects(
      harness.service.validate(losingSecret),
      (error: unknown) => codeOf(error) === 'invalid-token',
      'the secret the refused rotation minted authenticates nothing',
    );
    await assert.rejects(
      harness.service.validate(secret),
      (error: unknown) => codeOf(error) === 'session-revoked',
    );
  } else {
    const rotatedSecret = harness.entropy.secrets.find((candidate) => candidate !== secret);
    assert.ok(rotatedSecret !== undefined);
    assert.equal(stored?.revokedAt, null, 'the refused revocation left nothing behind');
    assert.equal(stored?.revocationReason, null);
    assert.equal(stored?.rotationCount, 1);
    assert.equal(stored?.tokenHash, hashToken(rotatedSecret));
  }
});
