/**
 * K-01 Identity — the service (FND-004a).
 *
 * Two operations: create a subject, and look one up. The interesting half of `create` is what it
 * refuses, and the refusals are the component.
 *
 * **Create.** Validate, then append. Everything is checked before a transaction opens, so a
 * malformed request never occupies one. A retry with the same idempotency key returns the original
 * subject — and two retries that overlap in time converge on the winner rather than one of them
 * failing, because a caller retrying after a timeout has not done anything wrong. A key genuinely
 * reused for a *different* subject still fails closed: returning the earlier subject would hand the
 * caller an identity for a party it never asked about, which it would then attach an account to.
 *
 * **Look up.** By id, exactly. There is no search, no listing and no "find by email", and the
 * absence is deliberate: an identity lookup that takes personal data is an identity layer that
 * stores personal data, and this one stores none.
 *
 * There is deliberately **no third operation**. Nothing here updates, deactivates, deletes or
 * merges a subject.
 *
 * Deterministic by construction: the caller supplies the subject id, the instant and the
 * idempotency key. This component reads no clock and generates no randomness.
 *
 * Owned by: K-01 Identity. No API, no UI — see CONTRACT.md for why.
 */

import { sealSubject } from './immutable.ts';
import { FOREIGN_FIELDS, assertOpaqueIdentifier } from './registry.ts';
import type { IdentityRepository, IdentityTransaction } from './repository.ts';
import { validateSubject } from './validate.ts';
import {
  IdentityError,
  type IdentityOrigin,
  type IdentitySubject,
  type SubjectKind,
} from './types.ts';

/** Everything that identifies one logical creation. */
export interface CreateSubjectRequest {
  readonly subjectId: string;
  readonly kind: SubjectKind;
  readonly createdAt: string;
  readonly origin: IdentityOrigin;
  readonly idempotencyKey: string;
}

export interface CreateSubjectResult {
  readonly subject: IdentitySubject;
  /** True when this idempotency key had already produced this exact subject. */
  readonly deduplicated: boolean;
}

/** Exactly the keys a request may carry. Anything else is a modelling error, not a typo. */
const PERMITTED_REQUEST_KEYS: readonly string[] = [
  'subjectId',
  'kind',
  'createdAt',
  'origin',
  'idempotencyKey',
];

export class IdentityService {
  readonly #repository: IdentityRepository;

  constructor(repository: IdentityRepository) {
    this.#repository = repository;
  }

  /**
   * Create an identity subject.
   *
   * Validation happens before the transaction opens; a request that cannot be written never
   * occupies a connection.
   */
  async create(request: CreateSubjectRequest): Promise<CreateSubjectResult> {
    // Two checks, and they are different jobs. The first refuses fields belonging to K-02, K-03
    // and K-04 — only a *request* can carry those. The second is the shared judgement of a
    // finished subject, and the PostgreSQL decoder runs the very same function on every row it
    // reads, so a stored subject is held to exactly what creation would have demanded.
    assertNoForeignConcerns(request);
    const validated = validateSubject(
      {
        subjectId: request.subjectId,
        kind: request.kind,
        createdAt: request.createdAt,
        origin: request.origin,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    // Sealed before it is stored *and* before it is returned: the same boundary in both
    // directions. A caller that keeps the origin object it passed cannot reach into the store
    // through it, because `validateSubject` rebuilt it field by field.
    const subject = sealSubject(validated);

    try {
      return await this.#insert(subject);
    } catch (error) {
      // Two retries of one creation that overlap in time each read a store with no such key, so
      // both try to insert and one loses. The loser has not failed — the creation it was retrying
      // succeeded — so it re-reads and converges, checking the content exactly as the sequential
      // path does. A key genuinely reused for a different subject still fails closed.
      const conflicted =
        error instanceof IdentityError &&
        (error.code === 'idempotency-key-reuse' || error.code === 'duplicate-subject-id');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findSubjectByIdempotencyKey(subject.idempotencyKey),
      );
      if (winner === null) throw error;

      assertSameSubject(winner, subject);
      return { subject: sealSubject(winner), deduplicated: true };
    }
  }

  async #insert(subject: IdentitySubject): Promise<CreateSubjectResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existing = await tx.findSubjectByIdempotencyKey(subject.idempotencyKey);
      if (existing !== null) {
        assertSameSubject(existing, subject);
        return { subject: sealSubject(existing), deduplicated: true };
      }

      await tx.insertSubject(subject);
      return { subject: sealSubject(subject), deduplicated: false };
    });
  }

  /** One subject, by id, or null. The lookup every downstream component will use. */
  async findSubject(subjectId: string): Promise<IdentitySubject | null> {
    assertOpaqueIdentifier(subjectId, 'subjectId');
    const subject = await this.#repository.withTransaction((tx: IdentityTransaction) =>
      tx.findSubjectById(subjectId),
    );
    return subject === null ? null : sealSubject(subject);
  }

  /** The same, for a caller whose next step makes no sense without the subject. */
  async requireSubject(subjectId: string): Promise<IdentitySubject> {
    const subject = await this.findSubject(subjectId);
    if (subject === null) {
      throw new IdentityError('no-such-subject', `no identity subject ${subjectId}`);
    }
    return subject;
  }

  /**
   * Does this subject exist?
   *
   * Separate from `findSubject` because "is this id real" is the question a foreign-key check asks,
   * and a caller that only needs the answer should not be handed a record it did not need.
   */
  async exists(subjectId: string): Promise<boolean> {
    return (await this.findSubject(subjectId)) !== null;
  }
}

/**
 * Refuse a request that carries another component's concern.
 *
 * The executable half of "an identity is not an account". A caller passing `accountId` or `email`
 * is not making a typo — it is modelling the thing wrongly — and silently ignoring the field would
 * store nothing while leaving the caller believing its account link or its contact details had been
 * recorded. Unknown keys are refused too, so a field invented tomorrow is refused rather than
 * dropped.
 */
function assertNoForeignConcerns(request: CreateSubjectRequest): void {
  if (request === null || typeof request !== 'object') {
    throw new IdentityError(
      'malformed-record',
      `a create request must be an object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (PERMITTED_REQUEST_KEYS.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new IdentityError(
        'foreign-concern',
        `a create request carried "${key}", but ${owner}. An identity subject is a stable handle ` +
          'and nothing else; conflating it with an account, a credential or a profile is how a ' +
          'platform ends up unable to say which of its records are personal data',
      );
    }
    throw new IdentityError(
      'foreign-concern',
      `a create request carried the unrecognised field "${key}". The permitted fields are ` +
        `${PERMITTED_REQUEST_KEYS.join(', ')}; anything else would be accepted and silently ` +
        'dropped, leaving the caller believing it had been stored',
    );
  }
}

/**
 * A retry must be a retry of *this* creation.
 *
 * Compared field by field rather than by a stored digest, because the record has five fields and
 * they all fit in one comparison. A digest would be a second representation of the same content
 * that could drift out of step with it.
 */
function assertSameSubject(existing: IdentitySubject, incoming: IdentitySubject): void {
  const differences: string[] = [];
  const compare = (field: string, was: unknown, now: unknown): void => {
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      differences.push(`${field} was ${JSON.stringify(was)}, now ${JSON.stringify(now)}`);
    }
  };

  compare('subjectId', existing.subjectId, incoming.subjectId);
  compare('kind', existing.kind, incoming.kind);
  compare('createdAt', existing.createdAt, incoming.createdAt);
  compare('origin', existing.origin, incoming.origin);

  if (differences.length === 0) return;

  throw new IdentityError(
    'idempotency-key-reuse',
    `idempotency key "${incoming.idempotencyKey}" was already used for a different subject ` +
      `(${differences.join('; ')}). Returning the earlier subject would hand back an identity ` +
      'for a party the caller never asked about, which it would then attach an account to',
  );
}
