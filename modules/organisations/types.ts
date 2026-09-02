/**
 * M-49 — the business, and the people who act for it.
 *
 * Until now every commercial record in this platform belonged to a **person's** account: a listing,
 * a directory entry, a wallet, an order. That is true of a sole trader and false of every business
 * with two people in it, and the gap shows up the first time a shop wants somebody to answer
 * tenders while somebody else keeps the stock.
 *
 * The model is deliberately not "let one personal account act as another". That would make
 * impersonation the mechanism, and an audit trail that cannot tell who actually did something.
 * Instead:
 *
 *   * An **organisation is a K-03 account of its own**, owned by a K-01 subject of kind
 *     `organisation`. Every commercial record therefore already references it — a listing's
 *     `accountId`, an order's `sellerAccountId`, a directory entry's `accountId` — with **no change
 *     to any module that owns one**. The business owns the business's records, which is what a
 *     business changing staff or owners needs to stay true.
 *   * A **membership** says that one person may act for one organisation, in named roles. It is
 *     the only thing that makes acting-for possible, and it is scoped: a FINANCE membership at
 *     organisation A confers nothing at organisation B, because it is a different row.
 *   * The **human is never lost**. K-04 records the deciding subject and the account the action was
 *     taken in, so every business action carries both the person and the organisation.
 *
 * Owned by: M-49 Organisations.
 */

/**
 * What kind of business this is.
 *
 * Wider than M-48's `supplier | merchant`, because a logistics provider and a service provider are
 * organisations with staff and no directory listing. The directory is a *market presence*; this is
 * the business itself.
 */
export const ORGANISATION_KINDS = [
  'supplier',
  'merchant',
  'member',
  'logistics',
  'service',
  'wholesale',
] as const;
export type OrganisationKind = (typeof ORGANISATION_KINDS)[number];

/**
 * The business's standing with the platform.
 *
 * `pending` is where every organisation starts, and it is the point of the state: creating a
 * business does not make it one the platform vouches for. Admission is an operator's act, and it is
 * separate from — and never implied by — having staff.
 */
export const ORGANISATION_STATUSES = ['pending', 'active', 'suspended', 'closed'] as const;
export type OrganisationStatus = (typeof ORGANISATION_STATUSES)[number];

/** Where a status may go. `closed` is terminal: the orders it filled still name it. */
export const ORGANISATION_TRANSITIONS: Readonly<Record<OrganisationStatus, readonly string[]>> =
  Object.freeze({
    pending: Object.freeze(['active', 'suspended', 'closed']),
    active: Object.freeze(['suspended', 'closed']),
    suspended: Object.freeze(['active', 'closed']),
    closed: Object.freeze([]),
  });

/**
 * What a member does for the organisation.
 *
 * A vocabulary of its own, and deliberately **not** K-04's platform roles. The two answer different
 * questions: a K-04 role says what somebody may do on this platform, and an organisation role says
 * what they do for this business. Collapsing them would make a shop's bookkeeper a member of the
 * platform's finance staff.
 *
 * `OWNER` is the only role that can be the last one standing: an organisation with no active owner
 * is an organisation nobody can administer, and both the service and the database refuse it.
 */
export const MEMBERSHIP_ROLES = [
  'OWNER',
  'ADMIN',
  'MANAGER',
  'SALES',
  'PROCUREMENT',
  'INVENTORY',
  'FINANCE',
  'FULFILMENT',
  'DRIVER_MANAGER',
  'READ_ONLY',
] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * The lifecycle of one person's place in one organisation.
 *
 * `invited` and `active` are separate because joining a business is something a person agrees to.
 * An invitation that took effect on its own would let anybody add anybody to their organisation and
 * then act in ways that person's name is attached to.
 *
 * `suspended` is reversible and `revoked` is not; `left` records that the person went rather than
 * that they were removed, which is a difference worth keeping on the record.
 */
export const MEMBERSHIP_STATUSES = ['invited', 'active', 'suspended', 'revoked', 'left'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const MEMBERSHIP_TRANSITIONS: Readonly<Record<MembershipStatus, readonly string[]>> =
  Object.freeze({
    invited: Object.freeze(['active', 'revoked']),
    active: Object.freeze(['suspended', 'revoked', 'left']),
    suspended: Object.freeze(['active', 'revoked', 'left']),
    revoked: Object.freeze([]),
    left: Object.freeze([]),
  });

/** The statuses in which a member may actually act for the organisation. */
export const ACTING_STATUSES: readonly MembershipStatus[] = Object.freeze(['active']);

/**
 * Who may hand out which roles.
 *
 * The rule the tests care about: **nobody grants what they do not hold.** An ADMIN may build a
 * team; only an OWNER may make another OWNER, because ownership is the authority to dispose of the
 * business and an ADMIN who could confer it could take the business.
 */
export const MAY_INVITE: readonly MembershipRole[] = Object.freeze(['OWNER', 'ADMIN']);
export const MAY_CONFER_OWNERSHIP: readonly MembershipRole[] = Object.freeze(['OWNER']);

/** A business. */
export interface Organisation {
  readonly organisationId: string;
  /**
   * The K-03 account the business trades under.
   *
   * The whole design rests on this. Every commercial record already names an account, so making the
   * organisation an account means a listing, an order and a wallet belong to the **business**
   * without a single module changing — and a business that adds staff or changes owners rewrites
   * nothing.
   */
  readonly accountId: string;
  readonly kind: OrganisationKind;
  /** What it trades as. Public by design: a buyer sees it on an invitation. */
  readonly displayName: string;
  readonly status: OrganisationStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly closureReason: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/** One person's place in one organisation. */
export interface OrganisationMembership {
  readonly membershipId: string;
  readonly organisationId: string;
  /** The K-01 subject. The human, and the thing K-04 evaluates authority for. */
  readonly personSubjectId: string;
  /**
   * The person's **own** K-03 account.
   *
   * Held so a membership can be read from either direction without asking K-03, and so a person's
   * memberships can be listed for their cockpit. It is never the account a business action is taken
   * in: that is always the organisation's.
   */
  readonly personAccountId: string;
  readonly roles: readonly MembershipRole[];
  readonly status: MembershipStatus;
  /** The subject who invited them. Null for the founding owner, who invited nobody. */
  readonly invitedBy: string | null;
  readonly invitedAt: string;
  readonly acceptedAt: string | null;
  readonly suspendedAt: string | null;
  readonly endedAt: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * One change to a membership, with the human who made it.
 *
 * Append-only. "Who removed me, and when, and why" is the question a person asks after being
 * removed from a business they worked for, and a record that could be edited is not an answer.
 */
export interface MembershipEvent {
  readonly eventId: string;
  readonly membershipId: string;
  readonly organisationId: string;
  readonly fromStatus: MembershipStatus | null;
  readonly toStatus: MembershipStatus;
  readonly roles: readonly MembershipRole[];
  /** The subject who made the change. Never the organisation: a business does not act, people do. */
  readonly actorSubjectId: string;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/** One change to an organisation's standing. */
export interface OrganisationEvent {
  readonly eventId: string;
  readonly organisationId: string;
  readonly fromStatus: OrganisationStatus | null;
  readonly toStatus: OrganisationStatus;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export type OrganisationErrorCode =
  | 'malformed-identifier'
  | 'natural-identifier'
  | 'secret-bearing-input'
  | 'malformed-instant'
  | 'foreign-concern'
  | 'malformed-record'
  | 'malformed-name'
  | 'malformed-reason'
  | 'idempotency-key-reuse'
  | 'duplicate-organisation-id'
  | 'duplicate-membership-id'
  | 'organisation-not-found'
  | 'membership-not-found'
  /** This account already trades as an organisation. One account, one business. */
  | 'account-already-organisation'
  /** This person already has a place in this organisation. */
  | 'already-a-member'
  | 'unknown-kind'
  | 'unknown-status'
  | 'unknown-role'
  | 'illegal-transition'
  | 'organisation-closed'
  /** No roles at all. A membership that permits nothing is a membership nobody should hold. */
  | 'no-roles'
  /** The actor's own membership does not permit what they are trying to do. */
  | 'not-permitted-in-organisation'
  /** Handing out a role the actor does not hold themselves. */
  | 'cannot-confer-role'
  /** Acting on your own membership where somebody else must. */
  | 'not-your-decision'
  /** Accepting an invitation that was not addressed to you. */
  | 'not-your-invitation'
  /** Removing, suspending or demoting the last owner. */
  | 'last-owner';

export class OrganisationError extends Error {
  readonly code: OrganisationErrorCode;

  constructor(code: OrganisationErrorCode, message: string) {
    super(message);
    this.name = 'OrganisationError';
    this.code = code;
  }
}
