/**
 * M-48 Supplier & Merchant Directory — who supplies what, where, and whether they are open.
 *
 * The module the sourcing ladder was built against and did not have. M-07's `known` and `verified`
 * rungs ask a directory "who plausibly supplies this", and without one the platform can only search
 * its own catalogue: every Need it cannot fill from stock becomes a tender, which is the behaviour
 * the ladder exists to avoid.
 *
 * **A trading profile is not a role and it is not a verification.** M-01 owns which roles an account
 * holds; M-02 owns whether it has been verified and to what level. Neither is a statement about what
 * a business sells, where it delivers, or how much it can take this week — and putting that into an
 * L1 identity component would make identity responsible for commerce.
 *
 * Four decisions shape the rest.
 *
 * **Category is a gate, not a preference.** A supplier who has not declared a category is not asked
 * about it, however convenient they otherwise look. Asking a cement supplier about laptops is the
 * single behaviour that trains people to ignore a platform, and the directory's job is to make that
 * impossible rather than unlikely.
 *
 * **What a supplier claims is separated from what they have done.** Everything here is a claim: they
 * say they supply cement, they say they deliver to Matale. Prior trade is a *fact* and lives in
 * M-11; verification is a *judgement* and lives in M-02. The application joins the three, and the
 * matcher weighs a fact above a claim — which it can only do if the two never got mixed together.
 *
 * **Withdrawing a facet is a state change, not a delete.** A supplier who stops carrying a brand has
 * a history worth keeping: a dispute about an order placed last March is judged against what they
 * said in March. The row moves to `withdrawn` and can move back, exactly as M-01's capabilities do.
 *
 * **Availability is a number and a switch, and they mean different things.** `acceptsOrders` is
 * "we are open"; `dailyCapacity` is "and this is how much". A supplier who is closed for the week
 * says so once rather than setting their capacity to zero, because zero capacity and closed are
 * different answers to a buyer asking why they were not invited.
 *
 * Deterministic: the caller supplies every identifier and every instant.
 *
 * Owned by: M-48 Supplier & Merchant Directory.
 */

/**
 * What kind of trading party this is.
 *
 * `supplier` — sells to the platform's buyers, usually without a shopfront.
 * `merchant` — a shop. The difference that matters here is that a merchant has **branches**, which
 *   are locations customers walk into, and a supplier's locations are places goods come from.
 *
 * Both are directories entries and both can be sourced from; the distinction exists because a
 * merchant's branch network is a fact a buyer cares about and a supplier's depot list usually is
 * not.
 */
export const DIRECTORY_KINDS = ['supplier', 'merchant'] as const;
export type DirectoryKind = (typeof DIRECTORY_KINDS)[number];

/**
 * Where a directory entry is in its life.
 *
 * `pending` — registered and not yet open for business. The state a new supplier is in before
 *   anybody has checked anything; deliberately not a candidate for sourcing.
 * `active` — open. The only status the rungs will consider.
 * `suspended` — temporarily not open, by the platform or by themselves. Reversible.
 * `closed` — terminal. The record stays, because orders they filled still name them.
 */
export const DIRECTORY_STATUSES = ['pending', 'active', 'suspended', 'closed'] as const;
export type DirectoryStatus = (typeof DIRECTORY_STATUSES)[number];

export const DIRECTORY_TRANSITIONS: Readonly<Record<DirectoryStatus, readonly DirectoryStatus[]>> =
  Object.freeze<Record<DirectoryStatus, readonly DirectoryStatus[]>>({
    pending: Object.freeze(['active', 'closed']),
    active: Object.freeze(['suspended', 'closed']),
    suspended: Object.freeze(['active', 'closed']),
    closed: Object.freeze([]),
  });

/**
 * The four things a supplier declares about what they can do.
 *
 * One table rather than four, because they are structurally the same — an opaque code a supplier
 * claims, which they may later withdraw — and four tables that differ only in name would drift
 * apart in their constraints. The vocabulary is closed, so this is a discriminated set rather than
 * a bag anybody can add to.
 *
 * `category` — what they supply. **The gate.** Opaque codes from M-05's category vocabulary.
 * `brand` — whose goods, where that is meaningful. Scored, never gated: a Need naming no brand must
 *   not exclude a supplier who carries several.
 * `capability` — what they can do beyond having it: bulk break, cold chain, installation, next-day.
 * `district` — where they serve. Empty means they have not said, which is not the same as nowhere.
 */
export const FACET_KINDS = ['category', 'brand', 'capability', 'district'] as const;
export type FacetKind = (typeof FACET_KINDS)[number];

export const FACET_STATUSES = ['active', 'withdrawn'] as const;
export type FacetStatus = (typeof FACET_STATUSES)[number];

/** One trading party in the directory. */
export interface DirectoryEntry {
  readonly supplierId: string;
  /** The K-03 account that trades. One entry per account, and the directory says so with a UNIQUE. */
  readonly accountId: string;
  readonly kind: DirectoryKind;
  /**
   * What they trade as.
   *
   * A business name, which is public by design — it is what a buyer sees on an invitation. Not held
   * to the opaque-identifier rule for that reason, and the only field here that is not.
   */
  readonly displayName: string;
  readonly status: DirectoryStatus;
  /**
   * Whether they are open for business today.
   *
   * Distinct from capacity, and from status. A supplier away for a week is not suspended by the
   * platform and has not lost their capacity; they are simply closed, and a buyer asking why they
   * were not invited deserves that answer rather than "capacity zero".
   */
  readonly acceptsOrders: boolean;
  /**
   * How much they can take in a day, in whatever unit their categories are traded in, or null.
   *
   * Null means "they have not said", which is different from zero. A rung must not exclude a
   * supplier for not having filled in a number.
   */
  readonly dailyCapacity: bigint | null;
  readonly registeredAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly closureReason: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/** One thing a supplier claims about what they can do. */
export interface SupplierFacet {
  readonly facetId: string;
  readonly supplierId: string;
  readonly kind: FacetKind;
  /** An opaque code. `cement`, `opc`, `bulk-break`, `matale`. */
  readonly value: string;
  readonly status: FacetStatus;
  readonly declaredAt: string;
  readonly withdrawnAt: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * One place a supplier trades from, or a merchant's branch.
 *
 * Locations carry a district rather than an address, and deliberately: an address is personal data
 * for a sole trader working from home, and the platform routes on districts. A precise address
 * belongs wherever a delivery is actually arranged, under whatever consent that requires.
 */
export interface SupplierLocation {
  readonly locationId: string;
  readonly supplierId: string;
  /** What it is called: "Matale branch", "Kandy depot". Public, like the display name. */
  readonly name: string;
  /** An opaque district code. The unit the platform routes on. */
  readonly district: string;
  /** True for the one a buyer should be shown first. At most one per supplier. */
  readonly primary: boolean;
  readonly status: FacetStatus;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/** One recorded status change, so how a supplier reached `suspended` is answerable. */
export interface DirectoryEvent {
  readonly eventId: string;
  readonly supplierId: string;
  readonly fromStatus: DirectoryStatus | null;
  readonly toStatus: DirectoryStatus;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/** What a caller filters the directory by. Every field narrows; an absent field does not. */
export interface DirectoryQuery {
  /** Categories, any of which qualifies. **Empty matches nothing**: the gate is not optional. */
  readonly categories: readonly string[];
  /** Districts, any of which qualifies. Empty means anywhere. */
  readonly districts?: readonly string[];
  readonly kind?: DirectoryKind;
  /** Only `active` suppliers by default; a caller administering the directory may ask for others. */
  readonly status?: DirectoryStatus;
  /** Whether to require `acceptsOrders`. Defaults to true: a sourcing query wants open suppliers. */
  readonly openOnly?: boolean;
  readonly limit?: number;
}

/** A directory entry with everything it has declared, which is what a caller almost always wants. */
export interface DirectoryProfile {
  readonly entry: DirectoryEntry;
  readonly categories: readonly string[];
  readonly brands: readonly string[];
  readonly capabilities: readonly string[];
  readonly districts: readonly string[];
}

export type DirectoryErrorCode =
  | 'malformed-identifier'
  | 'natural-identifier'
  | 'secret-bearing-input'
  | 'malformed-instant'
  | 'foreign-concern'
  | 'malformed-record'
  | 'idempotency-key-reuse'
  | 'duplicate-supplier-id'
  | 'duplicate-facet-id'
  | 'duplicate-location-id'
  | 'supplier-not-found'
  | 'facet-not-found'
  | 'location-not-found'
  /** This account already trades under a directory entry. One account, one entry. */
  | 'already-registered'
  | 'unknown-kind'
  | 'unknown-status'
  | 'unknown-facet-kind'
  | 'illegal-transition'
  | 'supplier-closed'
  | 'malformed-name'
  | 'malformed-reason'
  | 'malformed-capacity'
  /** A second primary location, which would make "show the buyer the main one" ambiguous. */
  | 'primary-location-exists'
  /** A caller asked the directory to search with no category. The gate is not optional. */
  | 'ungated-query';

export class DirectoryError extends Error {
  readonly code: DirectoryErrorCode;

  constructor(code: DirectoryErrorCode, message: string) {
    super(message);
    this.name = 'DirectoryError';
    this.code = code;
  }
}
