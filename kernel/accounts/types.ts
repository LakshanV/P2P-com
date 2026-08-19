/**
 * K-03 Accounts — domain types (FND-004b).
 *
 * **One universal account per party.** The guide's §4 is the whole design: *do not create separate
 * identities for buyers, sellers, hosts or service providers; create one JAYA Account with
 * capabilities*. K-01 made that true at the identity layer by refusing a role as a subject kind.
 * This component makes it true one level up, by holding at most one account per subject and by
 * carrying no capability at all.
 *
 * That second half is the part worth guarding. An account is where every persona in the platform
 * wants to put something: a seller profile, a verification level, a payout destination, a points
 * balance, a role. Each of those, added here, would be a field every consumer inherits and a reason
 * for the "one account" rule to start bending — because once an account carries `isSeller`, the
 * next question is what to do about a person who sells under two businesses, and the answer people
 * reach for is a second account. So a create request carrying any of them is refused **by name**,
 * with the component that owns it.
 *
 * What is left is deliberately almost nothing:
 *
 *   - **A link.** One account, one K-01 subject, fixed at creation and never changed. An account
 *     that could be relinked would silently reattribute every order, payment and ledger entry that
 *     referenced it.
 *   - **Provenance.** Who caused the account to exist. Not who is authenticated — nothing
 *     authenticates anybody until K-02.
 *   - **A creation instant and an idempotency key**, both caller-supplied, so this component reads
 *     no clock and generates no randomness.
 *
 * Provider-neutral: nothing here knows about PostgreSQL. That is repository.ts and its adapters.
 *
 * Owned by: K-03 Accounts.
 */

/**
 * Who or what caused the account to be created.
 *
 * `ai` is representable so the refusal can be expressed and tested rather than being
 * unrepresentable and therefore unexamined. Same reasoning as K-01, and the same refusal.
 */
export const ORIGIN_KINDS = ['human', 'system', 'ai'] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

export interface AccountOrigin {
  readonly kind: OriginKind;
  /** A stable handle for the creator: a manifest unit id, an operator handle, a worker name. */
  readonly id: string;
}

/**
 * The immutable universal account.
 *
 * Five fields. Everything a reader expects to find here and does not — profile, capabilities,
 * verification, balances, roles, credentials — is listed in `FOREIGN_FIELDS` with its owner, and
 * refused rather than dropped.
 */
export interface UniversalAccount {
  /** Caller-supplied, opaque and stable. A duplicate is a refusal, never an overwrite. */
  readonly accountId: string;
  /**
   * The K-01 identity subject this account belongs to.
   *
   * Fixed at creation. There is no relink operation, at any layer: the account id is what orders,
   * payments and ledger entries reference, and moving it to another party after the fact would
   * reattribute all of them with nothing recording that it happened.
   */
  readonly subjectId: string;
  /** When the account came into existence, as a canonical UTC instant. */
  readonly createdAt: string;
  readonly origin: AccountOrigin;
  /** Stable across retries of one logical creation. */
  readonly idempotencyKey: string;
}

export type AccountErrorCode =
  /** The subject id names no K-01 subject. */
  | 'unknown-subject'
  /** That subject already has an account, and a party has exactly one. */
  | 'subject-already-has-account'
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** An identifier looks like a natural key: an email, a telephone number, a document number. */
  | 'natural-identifier'
  /** Something in the request looks like a credential or a secret. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** AI tried to author an authoritative account. */
  | 'ai-not-permitted'
  /** The request carried a field belonging to K-01, K-02, K-04, a profile, or a financial module. */
  | 'foreign-concern'
  /** An account with this id already exists. */
  | 'duplicate-account-id'
  /** The idempotency key was already used for a different account. */
  | 'idempotency-key-reuse'
  /** Nothing to read. */
  | 'no-such-account'
  /** An enlisted path tried to control a transaction it does not own. */
  | 'nested-transaction'
  /** A stored row, or a candidate account, is not what this component writes. */
  | 'malformed-record';

export class AccountError extends Error {
  readonly code: AccountErrorCode;

  constructor(code: AccountErrorCode, message: string) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}
