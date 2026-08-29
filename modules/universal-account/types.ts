/**
 * M-01 Universal Account — domain types.
 *
 * A capability is a role an account may act in. M-01 owns which capabilities an account holds: the
 * current capability state and the append-only transition log. It does not own the universal account
 * itself (K-03 Accounts), identity (K-01 Identity), authentication (K-02 Authentication), or
 * verification levels (M-02 Capability & Verification).
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-01 Universal Account.
 */

/** Roles an account may act in. */
export const CAPABILITIES = [
  'buyer',
  'seller',
  'host',
  'provider',
  'introducer',
  'driver',
  'business-purchaser',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Lifecycle of a capability. */
export const CAPABILITY_STATUSES = ['active', 'suspended', 'deactivated'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/**
 * One capability held by one account.
 *
 * Current state only. A capability is created, suspended, reactivated and deactivated; each
 * transition appends a `CapabilityState` row.
 */
export interface AccountCapability {
  /** Caller-supplied opaque and stable identifier. */
  readonly capabilityId: string;
  /** The K-03 universal account this capability belongs to. Not a foreign key. */
  readonly accountId: string;
  /** The role this capability represents. */
  readonly capability: Capability;
  /** Current lifecycle status. */
  readonly status: CapabilityStatus;
  /** When the capability was last activated, as a canonical UTC instant. */
  readonly activatedAt: string;
  /** When the capability was deactivated; null while active or suspended. */
  readonly deactivatedAt: string | null;
  /** Caller-supplied capability metadata. */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** When the capability was created, as a canonical UTC instant. */
  readonly createdAt: string;
  /** When the capability was last changed, as a canonical UTC instant. */
  readonly updatedAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

/**
 * One transition in a capability lifecycle.
 *
 * Append-only. A database trigger refuses UPDATE and DELETE on this table.
 */
export interface CapabilityState {
  /** Caller-supplied opaque and stable identifier. */
  readonly stateId: string;
  /** The capability whose status changed. */
  readonly capabilityId: string;
  /** Denormalised account id so history is queryable without a join. */
  readonly accountId: string;
  /** Previous status; null for the first transition. */
  readonly fromStatus: CapabilityStatus | null;
  /** New status. */
  readonly toStatus: CapabilityStatus;
  /** Free text explaining why the transition happened. */
  readonly reason: string;
  /** When the transition happened, as a canonical UTC instant. */
  readonly occurredAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

export type UniversalAccountErrorCode =
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** An identifier looks like a natural key. */
  | 'natural-identifier'
  /** An identifier names or looks like a credential. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** A request carried a field belonging to another component. */
  | 'foreign-concern'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record'
  /** The idempotency key was already used for a different record. */
  | 'idempotency-key-reuse'
  /** A capability id already exists with different content. */
  | 'duplicate-capability-id'
  /** A state id already exists with different content. */
  | 'duplicate-state-id'
  /** An enlisted write tried to issue transaction control. */
  | 'nested-transaction'
  /** The capability is not one M-01 recognises. */
  | 'unknown-capability'
  /** The status is not one M-01 recognises. */
  | 'unknown-status'
  /** The account already holds an active capability for this role. */
  | 'capability-already-active'
  /** The requested capability does not exist. */
  | 'capability-not-found'
  /** The capability is not in a state that permits this operation. */
  | 'capability-not-active'
  /** The reason text is malformed. */
  | 'malformed-reason';

/** A refusal the caller must act on. */
export class UniversalAccountError extends Error {
  readonly code: UniversalAccountErrorCode;

  constructor(code: UniversalAccountErrorCode, message: string) {
    super(message);
    this.name = 'UniversalAccountError';
    this.code = code;
  }
}
