/**
 * K-09 Audit Foundation — domain types (FND-003c).
 *
 * An audit record answers a question asked much later, usually by somebody who was not there and is
 * not inclined to take anybody's word for it: *who did this, when, to what, and what happened*. The
 * value of the answer depends entirely on the record being impossible to change afterwards, so
 * every type here is arranged around that:
 *
 *   - **Append-only.** There is no operation anywhere in this component that changes or removes a
 *     record. Not a restricted one, not an internal one — none. A component that can rewrite its
 *     own history is a component whose history proves nothing.
 *   - **Classified evidence.** Every field of structured evidence is declared with a
 *     classification at registration. An audit log accumulates for years and is read by people with
 *     varying entitlement; a field nobody classified is a field nobody can decide about.
 *   - **Caller-supplied identity and time.** The record id, the instant and the idempotency key all
 *     come from the caller, so this component reads no clock and generates no randomness. Two
 *     retries of one action produce one record rather than two, which is the difference between an
 *     audit trail and a pile of near-duplicates.
 *
 * Provider-neutral: nothing here knows about PostgreSQL, a log shipper, or a SIEM. Those are
 * implementations of the port in repository.ts.
 *
 * Owned by: K-09 Audit Foundation.
 */

/** What a piece of evidence may hold. Scalars only, for the same reason K-08 restricts payloads. */
export type EvidenceValue = string | number | boolean | null;

/**
 * How sensitive a piece of evidence is.
 *
 * Declared per field at registration, never inferred. The classification decides who may read the
 * field once an access layer exists (**K-04**, deferred), and recording it now means the decision
 * is made by whoever understood the field rather than by whoever later needs to expose it.
 */
export const EVIDENCE_CLASSIFICATIONS = ['public', 'internal', 'personal', 'restricted'] as const;
export type EvidenceClassification = (typeof EVIDENCE_CLASSIFICATIONS)[number];

/** Structured evidence: a flat map of declared, classified fields. */
export type AuditEvidence = Readonly<Record<string, EvidenceValue>>;

/**
 * How an actor's identity was established.
 *
 * `unauthenticated` is the honest answer today and will be the only answer until **K-02
 * Authentication** exists. It is a *recorded fact about the record*, not a placeholder to be
 * tidied away: a record written before authentication existed must keep saying so, because
 * otherwise a reader in two years cannot tell which records had a verified actor and which did not.
 */
export const AUTHENTICATION_METHODS = ['unauthenticated', 'session', 'service-credential'] as const;
export type AuthenticationMethod = (typeof AUTHENTICATION_METHODS)[number];

export const ACTOR_KINDS = ['human', 'system', 'ai'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * Who did the thing.
 *
 * A placeholder in exactly one respect: `authentication` is supplied by the caller rather than
 * derived from a verified session, because there is nothing to derive it from yet. Everything else
 * is real and is checked.
 */
export interface AuditActor {
  readonly kind: ActorKind;
  /** Stable identifier for the actor: a user id, a manifest unit id, a worker name. */
  readonly id: string;
  readonly authentication: AuthenticationMethod;
  /**
   * The session the action was taken in, when there is one.
   *
   * Always null today. K-02 will supply it, and a record written before then says null rather than
   * pretending to a session it never had.
   */
  readonly sessionId: string | null;
}

/**
 * What the action was done to.
 *
 * `owner` is a manifest unit id, so a resource always belongs to a unit that exists. An audit
 * record about a resource nobody owns is a record nobody can act on.
 */
export interface ResourceReference {
  readonly owner: string;
  /** The kind of thing, e.g. `configuration_version`. */
  readonly type: string;
  readonly id: string;
}

/**
 * What happened.
 *
 * `denied` is separate from `failed` on purpose: a refused attempt is the single most interesting
 * thing in a security log, and folding it into "failed" loses the distinction between "the system
 * broke" and "somebody tried something they were not allowed to".
 */
export const AUDIT_OUTCOMES = ['succeeded', 'failed', 'denied'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** The immutable record. */
export interface AuditRecord {
  /** Caller-supplied and stable. A duplicate is a refusal, never an overwrite. */
  readonly recordId: string;
  /** Registered action, e.g. `configuration.version_published`. */
  readonly action: string;
  /** When the action happened, as a canonical UTC instant. */
  readonly recordedAt: string;
  readonly actor: AuditActor;
  readonly resource: ResourceReference;
  readonly outcome: AuditOutcome;
  /** Why, in the recorder's words. Required — a record with no reason explains nothing. */
  readonly reason: string;
  /** Ties an action to everything else in the same causal chain, across units. */
  readonly correlationId: string;
  /** The record or event that caused this one, or null when it starts a chain. */
  readonly causationId: string | null;
  readonly evidence: AuditEvidence;
  /**
   * SHA-256 over the record's logical content, computed once at append.
   *
   * The evidence that a record was never edited, and the thing an idempotent retry is compared
   * against. A reader can recompute it without trusting the row it came from.
   */
  readonly contentFingerprint: string;
  /** Stable across retries of one logical recording. */
  readonly idempotencyKey: string;
}

export type AuditErrorCode =
  | 'unknown-action'
  | 'malformed-record'
  | 'invalid-evidence'
  | 'unclassified-evidence'
  | 'secret-bearing-evidence'
  | 'ai-not-permitted'
  | 'actor-not-permitted'
  | 'resource-not-owned'
  | 'duplicate-record-id'
  | 'idempotency-key-reuse'
  | 'no-such-record'
  | 'immutable-record'
  | 'concurrent-modification'
  | 'nested-transaction'
  | 'invalid-query';

export class AuditError extends Error {
  readonly code: AuditErrorCode;

  constructor(code: AuditErrorCode, message: string) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

/**
 * The marker a caller writes instead of a sensitive value.
 *
 * Recording that a field existed and was withheld is more useful than omitting it: a reader can
 * tell the difference between "no password was involved" and "there was one and we did not keep
 * it". Anything that looks like an actual credential is refused; this is what to write instead.
 */
export const REDACTED = '[redacted]';
