/**
 * K-02 Authentication — convergence after a uniqueness conflict (FND-004c).
 *
 * Two identical authentications can overlap. One of them writes its evidence and session; the
 * other is refused by whichever unique constraint the store happened to check first — the evidence
 * id, the assertion, either idempotency key, the session id, the token hash. Six constraints, one
 * cause, and *which* of them reports the conflict is the database's own business.
 *
 * So the caller cannot be asked to interpret the code it gets back. Either the loser converges on
 * the winner — the same session, and a token it cannot open — or it keeps the refusal it already
 * had. What decides between those is not the constraint that fired but a **complete comparison**:
 * every non-secret field of the request, and the three records agreeing with each other. Anything
 * less converges on something the caller did not ask for, and the thing being handed back is a
 * live session.
 *
 * The cases that must *not* converge are the point of this suite:
 *
 *   - an assertion replayed under a fresh idempotency key — nothing to converge on, so it stays a
 *     replay;
 *   - a key reused against a different provider reference — the same provider, a different account;
 *   - identifiers that do not match, or records that do not name each other;
 *   - evidence with no session under the key, which is half an authentication;
 *   - two unrelated sessions colliding on a token hash, which is a failing entropy source and not
 *     a retry at all.
 *
 * Every refusal here is derived from the *real* adapter's translation of a real SQLSTATE 23505 on
 * a named constraint, so the codes these tests converge on are the codes PostgreSQL would produce
 * rather than codes chosen to make the tests pass.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthenticationError,
  AuthenticationService,
  InMemoryAuthenticationRepository,
  PostgresAuthenticationRepository,
  ProviderRegistry,
  hashToken,
  validateEvidence,
  validateSession,
  type AuthenticateRequest,
  type AuthenticationBinding,
  type AuthenticationEvidence,
  type AuthenticationRepository,
  type AuthenticationSession,
  type AuthenticationTransaction,
  type EntropySource,
  type RevocationCommand,
  type RotationCommand,
} from '../kernel/authentication/index.ts';

import {
  BINDING_REFERENCE,
  FixedClock,
  KNOWN_SUBJECT,
  PROVIDER,
  StubSubjectLookup,
  StubVerifier,
  authenticateRequest,
  bindRequest,
} from './helpers/authentication-fixtures.ts';
import { RecordingDatabase, sqlstateError } from './helpers/recording-database.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof AuthenticationError ? error.code : undefined;

// ---------------------------------------------------------------------------
// The refusals PostgreSQL can actually produce
// ---------------------------------------------------------------------------

/** Every unique constraint that can refuse the evidence-and-session write, and where it fires. */
const WRITE_CONSTRAINTS = [
  { constraint: 'authentication_evidence_pkey', at: 'evidence' },
  { constraint: 'authentication_evidence_assertion_unique', at: 'evidence' },
  { constraint: 'authentication_evidence_idempotency_unique', at: 'evidence' },
  { constraint: 'authentication_session_pkey', at: 'session' },
  { constraint: 'authentication_session_token_unique', at: 'session' },
  { constraint: 'authentication_session_idempotency_unique', at: 'session' },
] as const;

/**
 * The refusal the real adapter raises when PostgreSQL selects this constraint.
 *
 * Derived rather than written down: the recovery path is only as good as the codes it recognises,
 * and a test that asserted its own idea of the mapping would keep passing after the adapter's
 * changed. A `RecordingDatabase` raises 23505 on the named constraint and the adapter translates
 * it exactly as it would in production.
 */
async function refusalFor(constraint: string, at: 'evidence' | 'session'): Promise<Error> {
  const database = new RecordingDatabase({
    failures: [
      {
        match: /INSERT INTO/i,
        error: sqlstateError(
          `duplicate key value violates unique constraint "${constraint}"`,
          '23505',
          constraint,
        ),
      },
    ],
  });
  const repository = new PostgresAuthenticationRepository(database);

  try {
    await repository.withTransaction((tx) =>
      at === 'evidence' ? tx.insertEvidence(adapterEvidence()) : tx.insertSession(adapterSession()),
    );
  } catch (error) {
    assert.ok(
      error instanceof AuthenticationError,
      `${constraint} must normalise to a refusal, not escape as a driver error`,
    );
    return error;
  }
  throw new Error(`${constraint} did not refuse the insert at all`);
}

function adapterEvidence(): AuthenticationEvidence {
  return {
    evidenceId: 'evid_01HQZXADAPTER1',
    bindingId: 'bind_01HQZXADAPTER1',
    subjectId: 'sub_01HQZXADAPTER1',
    provider: PROVIDER,
    assertionId: 'asrt_01HQZXADAPTER1',
    factors: ['possession'],
    assurance: 'single-factor',
    verifiedAt: '2026-04-01T11:59:30Z',
    recordedAt: '2026-04-01T12:00:00Z',
    idempotencyKey: 'idem_01HQZXADAPTER1',
  };
}

function adapterSession(): AuthenticationSession {
  return {
    sessionId: 'sess_01HQZXADAPTER1',
    bindingId: 'bind_01HQZXADAPTER1',
    subjectId: 'sub_01HQZXADAPTER1',
    evidenceId: 'evid_01HQZXADAPTER1',
    assurance: 'single-factor',
    factors: ['possession'],
    tokenHash: 'f'.repeat(64),
    issuedAt: '2026-04-01T12:00:00Z',
    absoluteExpiresAt: '2026-04-02T00:00:00Z',
    idleExpiresAt: '2026-04-01T12:30:00Z',
    rotationCount: 0,
    revokedAt: null,
    revocationReason: null,
    idempotencyKey: 'idem_01HQZXADAPTER1',
  };
}

// ---------------------------------------------------------------------------
// Losing the race on purpose
// ---------------------------------------------------------------------------

/** Delegates everything, and lets the other half of a race land at a chosen statement. */
class RacingTransaction implements AuthenticationTransaction {
  readonly #inner: AuthenticationTransaction;
  readonly #interrupt: (at: 'evidence' | 'session') => Promise<void>;

  constructor(
    inner: AuthenticationTransaction,
    interrupt: (at: 'evidence' | 'session') => Promise<void>,
  ) {
    this.#inner = inner;
    this.#interrupt = interrupt;
  }

  findBindingById(bindingId: string): Promise<AuthenticationBinding | null> {
    return this.#inner.findBindingById(bindingId);
  }

  findBindingByReference(
    provider: string,
    providerReference: string,
  ): Promise<AuthenticationBinding | null> {
    return this.#inner.findBindingByReference(provider, providerReference);
  }

  findBindingByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationBinding | null> {
    return this.#inner.findBindingByIdempotencyKey(idempotencyKey);
  }

  listBindingsForSubject(subjectId: string): Promise<readonly AuthenticationBinding[]> {
    return this.#inner.listBindingsForSubject(subjectId);
  }

  insertBinding(binding: AuthenticationBinding): Promise<void> {
    return this.#inner.insertBinding(binding);
  }

  findEvidenceByAssertionId(
    provider: string,
    assertionId: string,
  ): Promise<AuthenticationEvidence | null> {
    return this.#inner.findEvidenceByAssertionId(provider, assertionId);
  }

  findEvidenceByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationEvidence | null> {
    return this.#inner.findEvidenceByIdempotencyKey(idempotencyKey);
  }

  async insertEvidence(evidence: AuthenticationEvidence): Promise<void> {
    await this.#interrupt('evidence');
    return this.#inner.insertEvidence(evidence);
  }

  findSessionById(sessionId: string): Promise<AuthenticationSession | null> {
    return this.#inner.findSessionById(sessionId);
  }

  findSessionByTokenHash(tokenHash: string): Promise<AuthenticationSession | null> {
    return this.#inner.findSessionByTokenHash(tokenHash);
  }

  findSessionByIdempotencyKey(idempotencyKey: string): Promise<AuthenticationSession | null> {
    return this.#inner.findSessionByIdempotencyKey(idempotencyKey);
  }

  async insertSession(session: AuthenticationSession): Promise<void> {
    await this.#interrupt('session');
    return this.#inner.insertSession(session);
  }

  rotateSession(command: RotationCommand): Promise<boolean> {
    return this.#inner.rotateSession(command);
  }

  revokeSession(command: RevocationCommand): Promise<boolean> {
    return this.#inner.revokeSession(command);
  }
}

interface Interruption {
  /** Which statement the other half of the race lands in front of. */
  readonly at: 'evidence' | 'session';
  /** What the winner did, and — where a constraint is being simulated — how the store refused us. */
  readonly run: () => Promise<void>;
}

/**
 * The real in-memory repository, with one seam: the other half of an overlapping call can be made
 * to land at the exact statement a chosen constraint would have refused.
 *
 * Everything else is the repository's own, which is the point of using it rather than a stub. The
 * seam fires once, so a nested call inside the hook runs against an untouched repository.
 */
class RacingRepository implements AuthenticationRepository {
  readonly store = new InMemoryAuthenticationRepository();
  #pending: Interruption | null = null;

  /** Arrange for `interruption` to happen inside the next write that reaches it. */
  interruptNextWrite(interruption: Interruption): void {
    this.#pending = interruption;
  }

  withTransaction<T>(body: (tx: AuthenticationTransaction) => Promise<T>): Promise<T> {
    return this.store.withTransaction((tx) =>
      body(new RacingTransaction(tx, (at) => this.#fire(at))),
    );
  }

  #fire(at: 'evidence' | 'session'): Promise<void> {
    const pending = this.#pending;
    if (pending === null || pending.at !== at) return Promise.resolve();
    this.#pending = null;
    return pending.run();
  }
}

/** Predictable secrets, kept, so a losing call's secret can be presented and refused. */
class RecordingEntropy implements EntropySource {
  readonly secrets: string[] = [];

  token(): string {
    const suffix = String(this.secrets.length + 1).padStart(4, '0');
    const secret = `tok${'A'.repeat(39)}${suffix}`;
    this.secrets.push(secret);
    return secret;
  }
}

interface Harness {
  readonly service: AuthenticationService;
  readonly repository: RacingRepository;
  readonly entropy: RecordingEntropy;
  readonly verifier: StubVerifier;
}

/** The service over a repository whose writes a test can interrupt. */
function build(): Harness {
  const repository = new RacingRepository();
  const entropy = new RecordingEntropy();
  // One fixed assertion: two presentations of one proof are what an identical retry actually is.
  const verifier = new StubVerifier({ override: { assertionId: 'asrt_01HQZXSAME001' } });
  const service = new AuthenticationService({
    repository,
    providers: new ProviderRegistry([
      {
        provider: PROVIDER,
        description: 'A stub provider used by the K-02 suites; verifies nothing in production.',
      },
    ]),
    verifiers: [verifier],
    subjects: new StubSubjectLookup(),
    clock: new FixedClock(),
    entropy,
  });
  return { service, repository, entropy, verifier };
}

const REQUEST: AuthenticateRequest = authenticateRequest({
  evidenceId: 'evid_01HQZXCONVRG1',
  sessionId: 'sess_01HQZXCONVRG1',
  idempotencyKey: 'idem_01HQZXCONVRG1',
});

const BINDING_ID = 'bind_01HQZXCONVRG1';

async function bound(harness: Harness): Promise<void> {
  await harness.service.bind(bindRequest({ bindingId: BINDING_ID }));
}

/** What one committed authentication consists of, as the store holds it. */
interface WinnerRecords {
  readonly evidence: AuthenticationEvidence;
  readonly session: AuthenticationSession | null;
}

/** The authentication the *winner* of the race committed: the same request, its own secret. */
function winnerRecords(
  overrides: {
    readonly evidence?: Partial<AuthenticationEvidence>;
    readonly session?: Partial<AuthenticationSession> | null;
  } = {},
): WinnerRecords {
  const evidence: AuthenticationEvidence = {
    evidenceId: REQUEST.evidenceId,
    bindingId: BINDING_ID,
    subjectId: KNOWN_SUBJECT,
    provider: PROVIDER,
    assertionId: 'asrt_01HQZXSAME001',
    factors: ['possession'],
    assurance: 'single-factor',
    verifiedAt: '2026-04-01T11:59:30Z',
    recordedAt: '2026-04-01T12:00:00Z',
    idempotencyKey: REQUEST.idempotencyKey,
    ...overrides.evidence,
  };
  if (overrides.session === null) return { evidence, session: null };

  const session: AuthenticationSession = {
    sessionId: REQUEST.sessionId,
    bindingId: BINDING_ID,
    subjectId: KNOWN_SUBJECT,
    evidenceId: REQUEST.evidenceId,
    assurance: 'single-factor',
    factors: ['possession'],
    tokenHash: hashToken(`win${'W'.repeat(40)}`),
    issuedAt: '2026-04-01T12:00:00Z',
    absoluteExpiresAt: '2026-04-02T00:00:00Z',
    idleExpiresAt: '2026-04-01T12:30:00Z',
    rotationCount: 0,
    revokedAt: null,
    revocationReason: null,
    idempotencyKey: REQUEST.idempotencyKey,
    ...overrides.session,
  };
  return { evidence, session };
}

/** Commit the winner's rows, exactly as another connection would have. */
async function commitWinner(
  harness: Harness,
  records: { evidence: AuthenticationEvidence; session: AuthenticationSession | null },
): Promise<void> {
  await harness.repository.store.withTransaction(async (tx) => {
    await tx.insertEvidence(records.evidence);
    if (records.session !== null) await tx.insertSession(records.session);
  });
}

/**
 * Lose the race: the winner commits, and the store refuses this call with `refusal`.
 *
 * The refusal is the adapter's own translation of the named constraint, so what the service sees
 * here is what it would see from PostgreSQL having selected that index.
 */
function loseTo(
  harness: Harness,
  at: 'evidence' | 'session',
  refusal: Error,
  records: { evidence: AuthenticationEvidence; session: AuthenticationSession | null },
): void {
  harness.repository.interruptNextWrite({
    at,
    run: async () => {
      await commitWinner(harness, records);
      throw refusal;
    },
  });
}

// ---------------------------------------------------------------------------
// Every constraint the database can choose
// ---------------------------------------------------------------------------

test('every constraint that can refuse the write normalises to a refusal, not a driver error', async () => {
  for (const { constraint, at } of WRITE_CONSTRAINTS) {
    const refusal = await refusalFor(constraint, at);
    assert.ok(
      [
        'idempotency-key-reuse',
        'assertion-replayed',
        'malformed-record',
        'insufficient-entropy',
      ].includes(codeOf(refusal) ?? ''),
      `${constraint} produced ${String(codeOf(refusal))}, which the recovery path does not recognise`,
    );
  }
});

test('an identical call converges whichever constraint the database selects', async () => {
  for (const { constraint, at } of WRITE_CONSTRAINTS) {
    const refusal = await refusalFor(constraint, at);
    const harness = build();
    await bound(harness);
    loseTo(harness, at, refusal, winnerRecords());

    const result = await harness.service.authenticate({ ...REQUEST });

    assert.equal(result.deduplicated, true, `${constraint} must converge, not refuse`);
    assert.equal(result.session.sessionId, REQUEST.sessionId);
    assert.equal(result.evidence.evidenceId, REQUEST.evidenceId);
    assert.equal(
      result.session.tokenHash,
      hashToken(`win${'W'.repeat(40)}`),
      'the session handed back is the winner’s, not the one this call built',
    );

    assert.throws(
      () => result.token.reveal(),
      (error: unknown) => codeOf(error) === 'invalid-token',
      `${constraint}: the loser must not receive a usable token`,
    );

    const losingSecret = harness.entropy.secrets[0];
    assert.ok(losingSecret !== undefined);
    await assert.rejects(
      harness.service.validate(losingSecret),
      (error: unknown) => codeOf(error) === 'invalid-token',
      `${constraint}: the secret the losing call minted must authenticate nothing`,
    );

    assert.equal(harness.repository.store.sessions().length, 1, `${constraint}: one session only`);
    assert.equal(harness.repository.store.evidence().length, 1);
  }
});

// ---------------------------------------------------------------------------
// What must not converge
// ---------------------------------------------------------------------------

test('an assertion replayed under a fresh idempotency key stays a replay', async () => {
  // The recovery re-reads by *this* call's idempotency key. A replay carries a new one, so there
  // is nothing recorded under it and nothing to converge on — which is the whole difference
  // between a retry and a replay.
  const refusal = await refusalFor('authentication_evidence_assertion_unique', 'evidence');
  const harness = build();
  await bound(harness);

  const winner = winnerRecords({
    evidence: { evidenceId: 'evid_01HQZXWINNER1', idempotencyKey: 'idem_01HQZXWINNER1' },
    session: { sessionId: 'sess_01HQZXWINNER1', idempotencyKey: 'idem_01HQZXWINNER1' },
  });
  loseTo(harness, 'evidence', refusal, winner);

  await assert.rejects(
    harness.service.authenticate({ ...REQUEST }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'assertion-replayed');
      return true;
    },
    'a replay that converged would be a second session for one assertion',
  );

  assert.equal(harness.repository.store.sessions().length, 1, 'the winner’s session, and no other');
});

test('a key reused against a different provider reference cannot converge', async () => {
  // Evidence records a provider but no provider reference, so without reading the binding this
  // comparison would find nothing to disagree about — and hand back a session for another account
  // on the same provider.
  const refusal = await refusalFor('authentication_evidence_idempotency_unique', 'evidence');
  const harness = build();
  await bound(harness);
  await harness.service.bind(
    bindRequest({
      bindingId: 'bind_01HQZXOTHER01',
      providerReference: 'ref_01HQZXOTHER001',
      idempotencyKey: 'idem_01HQZXOTHERB1',
    }),
  );

  loseTo(
    harness,
    'evidence',
    refusal,
    winnerRecords({
      evidence: { bindingId: 'bind_01HQZXOTHER01' },
      session: { bindingId: 'bind_01HQZXOTHER01' },
    }),
  );

  await assert.rejects(
    harness.service.authenticate({ ...REQUEST }),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
    'the reference is the field that says which account was authenticated',
  );
});

test('identifiers that do not match keep the refusal they had', async () => {
  // "Keep" is exact: a mismatch is not rewritten into `idempotency-key-reuse`, it is left as the
  // refusal the store actually gave. Recovery either recognises its own call or gets out of the
  // way, and a code invented on the way out would hide which constraint fired.
  const cases = [
    {
      why: 'another evidence id',
      records: winnerRecords({ evidence: { evidenceId: 'evid_01HQZXOTHER01' } }),
    },
    {
      why: 'another session id',
      records: winnerRecords({ session: { sessionId: 'sess_01HQZXOTHER01' } }),
    },
    {
      why: 'another provider',
      records: winnerRecords({ evidence: { provider: 'other-provider' } }),
    },
  ] as const;

  for (const { why, records } of cases) {
    const refusal = await refusalFor('authentication_evidence_idempotency_unique', 'evidence');
    const harness = build();
    await bound(harness);
    loseTo(harness, 'evidence', refusal, records);

    await assert.rejects(
      harness.service.authenticate({ ...REQUEST }),
      (error: unknown) => codeOf(error) === codeOf(refusal),
      `${why} must not be handed back as if this caller had asked for it`,
    );
  }
});

test('records that do not name each other are not a coherent authentication', async () => {
  // Convergence runs on the path taken when something has already gone wrong, so it checks that
  // the three records agree with each other and not only with the request.
  const cases = [
    {
      why: 'a session naming other evidence',
      records: winnerRecords({ session: { evidenceId: 'evid_01HQZXOTHER01' } }),
    },
    {
      why: 'a session and evidence on different bindings',
      records: winnerRecords({ session: { bindingId: 'bind_01HQZXOTHER01' } }),
    },
    {
      why: 'a session and evidence on different subjects',
      records: winnerRecords({ session: { subjectId: 'sub_01HQZXOTHER001' } }),
    },
  ] as const;

  for (const { why, records } of cases) {
    const refusal = await refusalFor('authentication_session_pkey', 'session');
    assert.equal(codeOf(refusal), 'malformed-record');
    const harness = build();
    await bound(harness);
    loseTo(harness, 'session', refusal, records);

    await assert.rejects(
      harness.service.authenticate({ ...REQUEST }),
      (error: unknown) => codeOf(error) === codeOf(refusal),
      `${why} must fail closed on the refusal the store gave`,
    );
  }
});

test('evidence with no session under the key is half an authentication, not a retry', async () => {
  const refusal = await refusalFor('authentication_evidence_idempotency_unique', 'evidence');
  const harness = build();
  await bound(harness);
  loseTo(harness, 'evidence', refusal, winnerRecords({ session: null }));

  await assert.rejects(
    harness.service.authenticate({ ...REQUEST }),
    (error: unknown) => codeOf(error) === 'idempotency-key-reuse',
    'converging on evidence with no session would hand back a session that does not exist',
  );
});

test('a token hash collision between unrelated sessions stays an entropy failure', async () => {
  // Two calls, two idempotency keys, one repeating entropy source. Nothing is recorded under the
  // second call's key, so there is nothing to converge on and the refusal stands — which is what
  // must happen, because this is a degraded entropy source rather than a retry.
  const refusal = await refusalFor('authentication_session_token_unique', 'session');
  const harness = build();
  await bound(harness);

  loseTo(
    harness,
    'session',
    refusal,
    winnerRecords({
      evidence: { evidenceId: 'evid_01HQZXWINNER1', idempotencyKey: 'idem_01HQZXWINNER1' },
      session: { sessionId: 'sess_01HQZXWINNER1', idempotencyKey: 'idem_01HQZXWINNER1' },
    }),
  );

  await assert.rejects(
    harness.service.authenticate({ ...REQUEST }),
    (error: unknown) => codeOf(error) === 'insufficient-entropy',
    'a repeating entropy source must not be laundered into a successful retry',
  );
  assert.equal(harness.repository.store.sessions().length, 1);
});

// ---------------------------------------------------------------------------
// The same comparison, before the verifier
// ---------------------------------------------------------------------------

test('the pre-verifier retry path applies the same complete comparison', async () => {
  // Reached without any conflict at all: the earlier call committed long ago. It must refuse the
  // same things the post-conflict path refuses, or the two paths disagree about what a retry is.
  const harness = build();
  await bound(harness);
  await harness.service.bind(
    bindRequest({
      bindingId: 'bind_01HQZXOTHER01',
      providerReference: 'ref_01HQZXOTHER001',
      idempotencyKey: 'idem_01HQZXOTHERB1',
    }),
  );

  // An authentication recorded under this key, but against the other reference.
  await commitWinner(
    harness,
    winnerRecords({
      evidence: { bindingId: 'bind_01HQZXOTHER01' },
      session: { bindingId: 'bind_01HQZXOTHER01' },
    }),
  );

  await assert.rejects(
    harness.service.authenticate({ ...REQUEST }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match((error as AuthenticationError).message, /providerReference/);
      return true;
    },
    'a retry for a different account on the same provider is not a retry',
  );
  assert.equal(
    harness.verifier.challenges.length,
    0,
    'and it was refused before the proof reached the verifier',
  );
});

test('a retry whose binding has gone is refused rather than converged on', async () => {
  const harness = build();
  await bound(harness);
  await commitWinner(harness, winnerRecords({ evidence: { bindingId: 'bind_01HQZXGONE001' } }));

  await assert.rejects(harness.service.authenticate({ ...REQUEST }), (error: unknown) => {
    assert.equal(codeOf(error), 'idempotency-key-reuse');
    assert.match((error as AuthenticationError).message, /binding/);
    return true;
  });
});

test('a genuine retry still converges, and still gets no second secret', async () => {
  const harness = build();
  await bound(harness);

  const first = await harness.service.authenticate({ ...REQUEST });
  const retry = await harness.service.authenticate({ ...REQUEST });

  assert.equal(first.deduplicated, false);
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.session.sessionId, first.session.sessionId);
  assert.equal(retry.session.tokenHash, first.session.tokenHash);
  assert.throws(
    () => retry.token.reveal(),
    (error: unknown) => codeOf(error) === 'invalid-token',
  );
  assert.equal(harness.verifier.challenges.length, 1, 'the retry did not re-present the proof');
  assert.equal(harness.repository.store.sessions().length, 1);
});

// ---------------------------------------------------------------------------
// Two identical calls, actually overlapping
// ---------------------------------------------------------------------------

test('two identical calls overlapping in memory issue exactly one usable token', async () => {
  // No simulated refusal here: the second call runs to completion inside the first call's open
  // transaction, so the first is refused by the in-memory repository's own commit-time uniqueness
  // checks — the same checks the database performs, chosen by the same rule.
  const harness = build();
  await bound(harness);

  let inner: Awaited<ReturnType<AuthenticationService['authenticate']>> | null = null;
  harness.repository.interruptNextWrite({
    at: 'evidence',
    run: async () => {
      inner = await harness.service.authenticate({ ...REQUEST });
    },
  });

  const outer = await harness.service.authenticate({ ...REQUEST });

  const winner = inner as Awaited<ReturnType<AuthenticationService['authenticate']>> | null;
  assert.ok(winner !== null, 'the overlapping call did run');
  assert.equal(winner.deduplicated, false, 'the call that committed is the one that authenticated');
  assert.equal(outer.deduplicated, true, 'the call that lost converged rather than failing');
  assert.equal(outer.session.sessionId, winner.session.sessionId);
  assert.equal(outer.session.tokenHash, winner.session.tokenHash);

  assert.equal(harness.repository.store.sessions().length, 1, 'one authentication, one session');
  assert.equal(harness.repository.store.evidence().length, 1);

  // Exactly one usable token: the winner's opens, the loser's does not exist.
  const secret = winner.token.reveal();
  const live = await harness.service.validate(secret);
  assert.equal(live.sessionId, REQUEST.sessionId);
  assert.throws(
    () => outer.token.reveal(),
    (error: unknown) => codeOf(error) === 'invalid-token',
  );

  const losingSecret = harness.entropy.secrets.find((candidate) => candidate !== secret);
  assert.ok(losingSecret !== undefined, 'the losing call did mint a secret');
  await assert.rejects(
    harness.service.validate(losingSecret),
    (error: unknown) => codeOf(error) === 'invalid-token',
    'the secret the losing call minted must authenticate nothing',
  );
});

test('an overlapping call for a different account does not converge', async () => {
  // The same overlap, but the two calls are not the same authentication. The loser must keep its
  // refusal even though the shape of the failure is identical.
  const harness = build();
  await bound(harness);
  await harness.service.bind(
    bindRequest({
      bindingId: 'bind_01HQZXOTHER01',
      providerReference: 'ref_01HQZXOTHER001',
      idempotencyKey: 'idem_01HQZXOTHERB1',
    }),
  );

  harness.repository.interruptNextWrite({
    at: 'evidence',
    run: async () => {
      await commitWinner(
        harness,
        winnerRecords({
          evidence: { bindingId: 'bind_01HQZXOTHER01' },
          session: { bindingId: 'bind_01HQZXOTHER01' },
        }),
      );
    },
  });

  await assert.rejects(harness.service.authenticate({ ...REQUEST }), (error: unknown) => {
    const code = codeOf(error);
    assert.ok(
      code === 'malformed-record' || code === 'idempotency-key-reuse',
      `expected the store's own refusal, got ${String(code)}`,
    );
    return true;
  });
  assert.equal(harness.repository.store.sessions().length, 1);
  assert.equal(harness.repository.store.sessions()[0]?.bindingId, 'bind_01HQZXOTHER01');
});

// ---------------------------------------------------------------------------
// Individually valid, mutually impossible
// ---------------------------------------------------------------------------

/**
 * Row pairs that are each well formed and together describe an authentication that never happened.
 *
 * These are the adversarial ones. Every identifier agrees, every relationship agrees, the binding
 * is right, the idempotency keys match — a comparison that stopped at "do these name each other?"
 * converges on all of them. What disagrees is a fact the two rows both carry: how strongly the
 * subject was authenticated, which categories were confirmed, or when any of it happened.
 *
 * The assurance and factor cases are privilege escalation. `validate` reads the *session's* copy,
 * so a session that says `hardware-backed` over evidence that says `single-factor` is a caller
 * holding a stronger authentication than any verifier ever granted — and neither row is malformed,
 * so nothing upstream of this comparison can refuse it.
 */
const INCONSISTENT = [
  {
    why: 'a session claiming stronger assurance than the evidence recorded',
    names: /assurance/,
    records: (): WinnerRecords => winnerRecords({ session: { assurance: 'hardware-backed' } }),
  },
  {
    why: 'a session claiming a factor category the verifier never confirmed',
    names: /factors/,
    records: (): WinnerRecords =>
      winnerRecords({ session: { factors: ['possession', 'knowledge'] } }),
  },
  {
    why: 'a session issued before the proof was verified',
    names: /before the proof was verified/,
    records: (): WinnerRecords => winnerRecords({ session: { issuedAt: '2026-04-01T11:00:00Z' } }),
  },
  {
    why: 'a session issued before the evidence that accounts for it',
    names: /before the evidence that accounts for it/,
    records: (): WinnerRecords => winnerRecords({ session: { issuedAt: '2026-04-01T11:59:45Z' } }),
  },
  {
    why: 'evidence recorded before it was verified',
    names: /recorded before it was verified/,
    records: (): WinnerRecords =>
      winnerRecords({ evidence: { recordedAt: '2026-04-01T11:00:00Z' } }),
  },
] as const;

test('mutually inconsistent rows keep the refusal the store gave', async () => {
  for (const scenario of INCONSISTENT) {
    const refusal = await refusalFor('authentication_evidence_idempotency_unique', 'evidence');
    const harness = build();
    await bound(harness);
    loseTo(harness, 'evidence', refusal, scenario.records());

    await assert.rejects(
      harness.service.authenticate({ ...REQUEST }),
      (error: unknown) => codeOf(error) === codeOf(refusal),
      `${scenario.why} must not be converged on`,
    );
    assert.equal(
      harness.repository.store.sessions().length,
      1,
      `${scenario.why}: the refused call wrote nothing of its own`,
    );
  }
});

test('mutually inconsistent rows are idempotency-key-reuse before the verifier', async () => {
  for (const scenario of INCONSISTENT) {
    const harness = build();
    await bound(harness);
    await commitWinner(harness, scenario.records());

    await assert.rejects(
      harness.service.authenticate({ ...REQUEST }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'idempotency-key-reuse', scenario.why);
        assert.match((error as AuthenticationError).message, scenario.names, scenario.why);
        return true;
      },
      `${scenario.why} must fail closed on the retry path too`,
    );
    assert.equal(
      harness.verifier.challenges.length,
      0,
      `${scenario.why}: and the proof never reached the verifier`,
    );
  }
});

test('the planted escalation differs from an honest retry in exactly one fact', async () => {
  // The regression, planted deliberately: rows built to pass every check that existed before the
  // duplicated facts were compared. If this case converges, the comparison is decorative — so this
  // test states, field by field, that nothing *else* could have refused it.
  const planted = winnerRecords({ session: { assurance: 'hardware-backed' } });
  const honest = winnerRecords();
  assert.ok(planted.session !== null && honest.session !== null);

  assert.equal(planted.evidence.evidenceId, REQUEST.evidenceId);
  assert.equal(planted.evidence.provider, REQUEST.provider);
  assert.equal(planted.evidence.idempotencyKey, REQUEST.idempotencyKey);
  assert.equal(planted.session.sessionId, REQUEST.sessionId);
  assert.equal(planted.session.idempotencyKey, REQUEST.idempotencyKey);
  assert.equal(planted.session.evidenceId, planted.evidence.evidenceId);
  assert.equal(planted.session.bindingId, planted.evidence.bindingId);
  assert.equal(planted.session.subjectId, planted.evidence.subjectId);
  assert.equal(planted.session.bindingId, BINDING_ID);
  assert.deepEqual(
    { ...planted.session, assurance: honest.session.assurance },
    { ...honest.session },
    'the planted session must differ from an honest one in the assurance and nothing else',
  );

  // And each row is individually well formed: no validator anywhere can see the problem, because
  // each of them only ever sees one row.
  assert.doesNotThrow(() => validateEvidence(planted.evidence, 'stored row'));
  assert.doesNotThrow(() => validateSession(planted.session, 'stored row'));

  // What it would have handed back: hardware-backed, granted by nobody.
  assert.equal(planted.evidence.assurance, 'single-factor');
  assert.equal(planted.session.assurance, 'hardware-backed');

  const harness = build();
  await bound(harness);
  await commitWinner(harness, planted);

  await assert.rejects(
    harness.service.authenticate({ ...REQUEST }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      assert.match((error as AuthenticationError).message, /assurance/);
      return true;
    },
    'converging here would hand the caller an assurance level no verifier granted',
  );
});

test('the factor comparison is by set, so an honest retry is not refused for ordering', async () => {
  // The other half of the factor check: it must be strict about *which* categories and indifferent
  // to how either row happens to list them, or it refuses the retries it exists to allow.
  const harness = build();
  await bound(harness);
  harness.verifier.answerWith({ factors: ['possession', 'knowledge'], assurance: 'multi-factor' });

  const first = await harness.service.authenticate({ ...REQUEST });
  const retry = await harness.service.authenticate({ ...REQUEST });

  assert.deepEqual([...first.evidence.factors], ['knowledge', 'possession']);
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.session.sessionId, first.session.sessionId);
  assert.equal(retry.session.assurance, 'multi-factor');
});

test('BINDING_REFERENCE is what the request under test authenticates against', () => {
  // Guards the fixtures the cases above lean on: if the request stopped pointing at the bound
  // reference, the mismatch tests would pass for the wrong reason.
  assert.equal(REQUEST.providerReference, BINDING_REFERENCE);
  assert.equal(REQUEST.provider, PROVIDER);
});
