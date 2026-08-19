/**
 * K-02 Authentication — the service (FND-004c).
 *
 * Five operations: bind a subject to a verifier's handle, authenticate, validate a session, rotate
 * its secret, revoke it. The security of the whole component rests on one rule that runs through
 * all five:
 *
 * > **The caller never states an outcome. The verifier does, and its answer is checked.**
 *
 * `authenticate` takes opaque proof material and hands it to the injected verifier. It does not
 * take `authenticated`, `factors` or `assurance` — a request carrying any of those is refused by
 * name, because a component that accepts them is not authenticating anybody; it is formatting
 * whatever its caller already decided.
 *
 * What is checked about the verifier's answer, and why each check exists:
 *
 *   - **provider and reference match what was asked** — otherwise an assertion obtained for one
 *     binding could be presented against another;
 *   - **the assertion has not expired**, by this platform's clock rather than the verifier's — a
 *     verifier with a slow clock must not be able to extend its own assertions;
 *   - **the assertion has not been consumed**, enforced by a uniqueness constraint rather than a
 *     read, because two replays can both pass a read;
 *   - **the confirmed factors satisfy the policy** for that provider, counted by *category*.
 *
 * Sessions carry both an absolute and an idle expiry. Rotation moves the idle one and never the
 * absolute one, so a session cannot live for ever by being used. Rotation and revocation are
 * guarded updates: a caller holding a superseded secret loses rather than overwriting the winner.
 *
 * Deterministic by construction: time comes from an injected `Clock`, session secrets from an
 * injected `EntropySource`, and every identifier and idempotency key from the caller. This
 * component reads no wall clock and calls no random number generator directly.
 *
 * Owned by: K-02 Authentication. No API, no UI, no provider — see CONTRACT.md.
 */

import { addSeconds, compareInstants } from '../../platform/time/instant.ts';

import { sealBinding, sealBindings, sealEvidence, sealFactors, sealSession } from './immutable.ts';
import type { Clock, EntropySource, SubjectLookup, Verifier, VerifierAssertion } from './ports.ts';
import {
  ASSERTED_AUTHENTICATION_FIELDS,
  FOREIGN_FIELDS,
  assertAuthIdentifier,
  satisfiesPolicy,
  type ProviderRegistry,
} from './registry.ts';
import type { AuthenticationRepository, AuthenticationTransaction } from './repository.ts';
import { SessionToken, hashToken, hashesEqual } from './tokens.ts';
import {
  AuthenticationError,
  REVOCATION_REASONS,
  type AuthenticationBinding,
  type AuthenticationEvidence,
  type AuthenticationSession,
  type FactorCategory,
  type RevocationReason,
} from './types.ts';
import { validateBinding, validateEvidence, validateSession } from './validate.ts';

/** How long a session lives, and how long it may sit un-rotated. */
export interface SessionPolicy {
  /** The hard stop, in seconds from issue. Rotation never extends it. */
  readonly absoluteLifetimeSeconds: number;
  /** How long a session may go without rotation before it stops being usable. */
  readonly idleTimeoutSeconds: number;
}

/**
 * Twelve hours absolute, thirty minutes idle.
 *
 * Short, because this component has no recovery flow: if these turn out to be wrong the cost is
 * that people sign in again, which is the failure everybody prefers.
 */
export const DEFAULT_SESSION_POLICY: SessionPolicy = Object.freeze({
  absoluteLifetimeSeconds: 12 * 60 * 60,
  idleTimeoutSeconds: 30 * 60,
});

export interface BindRequest {
  readonly bindingId: string;
  readonly subjectId: string;
  readonly provider: string;
  readonly providerReference: string;
  readonly idempotencyKey: string;
}

export interface AuthenticateRequest {
  readonly evidenceId: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly providerReference: string;
  /** Opaque proof material, handed straight to the verifier and never stored. */
  readonly proof: unknown;
  readonly idempotencyKey: string;
}

export interface AuthenticateResult {
  readonly session: AuthenticationSession;
  readonly evidence: AuthenticationEvidence;
  /** Presented once. `reveal()` works a single time; see tokens.ts. */
  readonly token: SessionToken;
  readonly deduplicated: boolean;
}

export interface RotateRequest {
  readonly sessionId: string;
  /** The secret the caller currently holds. Hashed here; never stored or echoed. */
  readonly presentedToken: string;
}

export interface RotateResult {
  readonly session: AuthenticationSession;
  readonly token: SessionToken;
}

export interface RevokeRequest {
  readonly sessionId: string;
  readonly reason: RevocationReason;
}

const BIND_KEYS: readonly string[] = [
  'bindingId',
  'subjectId',
  'provider',
  'providerReference',
  'idempotencyKey',
];

const AUTHENTICATE_KEYS: readonly string[] = [
  'evidenceId',
  'sessionId',
  'provider',
  'providerReference',
  'proof',
  'idempotencyKey',
];

export class AuthenticationService {
  readonly #repository: AuthenticationRepository;
  readonly #providers: ProviderRegistry;
  readonly #verifiers: ReadonlyMap<string, Verifier>;
  readonly #subjects: SubjectLookup;
  readonly #clock: Clock;
  readonly #entropy: EntropySource;
  readonly #sessionPolicy: SessionPolicy;

  constructor(options: {
    readonly repository: AuthenticationRepository;
    readonly providers: ProviderRegistry;
    /** One verifier per registered provider. A provider with no verifier cannot authenticate. */
    readonly verifiers: readonly Verifier[];
    readonly subjects: SubjectLookup;
    readonly clock: Clock;
    readonly entropy: EntropySource;
    readonly sessionPolicy?: SessionPolicy;
  }) {
    this.#repository = options.repository;
    this.#providers = options.providers;
    this.#subjects = options.subjects;
    this.#clock = options.clock;
    this.#entropy = options.entropy;
    this.#sessionPolicy = Object.freeze({ ...(options.sessionPolicy ?? DEFAULT_SESSION_POLICY) });
    assertSessionPolicy(this.#sessionPolicy);

    const verifiers = new Map<string, Verifier>();
    for (const verifier of options.verifiers) {
      // A verifier for an unregistered provider is a wiring mistake that would otherwise sit
      // dormant until somebody registered the provider and silently inherited it.
      this.#providers.requireProvider(verifier.provider);
      if (verifiers.has(verifier.provider)) {
        throw new AuthenticationError(
          'unknown-provider',
          `two verifiers are wired for provider "${verifier.provider}"; which one authenticates ` +
            'would be decided by array order',
        );
      }
      verifiers.set(verifier.provider, verifier);
    }
    this.#verifiers = verifiers;
  }

  /**
   * Link a K-01 subject to the opaque handle a verifier knows it by.
   *
   * No secret is involved, and none is accepted. The binding is what lets a later assertion be
   * attributed to a subject; it proves nothing on its own.
   */
  async bind(
    request: BindRequest,
  ): Promise<{ binding: AuthenticationBinding; deduplicated: boolean }> {
    assertPermittedKeys(request, BIND_KEYS, 'a bind request');
    this.#providers.requireProvider((request as { provider?: unknown }).provider);

    const binding = sealBinding(
      validateBinding(
        {
          bindingId: request.bindingId,
          subjectId: request.subjectId,
          provider: request.provider,
          providerReference: request.providerReference,
          createdAt: this.#now(),
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    if (!(await this.#subjects.exists(binding.subjectId))) {
      throw new AuthenticationError(
        'unknown-subject',
        `no identity subject ${binding.subjectId}. A binding authenticates a party K-01 has ` +
          'already recorded; creating one here would invent a party to authenticate',
      );
    }

    try {
      return await this.#repository.withTransaction(async (tx) => {
        const existing = await tx.findBindingByIdempotencyKey(binding.idempotencyKey);
        if (existing !== null) {
          assertSameBinding(existing, binding);
          return { binding: sealBinding(existing), deduplicated: true };
        }
        await tx.insertBinding(binding);
        return { binding, deduplicated: false };
      });
    } catch (error) {
      const converged = await this.#converge(
        error,
        ['duplicate-binding', 'idempotency-key-reuse'],
        () =>
          this.#repository.withTransaction((tx) =>
            tx.findBindingByIdempotencyKey(binding.idempotencyKey),
          ),
      );
      if (converged === null) throw error;
      if (differencesBetweenBindings(converged, binding).length > 0) throw error;
      return { binding: sealBinding(converged), deduplicated: true };
    }
  }

  /**
   * Authenticate a subject through its verifier, and issue a session.
   *
   * The order is load-bearing. Shape and forbidden fields first, so a request that asserts an
   * outcome never reaches anything. Then the provider, the binding and the subject, so a verifier
   * is only troubled for a party that exists. Only then the verifier, whose answer is checked
   * against what was asked before anything is written.
   *
   * A retry is recognised twice, because it can arrive at two different moments:
   *
   *   - **before the verifier**, when the first call has already committed. The proof is not
   *     re-presented, because an assertion is consumed once and a caller retrying after a timeout
   *     must not be told it attacked the platform;
   *   - **after the write is refused**, when the two calls overlapped and the other one won. The
   *     conflict surfaces as whichever uniqueness constraint the store happened to select, which
   *     is not something a caller can be asked to interpret.
   *
   * Both converge through the same complete comparison (`convergenceFailures`), and both hand back
   * a **spent** token: the secret was presented once, to the call that actually authenticated.
   * Converging on anything less than a complete match is how a caller ends up holding a session
   * for a request it did not make, so anything short of it keeps the refusal it already had.
   */
  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResult> {
    assertPermittedKeys(request, AUTHENTICATE_KEYS, 'an authenticate request');
    const { policy } = this.#providers.requireProvider(
      (request as { provider?: unknown }).provider,
    );

    const provider = request.provider;
    const providerReference = assertAuthIdentifier(request.providerReference, 'providerReference');
    const evidenceId = assertAuthIdentifier(request.evidenceId, 'evidenceId');
    const sessionId = assertAuthIdentifier(request.sessionId, 'sessionId');
    const idempotencyKey = assertAuthIdentifier(request.idempotencyKey, 'idempotencyKey');

    const claim: AuthenticationClaim = {
      evidenceId,
      sessionId,
      provider,
      providerReference,
      idempotencyKey,
    };

    // An identical retry must not re-present the proof to the verifier: assertions are consumed
    // once, so a second presentation would be refused as a replay and a caller retrying after a
    // timeout would be told it had attacked the platform.
    const alreadyDone = await this.#findAuthentication(idempotencyKey);
    if (alreadyDone !== null) return this.#convergedAuthentication(alreadyDone, claim);

    const binding = await this.#repository.withTransaction((tx) =>
      tx.findBindingByReference(provider, providerReference),
    );
    if (binding === null) {
      throw new AuthenticationError(
        'unknown-binding',
        `no binding for reference on provider ${provider}. Nothing links that handle to a ` +
          'subject, so a successful proof would authenticate nobody in particular',
      );
    }
    if (!(await this.#subjects.exists(binding.subjectId))) {
      throw new AuthenticationError(
        'unknown-subject',
        `binding ${binding.bindingId} names subject ${binding.subjectId}, which K-01 does not ` +
          'have. Refusing rather than issuing a session for a party that does not exist',
      );
    }

    const assertion = await this.#verify(provider, providerReference, request.proof);
    const now = this.#now();
    assertAssertionUsable(assertion, provider, providerReference, now);

    const factors = sealFactors(assertion.factors);
    if (!satisfiesPolicy(factors, assertion.assurance, policy)) {
      throw new AuthenticationError(
        'insufficient-factors',
        `provider ${provider} requires at least ${policy.minimumFactorCategories} factor ` +
          `categor${policy.minimumFactorCategories === 1 ? 'y' : 'ies'} at ` +
          `${policy.minimumAssurance}; the verifier confirmed ${new Set(factors).size} ` +
          `(${factors.join(', ')}) at ${assertion.assurance}`,
      );
    }

    const evidence = sealEvidence(
      validateEvidence(
        {
          evidenceId,
          bindingId: binding.bindingId,
          subjectId: binding.subjectId,
          provider,
          assertionId: assertion.assertionId,
          factors,
          assurance: assertion.assurance,
          verifiedAt: assertion.verifiedAt,
          recordedAt: now,
          idempotencyKey,
        },
        'request',
      ),
    );

    const secret = this.#entropy.token();
    const token = new SessionToken(secret);
    const session = sealSession(
      validateSession(
        {
          sessionId,
          bindingId: binding.bindingId,
          subjectId: binding.subjectId,
          evidenceId,
          assurance: assertion.assurance,
          factors,
          tokenHash: hashToken(secret),
          issuedAt: now,
          absoluteExpiresAt: addSeconds(now, this.#sessionPolicy.absoluteLifetimeSeconds),
          idleExpiresAt: addSeconds(now, this.#sessionPolicy.idleTimeoutSeconds),
          rotationCount: 0,
          revokedAt: null,
          revocationReason: null,
          idempotencyKey,
        },
        'request',
      ),
    );

    // Evidence and session in one transaction. An evidence row with no session would consume the
    // assertion and hand back nothing; a session with no evidence would be a session nobody can
    // account for.
    try {
      await this.#repository.withTransaction(async (tx) => {
        await tx.insertEvidence(evidence);
        await tx.insertSession(session);
      });
    } catch (error) {
      // The other half of an overlapping identical call may have committed between the read above
      // and this write. Which constraint refused us — evidence id, assertion, either idempotency
      // key, session id, token hash — is the store's choice and carries no meaning for the caller,
      // so every one of them is offered the same recovery and the same complete comparison.
      const converged = await this.#recoverFromConflict(error, claim);
      if (converged === null) throw error;
      return converged;
    }

    return { session, evidence, token, deduplicated: false };
  }

  /**
   * Is this session secret good, and what does it authenticate?
   *
   * Read-only and deterministic. Idle expiry is **not** extended here — a validation that wrote
   * would make every read a write, and "idle" in this component means "not rotated" rather than
   * "not read". `rotate` is the operation that keeps a session alive, and it says so by name.
   */
  async validate(presentedToken: string): Promise<AuthenticationSession> {
    const hash = hashOfPresented(presentedToken);
    const session = await this.#repository.withTransaction((tx: AuthenticationTransaction) =>
      tx.findSessionByTokenHash(hash),
    );
    if (session === null || !hashesEqual(session.tokenHash, hash)) {
      // One refusal for "no such session" and "wrong secret", deliberately. Distinguishing them
      // tells an attacker which session ids exist.
      throw new AuthenticationError(
        'invalid-token',
        'the presented session secret does not match a live session',
      );
    }
    this.#assertLive(session);
    return sealSession(session);
  }

  /**
   * Replace a session's secret, extending the idle window but never the absolute one.
   *
   * The guard is the current hash: a caller presenting a secret that has already been rotated away
   * loses, and is told so rather than having its stale value written over the winner's.
   */
  async rotate(request: RotateRequest): Promise<RotateResult> {
    const sessionId = assertAuthIdentifier(request.sessionId, 'sessionId');
    const presentedHash = hashOfPresented(request.presentedToken);

    const current = await this.#repository.withTransaction((tx) => tx.findSessionById(sessionId));
    if (current === null) {
      throw new AuthenticationError('no-such-session', `no session ${sessionId}`);
    }
    if (!hashesEqual(current.tokenHash, presentedHash)) {
      throw new AuthenticationError(
        'invalid-token',
        `the presented secret is not the current secret for session ${sessionId}. It may already ` +
          'have been rotated away, in which case the rotation that replaced it won',
      );
    }
    this.#assertLive(current);

    const now = this.#now();
    const secret = this.#entropy.token();
    const token = new SessionToken(secret);
    const nextHash = hashToken(secret);

    const rotated = await this.#repository.withTransaction((tx) =>
      tx.rotateSession({
        sessionId,
        expectedTokenHash: presentedHash,
        nextTokenHash: nextHash,
        // Never `absoluteExpiresAt`. Extending it here is how a session lives for ever.
        nextIdleExpiresAt: this.#cappedIdle(now, current.absoluteExpiresAt),
        nextRotationCount: current.rotationCount + 1,
      }),
    );

    if (!rotated) {
      throw new AuthenticationError(
        'stale-session-state',
        `session ${sessionId} changed while this rotation was in flight — another rotation or a ` +
          'revocation got there first. The secret this caller holds is no longer current, and ' +
          'writing over the winner would hand two callers a live session',
      );
    }

    const next = await this.#repository.withTransaction((tx) => tx.findSessionById(sessionId));
    if (next === null) {
      throw new AuthenticationError(
        'no-such-session',
        `session ${sessionId} vanished mid-rotation`,
      );
    }
    return { session: sealSession(next), token };
  }

  /**
   * End a session explicitly.
   *
   * Revoking an already-revoked session converges on the existing revocation rather than failing:
   * signing out twice is not an error, and the first revocation is the one that counts.
   */
  async revoke(request: RevokeRequest): Promise<AuthenticationSession> {
    const sessionId = assertAuthIdentifier(request.sessionId, 'sessionId');
    if (!(REVOCATION_REASONS as readonly string[]).includes(request.reason)) {
      throw new AuthenticationError(
        'malformed-record',
        `revocation reason "${String(request.reason)}" is not one of ` +
          REVOCATION_REASONS.join(', '),
      );
    }

    const existing = await this.#repository.withTransaction((tx) => tx.findSessionById(sessionId));
    if (existing === null) {
      throw new AuthenticationError('no-such-session', `no session ${sessionId}`);
    }

    await this.#repository.withTransaction((tx) =>
      tx.revokeSession({ sessionId, revokedAt: this.#now(), reason: request.reason }),
    );

    const after = await this.#repository.withTransaction((tx) => tx.findSessionById(sessionId));
    if (after === null || after.revokedAt === null) {
      throw new AuthenticationError(
        'stale-session-state',
        `session ${sessionId} is not revoked after a revocation was applied`,
      );
    }
    return sealSession(after);
  }

  /** One session, by id, or null. Never returns or reconstructs a secret. */
  async findSession(sessionId: string): Promise<AuthenticationSession | null> {
    assertAuthIdentifier(sessionId, 'sessionId');
    const session = await this.#repository.withTransaction((tx) => tx.findSessionById(sessionId));
    return session === null ? null : sealSession(session);
  }

  /** Every binding a subject authenticates through. Useful to a future account-security screen. */
  async bindingsForSubject(subjectId: string): Promise<readonly AuthenticationBinding[]> {
    assertAuthIdentifier(subjectId, 'subjectId');
    const bindings = await this.#repository.withTransaction((tx) =>
      tx.listBindingsForSubject(subjectId),
    );
    return sealBindings(bindings);
  }

  // -------------------------------------------------------------------------

  #now(): string {
    const now = this.#clock.now();
    if (typeof now !== 'string') {
      throw new AuthenticationError(
        'malformed-instant',
        `the injected clock returned ${typeof now} rather than a UTC instant string`,
      );
    }
    return now;
  }

  /** The idle window, never past the absolute stop. */
  #cappedIdle(now: string, absoluteExpiresAt: string): string {
    const idle = addSeconds(now, this.#sessionPolicy.idleTimeoutSeconds);
    return compareInstants(idle, absoluteExpiresAt) > 0 ? absoluteExpiresAt : idle;
  }

  /**
   * Hand the proof to the verifier, and normalise whatever comes back.
   *
   * A verifier that throws has refused. The thrown value is **not** inspected, interpolated or
   * re-raised — a provider's error object is exactly the sort of thing that carries a fragment of
   * the proof in its message, and this component's whole value is that such fragments do not travel.
   */
  async #verify(provider: string, providerReference: string, proof: unknown) {
    const verifier = this.#verifiers.get(provider);
    if (verifier === undefined) {
      throw new AuthenticationError(
        'unknown-provider',
        `provider ${provider} is registered but has no verifier wired. Refusing rather than ` +
          'treating an unverifiable proof as verified',
      );
    }

    try {
      return await verifier.verify({ provider, providerReference, proof });
    } catch {
      throw new AuthenticationError(
        'invalid-assertion',
        `the verifier for ${provider} refused the proof. Its reason is deliberately not repeated ` +
          'here: a provider error can carry proof material, and this component exists so that ' +
          'such material does not travel',
      );
    }
  }

  #assertLive(session: AuthenticationSession): void {
    if (session.revokedAt !== null) {
      throw new AuthenticationError(
        'session-revoked',
        `session ${session.sessionId} was revoked at ${session.revokedAt} ` +
          `(${String(session.revocationReason)})`,
      );
    }
    const now = this.#now();
    if (compareInstants(now, session.absoluteExpiresAt) >= 0) {
      throw new AuthenticationError(
        'session-expired',
        `session ${session.sessionId} passed its absolute expiry at ${session.absoluteExpiresAt}`,
      );
    }
    if (compareInstants(now, session.idleExpiresAt) >= 0) {
      throw new AuthenticationError(
        'session-expired',
        `session ${session.sessionId} passed its idle expiry at ${session.idleExpiresAt}. It has ` +
          'not been rotated within the idle window',
      );
    }
  }

  /** Re-read after a uniqueness conflict, or `null` when the conflict was not a race. */
  async #converge<T>(
    error: unknown,
    codes: readonly AuthenticationError['code'][],
    reread: () => Promise<T | null>,
  ): Promise<T | null> {
    if (!(error instanceof AuthenticationError) || !codes.includes(error.code)) return null;
    return reread();
  }

  /**
   * Everything recorded under one idempotency key, read together.
   *
   * The binding is read too, and it is not decoration: evidence records a provider but never a
   * provider reference, so without the binding a key reused against a *different handle on the
   * same provider* compares equal on every field there is and converges. The reference is the
   * thing that says which account was authenticated, so it has to be in the comparison, and the
   * only place it lives is the binding.
   *
   * One transaction, so the three records cannot be read across a commit that lands between them.
   */
  #findAuthentication(idempotencyKey: string): Promise<PersistedAuthentication | null> {
    return this.#repository.withTransaction(async (tx) => {
      const evidence = await tx.findEvidenceByIdempotencyKey(idempotencyKey);
      if (evidence === null) return null;
      const session = await tx.findSessionByIdempotencyKey(idempotencyKey);
      const binding = await tx.findBindingById(evidence.bindingId);
      return { binding, evidence, session };
    });
  }

  /**
   * A write refused by a uniqueness constraint: was it the other half of this same call?
   *
   * Returns the converged result when what is now stored under this idempotency key is completely
   * and coherently the request that was just made, and `null` otherwise — and `null` means the
   * caller keeps the refusal it already had. That is the important half. A replay presented under
   * a fresh idempotency key finds nothing to converge on and stays `assertion-replayed`; a token
   * hash collision between two unrelated sessions stays `insufficient-entropy`; a half-written
   * authentication with evidence and no session converges on nothing and stays refused. Recovery
   * that guessed here would turn a replay into a session.
   */
  async #recoverFromConflict(
    error: unknown,
    claim: AuthenticationClaim,
  ): Promise<AuthenticateResult | null> {
    const found = await this.#converge(error, CONVERGEABLE_CONFLICTS, () =>
      this.#findAuthentication(claim.idempotencyKey),
    );
    if (found === null || found.session === null) return null;
    if (convergenceFailures(found, claim).length > 0) return null;
    return convergedResult(found.evidence, found.session);
  }

  /**
   * A retry that has already succeeded.
   *
   * Returns the original session and evidence, and **no token**: the secret was presented once, to
   * the call that actually authenticated. A retry that received a fresh secret would be minting a
   * second live session for one authentication.
   *
   * Unlike `#recoverFromConflict` this one throws on a mismatch rather than returning null, because
   * here there is no earlier refusal to preserve: the key names an authentication that is not the
   * one being asked for, and that is `idempotency-key-reuse` however it is reached.
   */
  #convergedAuthentication(
    found: PersistedAuthentication,
    claim: AuthenticationClaim,
  ): AuthenticateResult {
    const failures = convergenceFailures(found, claim);
    if (failures.length > 0 || found.session === null) {
      throw new AuthenticationError(
        'idempotency-key-reuse',
        `idempotency key "${claim.idempotencyKey}" was already used for a different ` +
          `authentication (${failures.join(', ')}). Returning the earlier one would hand back a ` +
          'session for something the caller did not ask for',
      );
    }
    return convergedResult(found.evidence, found.session);
  }
}

// ---------------------------------------------------------------------------

/**
 * The complete non-secret logical request, and the only thing a converged retry may match against.
 *
 * Complete is the operative word. Every field a caller supplies that identifies *what* was
 * authenticated is here; the proof is not, because it is never stored and comparing it would mean
 * storing it.
 */
interface AuthenticationClaim {
  readonly evidenceId: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly providerReference: string;
  readonly idempotencyKey: string;
}

/** What is recorded under one idempotency key, plus the binding the evidence hangs off. */
interface PersistedAuthentication {
  readonly binding: AuthenticationBinding | null;
  readonly evidence: AuthenticationEvidence;
  readonly session: AuthenticationSession | null;
}

/**
 * The refusals an overlapping identical authentication can arrive as.
 *
 * Six unique constraints can refuse the evidence-and-session write — evidence id, `(provider,
 * assertionId)`, evidence idempotency key, session id, token hash, session idempotency key — and
 * which one the database reports is its own business: with two rows conflicting on all of them it
 * reports whichever index it checked first. So the recovery cannot be keyed on one of them. It is
 * offered to every code they normalise to, and what decides the outcome is the comparison, not the
 * code.
 */
const CONVERGEABLE_CONFLICTS: readonly AuthenticationError['code'][] = [
  'idempotency-key-reuse',
  'assertion-replayed',
  'malformed-record',
  'insufficient-entropy',
];

/**
 * Everything that must hold before what is stored may be handed back as this caller's own.
 *
 * Two questions, and both have to be answered: does the stored authentication match the request
 * **completely**, and do the three records agree with **each other**? The first stops a key reused
 * for another authentication from returning a session the caller never asked for. The second stops
 * a partially written or repointed set of rows — evidence naming one binding, a session naming
 * another — from being read as a coherent authentication, which matters because convergence is
 * exactly the path taken when something has already gone wrong.
 *
 * The second question is asked of **every fact the two records duplicate**, not only of the
 * identifiers. A session carries its own copy of the assurance and the factor categories, and that
 * copy is the one `validate` hands to a caller deciding what this session is allowed to do — so a
 * session claiming `multi-factor` over evidence that recorded `single-factor` is a privilege
 * escalation sitting in two rows that are each individually well formed. Nothing in the record
 * shapes can catch it: `validateEvidence` and `validateSession` see one row at a time, and each
 * row is valid. It is only a lie when the two are read together, which is here.
 *
 * Chronology is checked for the same reason. A session issued before the proof was verified, or
 * before the evidence that accounts for it was recorded, describes an authentication that did not
 * happen in that order — and this component's own writer cannot produce it, because both instants
 * come from one reading of the injected clock.
 *
 * Returns the reasons rather than a boolean: a refusal that cannot say which field disagreed is a
 * refusal nobody can act on.
 */
function convergenceFailures(
  found: PersistedAuthentication,
  claim: AuthenticationClaim,
): readonly string[] {
  const { binding, evidence, session } = found;
  const failures: string[] = [];

  if (evidence.evidenceId !== claim.evidenceId) failures.push('evidenceId');
  if (evidence.provider !== claim.provider) failures.push('provider');
  if (evidence.idempotencyKey !== claim.idempotencyKey) {
    failures.push('the evidence idempotency key');
  }
  if (compareInstants(evidence.recordedAt, evidence.verifiedAt) < 0) {
    failures.push('the evidence was recorded before it was verified');
  }

  if (session === null) {
    failures.push('no session was recorded under it');
  } else {
    if (session.sessionId !== claim.sessionId) failures.push('sessionId');
    if (session.idempotencyKey !== claim.idempotencyKey) {
      failures.push('the session idempotency key');
    }
    if (session.evidenceId !== evidence.evidenceId) {
      failures.push('the session names other evidence');
    }
    if (session.bindingId !== evidence.bindingId) {
      failures.push('the session and the evidence disagree about the binding');
    }
    if (session.subjectId !== evidence.subjectId) {
      failures.push('the session and the evidence disagree about the subject');
    }
    // The assurance and the factors are the authentication's *strength*, copied onto the session
    // because that is where a caller reads it. Two copies, so two chances to disagree.
    if (session.assurance !== evidence.assurance) {
      failures.push('the session and the evidence disagree about the assurance');
    }
    if (!sameFactorSet(session.factors, evidence.factors)) {
      failures.push('the session and the evidence disagree about the factors');
    }
    if (compareInstants(session.issuedAt, evidence.verifiedAt) < 0) {
      failures.push('the session was issued before the proof was verified');
    }
    if (compareInstants(session.issuedAt, evidence.recordedAt) < 0) {
      failures.push('the session was issued before the evidence that accounts for it');
    }
  }

  if (binding === null) {
    failures.push('the binding it was recorded against is gone');
  } else {
    if (binding.bindingId !== evidence.bindingId) {
      failures.push('the binding it names is another one');
    }
    if (binding.provider !== claim.provider) failures.push('the binding names another provider');
    if (binding.providerReference !== claim.providerReference) failures.push('providerReference');
    if (binding.subjectId !== evidence.subjectId) {
      failures.push('the binding and the evidence disagree about the subject');
    }
  }

  return failures;
}

/**
 * The same categories, however either list happens to be ordered.
 *
 * Compared as the canonical set rather than as arrays, because `['possession','knowledge']` and
 * `['knowledge','possession']` are one authentication and a comparison that called them different
 * would refuse a legitimate retry. `sealFactors` is the canonical form the rest of the component
 * already uses, so this cannot drift from it.
 */
function sameFactorSet(left: readonly FactorCategory[], right: readonly FactorCategory[]): boolean {
  return sealFactors(left).join(',') === sealFactors(right).join(',');
}

/** The answer a converged caller gets: the original records, and a secret it cannot have. */
function convergedResult(
  evidence: AuthenticationEvidence,
  session: AuthenticationSession,
): AuthenticateResult {
  return {
    session: sealSession(session),
    evidence: sealEvidence(evidence),
    // Already revealed, so `reveal()` throws. The retry gets the session, never a second secret.
    token: spentToken(),
    deduplicated: true,
  };
}

/** A token that has already been presented. Its `reveal()` throws, which is the honest answer. */
function spentToken(): SessionToken {
  const token = new SessionToken('x'.repeat(43));
  token.reveal();
  return token;
}

function hashOfPresented(presented: unknown): string {
  if (typeof presented !== 'string' || presented === '') {
    // Note what is *not* in this message: the value. A refusal that echoes a presented secret
    // puts it in every log that captured the error.
    throw new AuthenticationError(
      'invalid-token',
      'no session secret was presented, or it was not a string',
    );
  }
  try {
    return hashToken(presented);
  } catch {
    throw new AuthenticationError(
      'invalid-token',
      'the presented session secret is not the shape this component issues',
    );
  }
}

/**
 * Refuse a request that asserts an authentication outcome, or carries another component's concern.
 *
 * The first half is the security check. The second is the tidiness one. Both refuse rather than
 * ignore, because a silently dropped `assurance` would leave the caller believing it had set one.
 */
function assertPermittedKeys(request: unknown, permitted: readonly string[], what: string): void {
  if (request === null || typeof request !== 'object') {
    throw new AuthenticationError(
      'malformed-record',
      `${what} must be an object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const asserted = ASSERTED_AUTHENTICATION_FIELDS[key];
    if (asserted !== undefined) {
      throw new AuthenticationError(
        'caller-asserted-authentication',
        `${what} carried "${key}", but ${asserted}. This component authenticates by asking a ` +
          'verifier and checking the answer; a caller that could state the outcome would make ' +
          'every other guarantee here decorative',
      );
    }

    const foreign = FOREIGN_FIELDS[key];
    if (foreign !== undefined) {
      throw new AuthenticationError('foreign-concern', `${what} carried "${key}", but ${foreign}`);
    }

    throw new AuthenticationError(
      'foreign-concern',
      `${what} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

/** Everything checked about a verifier's answer before a byte of it is written. */
function assertAssertionUsable(
  assertion: VerifierAssertion,
  provider: string,
  providerReference: string,
  now: string,
): void {
  if (assertion === null || typeof assertion !== 'object') {
    throw new AuthenticationError(
      'invalid-assertion',
      `the verifier for ${provider} returned ${assertion === null ? 'null' : typeof assertion} ` +
        'rather than an assertion',
    );
  }
  if (assertion.provider !== provider) {
    throw new AuthenticationError(
      'invalid-assertion',
      `the verifier for ${provider} returned an assertion for "${String(assertion.provider)}". ` +
        'An assertion obtained from one provider must not authenticate through another',
    );
  }
  if (assertion.providerReference !== providerReference) {
    throw new AuthenticationError(
      'invalid-assertion',
      'the verifier returned an assertion for a different reference than the one presented. That ' +
        'is how an assertion for one account would authenticate another',
    );
  }

  const verifiedAt = requireInstant(assertion.verifiedAt, 'assertion.verifiedAt');
  const expiresAt = requireInstant(assertion.expiresAt, 'assertion.expiresAt');
  if (compareInstants(expiresAt, verifiedAt) <= 0) {
    throw new AuthenticationError(
      'invalid-assertion',
      `the assertion expires at ${expiresAt}, which is not after it was verified at ${verifiedAt}`,
    );
  }
  if (compareInstants(now, expiresAt) >= 0) {
    // Judged by this platform's clock, not the verifier's. A verifier with a slow clock must not
    // be able to extend the life of its own assertions.
    throw new AuthenticationError(
      'assertion-expired',
      `the assertion expired at ${expiresAt} and it is now ${now}. Assertions are short-lived so ` +
        'that one captured in transit stops being useful quickly',
    );
  }
}

function requireInstant(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new AuthenticationError(
      'invalid-assertion',
      `${field} is ${value === null ? 'null' : typeof value}; expected a UTC instant string`,
    );
  }
  return value;
}

function assertSessionPolicy(policy: SessionPolicy): void {
  for (const [field, value] of [
    ['absoluteLifetimeSeconds', policy.absoluteLifetimeSeconds],
    ['idleTimeoutSeconds', policy.idleTimeoutSeconds],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new AuthenticationError(
        'malformed-record',
        `session policy ${field} is ${String(value)}; expected a positive whole number of seconds`,
      );
    }
  }
  if (policy.idleTimeoutSeconds > policy.absoluteLifetimeSeconds) {
    throw new AuthenticationError(
      'malformed-record',
      `the idle timeout (${policy.idleTimeoutSeconds}s) is longer than the absolute lifetime ` +
        `(${policy.absoluteLifetimeSeconds}s), so it would never apply. Somebody meant something ` +
        'else, and guessing which would be worse than refusing',
    );
  }
}

function differencesBetweenBindings(
  existing: AuthenticationBinding,
  incoming: AuthenticationBinding,
): readonly string[] {
  const differences: string[] = [];
  for (const field of ['bindingId', 'subjectId', 'provider', 'providerReference'] as const) {
    if (existing[field] !== incoming[field]) differences.push(field);
  }
  return differences;
}

function assertSameBinding(existing: AuthenticationBinding, incoming: AuthenticationBinding): void {
  const differences = differencesBetweenBindings(existing, incoming);
  if (differences.length === 0) return;
  throw new AuthenticationError(
    'idempotency-key-reuse',
    `idempotency key "${incoming.idempotencyKey}" was already used for a different binding ` +
      `(${differences.join(', ')}). Returning the earlier one would tell the caller it had bound ` +
      'a subject it never named',
  );
}
