/**
 * M-02 Capability & Verification — domain types.
 *
 * M-02 owns how far the platform has checked a claim, and the evidence behind that. It stores the
 * current state of a verification effort, the append-only evidence submissions, and the append-only
 * log of level changes. It does not own which roles an account may act in (M-01 Universal Account),
 * the universal account itself (K-03 Accounts), or the artefacts another system holds.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-02 Capability & Verification.
 */

/** Ordered verification levels. */
export const VERIFICATION_LEVELS = ['none', 'basic', 'standard', 'enhanced', 'full'] as const;
export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** Lifecycle of a verification case. */
export const CASE_STATUSES = [
  'open',
  'evidence-required',
  'under-review',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/** Kinds of evidence that may be submitted. */
export const EVIDENCE_KINDS = [
  'identity-document',
  'address-proof',
  'business-registration',
  'tax-identifier',
  'bank-account',
  'selfie',
  'reference',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Lifecycle of one piece of evidence. */
export const EVIDENCE_STATUSES = ['submitted', 'accepted', 'rejected'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

/**
 * Compare two verification levels.
 *
 * Returns negative when `left` is lower than `right`, positive when it is higher, and zero when they
 * are equal.
 */
export function compareVerificationLevels(
  left: VerificationLevel,
  right: VerificationLevel,
): number {
  return VERIFICATION_LEVELS.indexOf(left) - VERIFICATION_LEVELS.indexOf(right);
}

/**
 * The current state of one verification effort for one account and one purpose.
 *
 * A case is created open, moves through evidence and review, and ends as approved, rejected or
 * withdrawn. Only one open case may exist per `(accountId, purpose)`.
 */
export interface VerificationCase {
  /** Caller-supplied opaque and stable identifier. */
  readonly caseId: string;
  /** The K-03 universal account this case belongs to. Not a foreign key. */
  readonly accountId: string;
  /** What the verification is for, as a lowercase kebab vocabulary word. */
  readonly purpose: string;
  /** Current lifecycle status. */
  readonly status: CaseStatus;
  /** The level the case is trying to reach. */
  readonly requestedLevel: VerificationLevel;
  /** The level actually reached; starts at `none`. */
  readonly achievedLevel: VerificationLevel;
  /** When the case was opened, as a canonical UTC instant. */
  readonly openedAt: string;
  /** When the case was decided; null until approved or rejected. */
  readonly decidedAt: string | null;
  /** Caller-supplied case metadata. */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** When the case was created, as a canonical UTC instant. */
  readonly createdAt: string;
  /** When the case was last changed, as a canonical UTC instant. */
  readonly updatedAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

/**
 * One submitted piece of evidence.
 *
 * Append-only. M-02 stores only an opaque reference to the artefact; it never stores the artefact
 * itself, a document number, a tax number or a bank number.
 */
export interface Evidence {
  /** Caller-supplied opaque and stable identifier. */
  readonly evidenceId: string;
  /** The case this evidence belongs to. */
  readonly caseId: string;
  /** Denormalised account id so evidence is queryable without a join. */
  readonly accountId: string;
  /** What kind of evidence this is. */
  readonly kind: EvidenceKind;
  /** Current review status. */
  readonly status: EvidenceStatus;
  /** Opaque handle to the artefact held by another system. */
  readonly reference: string;
  /** Why it was submitted, accepted or rejected. */
  readonly note: string;
  /** When the evidence was submitted, as a canonical UTC instant. */
  readonly submittedAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

/**
 * One change in the verification level reached by a case.
 *
 * Append-only. A database trigger refuses UPDATE and DELETE on this table.
 */
export interface LevelRecord {
  /** Caller-supplied opaque and stable identifier. */
  readonly recordId: string;
  /** The case whose level changed. */
  readonly caseId: string;
  /** Denormalised account id so history is queryable without a join. */
  readonly accountId: string;
  /** Previous level; null for the first record. */
  readonly fromLevel: VerificationLevel | null;
  /** New level. */
  readonly toLevel: VerificationLevel;
  /** Why the change happened. */
  readonly reason: string;
  /** When the change happened, as a canonical UTC instant. */
  readonly occurredAt: string;
  /** Correlates with the caller request trace. */
  readonly correlationId: string;
  /** Stable across retries of one logical request. */
  readonly idempotencyKey: string;
}

export type CapabilityVerificationErrorCode =
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
  /** An enlisted write tried to issue transaction control. */
  | 'nested-transaction'
  /** A case id already exists with different content. */
  | 'duplicate-case-id'
  /** An evidence id already exists with different content. */
  | 'duplicate-evidence-id'
  /** A level record id already exists with different content. */
  | 'duplicate-record-id'
  /** The level is not one M-02 recognises. */
  | 'unknown-level'
  /** The case status is not one M-02 recognises. */
  | 'unknown-status'
  /** The evidence kind is not one M-02 recognises. */
  | 'unknown-evidence-kind'
  /** The evidence status is not one M-02 recognises. */
  | 'unknown-evidence-status'
  /** The purpose is not a well-formed lowercase kebab word. */
  | 'malformed-purpose'
  /** The reason text is malformed. */
  | 'malformed-reason'
  /** The reference is not a valid opaque handle. */
  | 'malformed-reference'
  /** The account already has an open case for this purpose under a different id. */
  | 'case-already-open'
  /** The case id is unknown. */
  | 'case-not-found'
  /** The case is not in a state that permits this operation. */
  | 'case-not-open'
  /** The new level is below the level already reached. */
  | 'level-regression';

/** A refusal the caller must act on. */
export class CapabilityVerificationError extends Error {
  readonly code: CapabilityVerificationErrorCode;

  constructor(code: CapabilityVerificationErrorCode, message: string) {
    super(message);
    this.name = 'CapabilityVerificationError';
    this.code = code;
  }
}
