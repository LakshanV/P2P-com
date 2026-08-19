/**
 * K-02 Authentication — domain types (FND-004c).
 *
 * This component answers one question: **is the party making this request the K-01 subject it
 * claims to be, and how strongly do we know that?** It answers it by *asking a verifier*, never by
 * believing a caller.
 *
 * That distinction is the whole design. Every other component in this repository so far has taken
 * an `origin` from its caller and recorded it honestly as unverified, because there was nothing to
 * verify it with. K-02 is the thing that verifies, so it must not have the same shape: a request
 * that says "this subject is authenticated" is refused by name, because a component that accepts
 * such a claim is not an authentication component — it is a formatting layer in front of whoever
 * calls it.
 *
 * Three record types, and the split matters:
 *
 *   - **Binding.** An opaque, immutable link between a K-01 subject and a `(provider, reference)`
 *     pair the verifier knows it by. It carries **no secret** — no password hash, no key, no
 *     recovery code. The reference is whatever opaque handle the provider issues; if it looks like
 *     an email address it is refused, because a binding table full of email addresses is a personal
 *     data store that nobody declared.
 *   - **Evidence.** A write-once record of one successful authentication: which verifier, which
 *     factor categories, what assurance, when. Append-only, exactly as K-09 audit records are, and
 *     for the same reason — evidence that can be edited is not evidence.
 *   - **Session.** A short-lived bearer of that authentication, with absolute and idle expiry,
 *     rotation and explicit revocation. The session secret is presented **once** and stored only as
 *     a hash.
 *
 * What is deliberately absent: passwords, OAuth SDKs, email or SMS delivery, recovery flows,
 * registration, permissions, profiles and capabilities. Each belongs to a provider adapter, to K-04,
 * or to work that has not been scheduled. See CONTRACT.md §8.
 *
 * Owned by: K-02 Authentication.
 */

/**
 * The three classic factor categories, and nothing about how any of them is implemented.
 *
 * Provider-neutral on purpose: a password is `knowledge`, a TOTP code or a passkey is `possession`,
 * a fingerprint is `inherence`. K-02 never learns which, because knowing would mean holding
 * something about how the proof works — and the moment it holds that, it is on the way to holding
 * the proof itself.
 *
 * Categories rather than mechanisms is also what makes "multi-factor" mean anything. Two passwords
 * are not two factors; two *categories* are.
 */
export const FACTOR_CATEGORIES = ['knowledge', 'possession', 'inherence'] as const;
export type FactorCategory = (typeof FACTOR_CATEGORIES)[number];

/**
 * How strongly the authentication is believed, ordered weakest first.
 *
 * Ordered, because a policy says "at least this" and an unordered set cannot express that.
 * `ASSURANCE_RANK` is the ordering, and it is exported so a caller can compare without
 * reimplementing it.
 */
export const ASSURANCE_LEVELS = ['single-factor', 'multi-factor', 'hardware-backed'] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

export const ASSURANCE_RANK: Readonly<Record<AssuranceLevel, number>> = Object.freeze({
  'single-factor': 1,
  'multi-factor': 2,
  'hardware-backed': 3,
});

/** Why a session stopped being usable. Recorded so a later reader can tell the cases apart. */
export const REVOCATION_REASONS = [
  'signed-out',
  'rotated-out',
  'operator-revoked',
  'security-event',
] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

/**
 * An opaque link between a K-01 subject and the handle a verifier knows it by.
 *
 * Immutable. A binding that could be repointed at another subject would silently transfer every
 * future authentication — and every session already issued under it — to a different party.
 */
export interface AuthenticationBinding {
  /** Caller-supplied opaque handle. Never a natural key. */
  readonly bindingId: string;
  /** The K-01 subject this binding authenticates. Fixed at creation. */
  readonly subjectId: string;
  /** Which registered verifier owns it. */
  readonly provider: string;
  /**
   * The opaque reference the provider knows the subject by.
   *
   * Never an email address, telephone number or any other natural key — see registry.ts. Whatever
   * the provider's own user handle is, it must be opaque before it reaches this table.
   */
  readonly providerReference: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
}

/**
 * Write-once evidence that one authentication succeeded.
 *
 * The `assertionId` is what makes replay detectable: a verifier assertion is consumed exactly once,
 * and the uniqueness of this column is what enforces it. Presenting the same assertion twice is a
 * replay whether the second presentation is an attack or a confused retry, and both are refused —
 * a retry has an idempotency key and is recognised by that instead.
 */
export interface AuthenticationEvidence {
  readonly evidenceId: string;
  readonly bindingId: string;
  readonly subjectId: string;
  readonly provider: string;
  /** The verifier's own identifier for this assertion. Consumed once, ever. */
  readonly assertionId: string;
  /** Which categories the verifier says it checked. Sorted, so equal sets compare equal. */
  readonly factors: readonly FactorCategory[];
  readonly assurance: AssuranceLevel;
  /** When the verifier says it verified. Its clock, recorded as stated. */
  readonly verifiedAt: string;
  /** When this component recorded it. This platform's clock, from the injected port. */
  readonly recordedAt: string;
  readonly idempotencyKey: string;
}

/**
 * A short-lived bearer of an authentication.
 *
 * `tokenHash` is a SHA-256 of the session secret. **The secret itself is never stored, never
 * logged, and never returned twice** — `authenticate` and `rotate` each hand it back exactly once,
 * inside a wrapper that has to be opened deliberately (tokens.ts). A store that held the secret
 * would turn one database read into every live session on the platform.
 */
export interface AuthenticationSession {
  readonly sessionId: string;
  readonly bindingId: string;
  readonly subjectId: string;
  readonly evidenceId: string;
  readonly assurance: AssuranceLevel;
  readonly factors: readonly FactorCategory[];
  /** SHA-256 of the current session secret, lower-case hex. */
  readonly tokenHash: string;
  readonly issuedAt: string;
  /** The hard stop. Rotation never moves it, so a session cannot live for ever by being used. */
  readonly absoluteExpiresAt: string;
  /** The soft stop, moved forward by rotation. Idle means "not rotated", not "not read". */
  readonly idleExpiresAt: string;
  /** How many times the secret has been replaced. Starts at 0. */
  readonly rotationCount: number;
  readonly revokedAt: string | null;
  readonly revocationReason: RevocationReason | null;
  readonly idempotencyKey: string;
}

export type AuthenticationErrorCode =
  /** The subject id names no K-01 subject. */
  | 'unknown-subject'
  /** The provider is not in the registry. */
  | 'unknown-provider'
  /** The binding does not exist, or does not belong to the subject named. */
  | 'unknown-binding'
  /** A binding already exists for this provider and reference. */
  | 'duplicate-binding'
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** An identifier looks like a natural key: an email, a telephone number, a document number. */
  | 'natural-identifier'
  /** Something in the request looks like a credential, a secret or raw proof material. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** The caller claimed an authentication outcome instead of letting the verifier decide. */
  | 'caller-asserted-authentication'
  /** The request carried a field belonging to K-01, K-03, K-04 or a profile. */
  | 'foreign-concern'
  /** AI tried to author an authentication decision. */
  | 'ai-not-permitted'
  /** The verifier's assertion does not match what was asked, or is not usable. */
  | 'invalid-assertion'
  /** This assertion has already been consumed. */
  | 'assertion-replayed'
  /** The verifier's assertion is past its own expiry. */
  | 'assertion-expired'
  /** The factors the verifier confirmed do not meet the configured requirement. */
  | 'insufficient-factors'
  /** The session secret does not match any live session. */
  | 'invalid-token'
  /** The session's absolute or idle expiry has passed. */
  | 'session-expired'
  /** The session was revoked. */
  | 'session-revoked'
  /** A rotation or revocation lost a race and must not be retried blindly. */
  | 'stale-session-state'
  /** The entropy source produced something unusable as a session secret. */
  | 'insufficient-entropy'
  /** The idempotency key was already used for different logical content. */
  | 'idempotency-key-reuse'
  /** Nothing to read. */
  | 'no-such-session'
  /** An enlisted path tried to control a transaction it does not own. */
  | 'nested-transaction'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record';

export class AuthenticationError extends Error {
  readonly code: AuthenticationErrorCode;

  constructor(code: AuthenticationErrorCode, message: string) {
    super(message);
    this.name = 'AuthenticationError';
    this.code = code;
  }
}
