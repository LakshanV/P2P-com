/**
 * K-01 Identity — domain types (FND-004a).
 *
 * An identity subject is the platform's answer to one question and no others: **what is the stable,
 * internal handle for this party?** Everything a reader might expect to find here — a name, an
 * email, a password, a session, an account, a capability, a verification level — belongs to another
 * component, and putting any of it here would be the single most expensive mistake available at
 * this layer.
 *
 * The reason is the guide's §4, ONE UNIVERSAL ACCOUNT: *do not create separate identities for
 * buyers, sellers, hosts or service providers*. If an identity carried a role, the platform would
 * need one per role, and a person who both buys and sells would be two parties who cannot see each
 * other's history. So the subject kind registry here deliberately has no `buyer` and no `seller` —
 * those are capabilities of an account (K-03 and the Capability & Verification module), activated
 * against one subject.
 *
 * Three properties follow from that and shape every type below:
 *
 *   - **Opaque.** The subject id is an internal handle, never a natural key. An identity whose id
 *     is somebody's email address writes that email into every foreign key, every audit record and
 *     every log line for the lifetime of the platform, and an erasure request then has no answer.
 *     Natural- and PII-shaped identifiers are refused, not warned about.
 *   - **Immutable.** A subject is created once. There is no update, no deletion and no merge at any
 *     layer, and the database refuses the first two by trigger. Everything downstream — accounts,
 *     ledger entries, audit records — will point at these ids, and an id that can change meaning is
 *     an id that silently reattributes history.
 *   - **Deterministic.** The caller supplies the id, the instant and the idempotency key. This
 *     component reads no clock and generates no randomness, so the same request twice is the same
 *     subject rather than two.
 *
 * Provider-neutral: nothing here knows about PostgreSQL. That is repository.ts and its adapters.
 *
 * Owned by: K-01 Identity.
 */

/**
 * What kind of party a subject stands for.
 *
 * Closed, small, and about *what the party is* rather than *what it may do*. Each entry has to
 * survive one question: would two parties of this kind ever need to be told apart by anything the
 * platform stores at the identity layer? A `buyer` fails that question — buying is something an
 * account does — while a person and a company genuinely differ in what can later be verified about
 * them and in what law applies to them.
 *
 * `ai` is absent on purpose and refused explicitly. An AI agent is not a party: it cannot hold an
 * account, owe money, consent to terms, or be sued. Giving it a subject would let it appear as a
 * counterparty in a commerce record, which is exactly the confusion the financial-zone rule exists
 * to prevent.
 */
export const SUBJECT_KINDS = ['person', 'organisation', 'system'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** Who or what caused a subject to be created. */
export const ORIGIN_KINDS = ['human', 'system', 'ai'] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

/**
 * The actor that created the subject.
 *
 * Recorded because "where did this identity come from" is the first question asked when one turns
 * out to be wrong, and because it is where AI is refused: `ai` is a permitted *value of the type*
 * precisely so that the refusal can be expressed and tested rather than being unrepresentable and
 * therefore unexamined. A caller that passes it gets a refusal naming the reason.
 *
 * This is **not** an authenticated actor. K-02 does not exist, so nothing has verified that the
 * origin is who the caller says. The contract records that plainly rather than implying otherwise.
 */
export interface IdentityOrigin {
  readonly kind: OriginKind;
  /** A stable handle for the creator: a manifest unit id, an operator handle, a worker name. */
  readonly id: string;
}

/**
 * The immutable creation record.
 *
 * Six fields, and the shortness is the design. Anything added here is a field every downstream
 * component inherits, and a field that turns out to belong to K-03 cannot be moved once accounts
 * reference it.
 */
export interface IdentitySubject {
  /** Caller-supplied, opaque and stable. A duplicate is a refusal, never an overwrite. */
  readonly subjectId: string;
  readonly kind: SubjectKind;
  /** When the subject came into existence, as a canonical UTC instant. */
  readonly createdAt: string;
  readonly origin: IdentityOrigin;
  /** Stable across retries of one logical creation. */
  readonly idempotencyKey: string;
}

export type IdentityErrorCode =
  /** The kind is not in the registry. */
  | 'unknown-subject-kind'
  /** The subject id, origin id or idempotency key is not a well-formed identifier. */
  | 'malformed-identifier'
  /** The identifier looks like a natural key: an email, a phone number, a document number. */
  | 'natural-identifier'
  /** Something in the request looks like a credential or a secret. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** AI tried to author an authoritative identity. */
  | 'ai-not-permitted'
  /** The request carried a field that belongs to K-02, K-03, K-04 or a profile. */
  | 'foreign-concern'
  /** A subject with this id already exists. */
  | 'duplicate-subject-id'
  /** The idempotency key was already used for a different subject. */
  | 'idempotency-key-reuse'
  /** Nothing to read. */
  | 'no-such-subject'
  /** Something tried to change or remove a subject. */
  | 'immutable-subject'
  /** Something moved underneath the transaction. */
  | 'concurrent-modification'
  /** An enlisted path tried to control a transaction it does not own. */
  | 'nested-transaction'
  /** A stored row is not what this component wrote. */
  | 'malformed-record';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}
