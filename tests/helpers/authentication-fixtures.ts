/**
 * Shared fixtures for the K-02 suites (FND-004c).
 *
 * The three fakes here stand in for the three things K-02 refuses to do itself, and each is written
 * so a test can make it misbehave:
 *
 *   - `StubVerifier` returns whatever assertion the test tells it to, including wrong ones. That is
 *     the point — the interesting tests are the ones where the verifier lies, is slow, is replayed,
 *     or answers about a different binding.
 *   - `FixedClock` moves only when a test moves it, so expiry is a decision rather than a wait.
 *   - `SequenceEntropy` produces predictable secrets, which is exactly what production must not do
 *     and what a deterministic test must.
 */

import {
  AuthenticationService,
  InMemoryAuthenticationRepository,
  ProviderRegistry,
  type AssuranceLevel,
  type AuthenticateRequest,
  type BindRequest,
  type Clock,
  type EntropySource,
  type FactorCategory,
  type MfaPolicy,
  type SessionPolicy,
  type SubjectLookup,
  type Verifier,
  type VerifierAssertion,
  type VerifierChallenge,
} from '../../kernel/authentication/index.ts';

export const PROVIDER = 'passkey';
export const KNOWN_SUBJECT = 'sub_01HQZXKNOWN0001';
export const BINDING_REFERENCE = 'ref_01HQZXPROVIDER1';

/** A lookup that knows exactly the subjects it was given, and counts what it was asked. */
export class StubSubjectLookup implements SubjectLookup {
  readonly asked: string[] = [];
  readonly #known: Set<string>;

  constructor(known: readonly string[] = [KNOWN_SUBJECT]) {
    this.#known = new Set(known);
  }

  exists(subjectId: string): Promise<boolean> {
    this.asked.push(subjectId);
    return Promise.resolve(this.#known.has(subjectId));
  }
}

/** A clock a test moves by hand. */
export class FixedClock implements Clock {
  #now: string;

  constructor(now = '2026-04-01T12:00:00Z') {
    this.#now = now;
  }

  now(): string {
    return this.#now;
  }

  set(instant: string): void {
    this.#now = instant;
  }
}

/**
 * Predictable session secrets.
 *
 * Base64url and long enough to satisfy the entropy check, so tests exercise the real path rather
 * than the refusal — a fixture that tripped `insufficient-entropy` would make every session test a
 * test of the entropy guard.
 */
export class SequenceEntropy implements EntropySource {
  issued = 0;
  readonly #prefix: string;

  constructor(prefix = 'tok') {
    this.#prefix = prefix;
  }

  token(): string {
    this.issued += 1;
    const suffix = String(this.issued).padStart(4, '0');
    return `${this.#prefix}${'A'.repeat(46 - this.#prefix.length - suffix.length)}${suffix}`;
  }
}

/** An entropy source that always returns the same value, for the repeated-secret path. */
export class RepeatingEntropy implements EntropySource {
  token(): string {
    return `repeat${'B'.repeat(37)}`;
  }
}

export interface StubVerifierOptions {
  readonly provider?: string;
  readonly factors?: readonly FactorCategory[];
  readonly assurance?: AssuranceLevel;
  readonly verifiedAt?: string;
  readonly expiresAt?: string;
  /** Overrides applied to the assertion, so a test can make the verifier answer wrongly. */
  readonly override?: Partial<VerifierAssertion>;
  /** When set, `verify` rejects with this instead of asserting. */
  readonly refuseWith?: Error;
}

/** A verifier whose answer a test controls completely, including the wrong answers. */
export class StubVerifier implements Verifier {
  readonly provider: string;
  readonly challenges: VerifierChallenge[] = [];
  #assertionSequence = 0;
  #options: StubVerifierOptions;

  constructor(options: StubVerifierOptions = {}) {
    this.provider = options.provider ?? PROVIDER;
    this.#options = options;
  }

  /** Change what the verifier will say next. */
  answerWith(options: StubVerifierOptions): void {
    this.#options = { ...this.#options, ...options };
  }

  verify(challenge: VerifierChallenge): Promise<VerifierAssertion> {
    this.challenges.push(challenge);
    if (this.#options.refuseWith !== undefined) {
      return Promise.reject(this.#options.refuseWith);
    }

    this.#assertionSequence += 1;
    const assertion: VerifierAssertion = {
      assertionId: `asrt_01HQZX${String(this.#assertionSequence).padStart(4, '0')}`,
      provider: this.provider,
      providerReference: challenge.providerReference,
      factors: this.#options.factors ?? ['possession'],
      assurance: this.#options.assurance ?? 'single-factor',
      verifiedAt: this.#options.verifiedAt ?? '2026-04-01T11:59:30Z',
      expiresAt: this.#options.expiresAt ?? '2026-04-01T12:01:00Z',
      ...this.#options.override,
    };
    return Promise.resolve(assertion);
  }
}

export interface Harness {
  readonly service: AuthenticationService;
  readonly repository: InMemoryAuthenticationRepository;
  readonly verifier: StubVerifier;
  readonly subjects: StubSubjectLookup;
  readonly clock: FixedClock;
  readonly entropy: SequenceEntropy;
  readonly providers: ProviderRegistry;
}

export function build(
  options: {
    readonly known?: readonly string[];
    readonly policy?: MfaPolicy;
    readonly sessionPolicy?: SessionPolicy;
    readonly verifier?: StubVerifier;
    readonly verifiers?: readonly Verifier[];
    readonly entropy?: EntropySource;
  } = {},
): Harness {
  const repository = new InMemoryAuthenticationRepository();
  const providers = new ProviderRegistry([
    {
      provider: PROVIDER,
      description: 'A stub provider used by the K-02 suites; verifies nothing in production.',
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    },
  ]);
  const verifier = options.verifier ?? new StubVerifier();
  const subjects = new StubSubjectLookup(options.known ?? [KNOWN_SUBJECT]);
  const clock = new FixedClock();
  const entropy = new SequenceEntropy();

  const service = new AuthenticationService({
    repository,
    providers,
    verifiers: options.verifiers ?? [verifier],
    subjects,
    clock,
    entropy: options.entropy ?? entropy,
    ...(options.sessionPolicy === undefined ? {} : { sessionPolicy: options.sessionPolicy }),
  });

  return { service, repository, verifier, subjects, clock, entropy, providers };
}

let sequence = 0;

export function bindRequest(overrides: Partial<BindRequest> = {}): BindRequest {
  sequence += 1;
  return {
    bindingId: `bind_01HQZX${String(sequence).padStart(4, '0')}`,
    subjectId: KNOWN_SUBJECT,
    provider: PROVIDER,
    providerReference: BINDING_REFERENCE,
    idempotencyKey: `idem_01HQZXB${String(sequence).padStart(4, '0')}`,
    ...overrides,
  };
}

export function authenticateRequest(
  overrides: Partial<AuthenticateRequest> = {},
): AuthenticateRequest {
  sequence += 1;
  return {
    evidenceId: `evid_01HQZX${String(sequence).padStart(4, '0')}`,
    sessionId: `sess_01HQZX${String(sequence).padStart(4, '0')}`,
    provider: PROVIDER,
    providerReference: BINDING_REFERENCE,
    proof: { kind: 'opaque-proof-material' },
    idempotencyKey: `idem_01HQZXA${String(sequence).padStart(4, '0')}`,
    ...overrides,
  };
}

/** Bind, then authenticate. The two-step every session test needs before it starts. */
export async function signIn(
  harness: Harness,
  overrides: Partial<AuthenticateRequest> = {},
): Promise<{ sessionId: string; secret: string }> {
  await harness.service.bind(bindRequest());
  const result = await harness.service.authenticate(authenticateRequest(overrides));
  return { sessionId: result.session.sessionId, secret: result.token.reveal() };
}

/** A stored session row as the adapter's projection returns it. */
export function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'sess_01HQZXTESTROW',
    binding_id: 'bind_01HQZXTESTROW',
    subject_id: 'sub_01HQZXTESTROW',
    evidence_id: 'evid_01HQZXTESTROW',
    assurance: 'single-factor',
    factors: ['possession'],
    token_hash: 'a'.repeat(64),
    issued_at: '2026-04-01T12:00:00.000000Z',
    absolute_expires_at: '2026-04-02T00:00:00.000000Z',
    idle_expires_at: '2026-04-01T12:30:00.000000Z',
    rotation_count: 0,
    revoked_at: null,
    revocation_reason: null,
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}

export function bindingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    binding_id: 'bind_01HQZXTESTROW',
    subject_id: 'sub_01HQZXTESTROW',
    provider: PROVIDER,
    provider_reference: 'ref_01HQZXTESTROW',
    created_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}

export function evidenceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evidence_id: 'evid_01HQZXTESTROW',
    binding_id: 'bind_01HQZXTESTROW',
    subject_id: 'sub_01HQZXTESTROW',
    provider: PROVIDER,
    assertion_id: 'asrt_01HQZXTESTROW',
    factors: ['possession'],
    assurance: 'single-factor',
    verified_at: '2026-04-01T11:59:30.000000Z',
    recorded_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}
