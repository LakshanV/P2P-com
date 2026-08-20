/**
 * K-04 Permissions — domain types (FND-004d).
 *
 * This component answers one question: **may this authenticated subject take this action on this
 * resource, in this account, right now?** It answers `deny` unless something explicitly says
 * otherwise, and it never asks the caller.
 *
 * That last clause is the whole design, and it is why the request type below has no `subjectId`,
 * no `role`, no `permissions`, no `purposeSatisfied` and no `allowed`. A caller that could state
 * any of those is not being authorised; it is being formatted. The subject comes from a session
 * validated through K-02's port, the account from K-03's public contract, and the authority from
 * grants this component stored itself.
 *
 * Four record types, all **append-only**, because authority history is evidence:
 *
 *   - **Policy version.** An immutable, numbered snapshot of the role vocabulary and what each role
 *     may do. A new policy is a new version, never an edit — "who could do what last March" has to
 *     be answerable, and a mutable policy table cannot answer it.
 *   - **Grant.** One explicit `allow` or `deny`, scoped to an account, a resource and an action,
 *     optionally conditioned on a typed predicate and optionally limited to a declared purpose.
 *   - **Revocation.** A grant is never deleted or edited; it is revoked by a row that says when and
 *     why. Deleting one would erase the fact that it existed.
 *   - **Decision.** What was decided, for whom, on what, and **why** — a deterministic explanation
 *     rather than a boolean, because "access denied" with no reason is unactionable for the person
 *     denied and unauditable for everybody else.
 *
 * What is deliberately absent: sessions and credentials (K-02), the account itself (K-03), the
 * subject (K-01), policy authoring UI, delegation, groups, and any notion of a super-user. See
 * CONTRACT.md §9.
 *
 * Owned by: K-04 Permissions.
 */

/**
 * The initial role vocabulary, from the v1.0 guide §52, in its declared order.
 *
 * A closed set, and **nothing more than a set**. There is no mapping from a role to an authority
 * anywhere in this component's code: what a role may do lives in a published policy version, which
 * is data, is versioned, and is auditable. `SUPER_ADMIN` is in this list because the guide lists
 * it; it confers nothing on its own, and §5 of the contract says so.
 */
export const ROLES = [
  'CUSTOMER',
  'SUPPLIER',
  'SERVICE_PROVIDER',
  'DRIVER',
  'STAFF',
  'OPERATIONS',
  'FINANCE',
  'SUPPORT',
  'MANAGER',
  'ADMIN',
  'SUPER_ADMIN',
  'AI_AGENT',
] as const;
export type Role = (typeof ROLES)[number];

/**
 * Roles whose holders act on somebody else's data, and therefore may not act without a purpose.
 *
 * Derived from v3 §5.3 — "all staff access must be role-based, purpose-based and audited" — and
 * §40's least-privilege requirement. Membership is a property of the role, not of a grant, so a
 * grant cannot quietly make a staff role purpose-free.
 */
export const STAFF_ROLES: readonly Role[] = Object.freeze([
  'STAFF',
  'OPERATIONS',
  'FINANCE',
  'SUPPORT',
  'MANAGER',
  'ADMIN',
  'SUPER_ADMIN',
]);

/** Is this a role that acts on another party's data? */
export function isStaffRole(role: Role): boolean {
  return STAFF_ROLES.includes(role);
}

/**
 * Declared reasons a staff member may reach another party's data (v3 §5.3, §40, §63).
 *
 * A closed set, because a free-text purpose is a purpose nobody can audit. "Because I was asked to"
 * is not a purpose; `dispute-investigation` is.
 */
export const PURPOSES = [
  'dispute-investigation',
  'fraud-investigation',
  'support-request',
  'regulatory-request',
  'payment-investigation',
  'safety-review',
  'system-maintenance',
] as const;
export type Purpose = (typeof PURPOSES)[number];

/**
 * How strongly the subject was authenticated, weakest first.
 *
 * K-04 carries its own copy rather than importing K-02's, because the session port is
 * provider-neutral: anything that can assert a validated session may satisfy it, and a shared
 * enum would make K-02 the only possible provider. The values match K-02's, and
 * `tests/permissions.test.ts` wires the real K-02 service to the port to prove they still do.
 */
export const ASSURANCE_LEVELS = ['single-factor', 'multi-factor', 'hardware-backed'] as const;
export type AssuranceLevel = (typeof ASSURANCE_LEVELS)[number];

export const ASSURANCE_RANK: Readonly<Record<AssuranceLevel, number>> = Object.freeze({
  'single-factor': 1,
  'multi-factor': 2,
  'hardware-backed': 3,
});

/** Allow or deny. There is no third answer, and no "maybe" that a caller could resolve. */
export const EFFECTS = ['allow', 'deny'] as const;
export type Effect = (typeof EFFECTS)[number];

/** Why a grant stopped applying. Recorded so a later reader can tell the cases apart. */
export const REVOCATION_REASONS = [
  'granted-in-error',
  'role-changed',
  'access-no-longer-needed',
  'security-event',
  'policy-superseded',
] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

/**
 * A typed ABAC predicate over an allowlisted context.
 *
 * Typed and closed rather than an expression language, because a predicate that can express
 * anything can express "true", and a policy engine whose conditions cannot be enumerated cannot be
 * reviewed. Every attribute is checked against `CONTEXT_KEYS` at validation time, so a predicate
 * over an attribute nobody declared is refused rather than silently evaluating to false — a
 * condition that silently never matches is a grant that silently never applies.
 */
export type Predicate =
  | { readonly kind: 'always' }
  | { readonly kind: 'attribute-equals'; readonly attribute: string; readonly value: string }
  | {
      readonly kind: 'attribute-in';
      readonly attribute: string;
      readonly values: readonly string[];
    }
  | { readonly kind: 'assurance-at-least'; readonly assurance: AssuranceLevel }
  | { readonly kind: 'all'; readonly of: readonly Predicate[] }
  | { readonly kind: 'any'; readonly of: readonly Predicate[] };

export const PREDICATE_KINDS = [
  'always',
  'attribute-equals',
  'attribute-in',
  'assurance-at-least',
  'all',
  'any',
] as const;

/** What one role may do, inside one policy version. */
export interface RoleDefinition {
  readonly role: Role;
  /** `action` on `resourceType`, both from the registry. Sorted, so two equal sets compare equal. */
  readonly capabilities: readonly Capability[];
}

export interface Capability {
  readonly action: string;
  readonly resourceType: string;
}

/**
 * An immutable, numbered snapshot of the role vocabulary and what each role may do.
 *
 * Versions are never edited. Publishing a change appends a version with a higher number, and every
 * grant records the version it was made under, so a decision taken last March can be replayed
 * against the policy that was active last March.
 */
export interface PolicyVersion {
  readonly policyVersionId: string;
  /** Monotonic, caller-supplied, and unique. Gaps are permitted; reuse is not. */
  readonly version: number;
  readonly roles: readonly RoleDefinition[];
  readonly publishedAt: string;
  /**
   * Who published it, **derived from a validated session** rather than supplied by the caller.
   * `human` is an authenticated administrator; `system` is the bootstrap authority and nothing
   * else. `ai` is refused — see §6 of the contract.
   */
  readonly publishedBy: Origin;
  /**
   * True when this version was published through the bootstrap authority rather than by an
   * authorised administrator.
   *
   * Immutable evidence of its own origin: the row is append-only, so "the first policy was
   * installed by the operator who started this deployment, not by anybody who asked" stays
   * answerable for ever. At most one version can carry it, because bootstrap is refused the
   * moment any policy exists.
   */
  readonly bootstrap: boolean;
  readonly idempotencyKey: string;
  /** SHA-256 over the administrator, session, account and content of the request (fingerprint.ts). */
  readonly requestFingerprint: string;
}

/**
 * One explicit statement of authority, scoped as narrowly as the grantor cared to scope it.
 *
 * Least privilege is expressed by what a grant *omits*: a grant with a `resourceId` covers one
 * resource, a grant without covers the type, and there is no grant shape that covers everything.
 */
export interface Grant {
  readonly grantId: string;
  readonly subjectId: string;
  /** The K-03 universal account this grant is scoped to. Authority never spans accounts. */
  readonly accountId: string;
  readonly role: Role;
  readonly effect: Effect;
  readonly action: string;
  readonly resourceType: string;
  /** One resource, or `null` for every resource of that type inside this account. */
  readonly resourceId: string | null;
  /** Required for a staff role, refused for a non-staff one. */
  readonly purpose: Purpose | null;
  readonly condition: Predicate | null;
  readonly policyVersionId: string;
  readonly grantedAt: string;
  /** Not usable before this instant, if set. */
  readonly notBefore: string | null;
  /** Not usable at or after this instant, if set. Temporal validity is part of least privilege. */
  readonly expiresAt: string | null;
  /** Who granted it, derived from a validated session. Never supplied by the caller. */
  readonly grantedBy: Origin;
  readonly idempotencyKey: string;
  /** SHA-256 over the administrator, session, account and content of the request (fingerprint.ts). */
  readonly requestFingerprint: string;
}

/** A grant withdrawn. Append-only: the grant row itself is never touched. */
export interface Revocation {
  readonly revocationId: string;
  readonly grantId: string;
  readonly revokedAt: string;
  readonly reason: RevocationReason;
  /** Who revoked it, derived from a validated session. Never supplied by the caller. */
  readonly revokedBy: Origin;
  readonly idempotencyKey: string;
  /** SHA-256 over the administrator, session, account and content of the request (fingerprint.ts). */
  readonly requestFingerprint: string;
}

/**
 * What was decided, and why.
 *
 * The explanation is structured rather than prose so it can be asserted on, compared across runs
 * and shown to the person who was denied. `reason` is the machine-readable half; `explanation` is
 * the human half, and both are derived from the same evaluation rather than written twice.
 */
export interface Decision {
  readonly decisionId: string;
  readonly subjectId: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly effect: Effect;
  readonly reason: DecisionReason;
  readonly explanation: string;
  /** The grant that decided it, when one did. A denial by default names none. */
  readonly decidingGrantId: string | null;
  readonly policyVersionId: string;
  readonly purpose: Purpose | null;
  readonly decidedAt: string;
  readonly idempotencyKey: string;
  /**
   * SHA-256 over every input this decision depended on, including the session it was computed
   * for and the ABAC context that satisfied it (fingerprint.ts).
   *
   * A retry is answered from storage only when this matches. Without it an idempotency key is a
   * bearer token for somebody else’s answer.
   */
  readonly requestFingerprint: string;
}

/**
 * Why a decision went the way it did. Closed, because an explanation nobody can enumerate is an
 * explanation nobody can test.
 */
export const DECISION_REASONS = [
  /** No grant matched. The default, and the only outcome that needs no grant to explain it. */
  'no-matching-grant',
  /** An explicit deny matched. Deny always wins, whatever else matched. */
  'explicit-deny',
  /** An explicit allow matched and nothing denied. */
  'explicit-allow',
  /** A grant matched but its condition did not hold against the presented context. */
  'condition-unsatisfied',
  /** A grant matched but was outside its temporal window. */
  'outside-validity-window',
  /** A grant matched but had been revoked. */
  'grant-revoked',
  /** A staff subject presented no purpose, or one the grant does not permit. */
  'purpose-not-satisfied',
  /** The role holding the grant is not permitted this capability by the active policy version. */
  'not-permitted-by-policy',
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

/** Who caused a write. `ai` is refused everywhere in this component. */
export interface Origin {
  readonly kind: 'human' | 'system' | 'ai';
  readonly id: string;
}

export type PermissionErrorCode =
  /** The session names a subject K-01 does not have, or the port asserted no subject. */
  | 'unknown-subject'
  /** The subject holds no K-03 universal account, so there is nothing to scope authority to. */
  | 'unknown-account'
  /** The presented session is not valid: refused by the port, revoked, or past an expiry. */
  | 'invalid-session'
  /** The request names an account that is not the one the session's subject holds. */
  | 'cross-account-access'
  /** A staff role acted without declaring a purpose. */
  | 'missing-purpose'
  /** The declared purpose is not one the grant permits. */
  | 'mismatched-purpose'
  /** The action is not in the registry. */
  | 'unsupported-action'
  /** The resource type is not in the registry. */
  | 'unsupported-resource'
  /** The role is not in the vocabulary. */
  | 'unsupported-role'
  /** The predicate names an unknown kind, or an attribute outside the context allowlist. */
  | 'unsupported-predicate'
  /** The caller stated an authorisation outcome, an identity, a role or a purpose satisfaction. */
  | 'caller-asserted-authorization'
  /** The request carried a field owned by K-01, K-02, K-03 or another component. */
  | 'foreign-concern'
  /** AI tried to author policy, grant authority, or be authoritative where it may not be. */
  | 'ai-not-permitted'
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** An identifier looks like a natural key: an email, a telephone number, a document number. */
  | 'natural-identifier'
  /** Something in the request looks like a credential, a secret or raw proof material. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** The idempotency key was already used for different logical content. */
  | 'idempotency-key-reuse'
  /** A revocation was issued against a grant that had already been revoked. */
  | 'stale-revocation'
  /** Nothing to read. */
  | 'no-such-grant'
  /** No policy version has been published, or the named one does not exist. */
  | 'no-such-policy'
  /** A grant with this id, or an equivalent scope under a different id, already exists. */
  | 'duplicate-grant'
  /** A policy version number has already been used. */
  | 'duplicate-policy-version'
  /**
   * The authenticated actor holds no explicit authority to administer permissions.
   *
   * Separate from `cross-account-access` and from a plain `deny` decision because it names the
   * thing that was refused: not access to a resource, but the right to change who has access.
   */
  | 'administration-denied'
  /** An enlisted path tried to control a transaction it does not own. */
  | 'nested-transaction'
  /** A write tried to rewrite authority history. */
  | 'immutable-history'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record';

export class PermissionError extends Error {
  readonly code: PermissionErrorCode;

  constructor(code: PermissionErrorCode, message: string) {
    super(message);
    this.name = 'PermissionError';
    this.code = code;
  }
}
