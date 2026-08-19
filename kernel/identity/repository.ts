/**
 * K-01 Identity — the persistence port (FND-004a).
 *
 * Three operations, and the shortness is the contract:
 *
 *   - `insertSubject` — create, refusing a duplicate id or a reused idempotency key
 *   - `findSubjectById` — the deterministic lookup everything downstream will use
 *   - `findSubjectByIdempotencyKey` — what makes a retry return the original rather than a second
 *     subject for one party
 *
 * **There is no update, no delete and no merge.** Not a restricted one, not an internal one.
 * Accounts, orders, ledger entries and audit records will all point at these ids; an id whose
 * meaning can change is an id that silently reattributes history, and an id that can vanish leaves
 * every one of those rows pointing at nothing. `tests/identity-repository.test.ts` inspects the
 * transaction object at runtime and fails if an operation matching update, delete or merge ever
 * appears — a rule enforced by a type is a rule a cast can undo.
 *
 * Merge in particular is *deferred rather than forgotten*. Two subjects that turn out to be one
 * party is a real situation, and the answer is a deliberate design with a linkage record and an
 * audit trail (K-09), not an `UPDATE` here.
 *
 * Owned by: K-01 Identity.
 */

import { sealSubject, sealSubjects } from './immutable.ts';

import { IdentityError, type IdentitySubject } from './types.ts';

export interface IdentityTransaction {
  /** The exact subject, or null. */
  findSubjectById(subjectId: string): Promise<IdentitySubject | null>;

  /** A previous creation with this idempotency key, if one exists. */
  findSubjectByIdempotencyKey(idempotencyKey: string): Promise<IdentitySubject | null>;

  /**
   * Create a subject. Must refuse a duplicate id and a reused idempotency key.
   *
   * There is deliberately no counterpart. A subject is written once and read for ever.
   */
  insertSubject(subject: IdentitySubject): Promise<void>;
}

export interface IdentityRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written.
   */
  withTransaction<T>(body: (tx: IdentityTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract, not a convenience double: it enforces the
 * same invariants the database does — unique subject ids, unique idempotency keys, and creation
 * that appends and never rewrites.
 *
 * Transactions read a snapshot on entry and, on commit, append only what they wrote, refusing if
 * another transaction claimed the same id or key first. Two creators that overlap therefore behave
 * here as they would against a server. That parity matters more than it looks: K-08 shipped with an
 * in-memory repository that accepted a conflict PostgreSQL rejects, so every concurrency guarantee
 * proved against it was worth less than it appeared (§11.15).
 */
export class InMemoryIdentityRepository implements IdentityRepository {
  #subjects: IdentitySubject[] = [];
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  subjects(): readonly IdentitySubject[] {
    return sealSubjects(this.#subjects);
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(subjects: readonly IdentitySubject[]): void {
    // Sealed on the way in: a test that seeds an array and then edits it must not be editing the
    // store. A shallow copy would have shared every `origin` object.
    this.#subjects = subjects.map(sealSubject);
  }

  async withTransaction<T>(body: (tx: IdentityTransaction) => Promise<T>): Promise<T> {
    const base = this.#subjects.map(sealSubject);
    const working = base.map(sealSubject);
    const tx = new InMemoryIdentityTransaction(working);

    try {
      const result = await body(tx);
      this.#commit(base, working);
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  /**
   * Append this transaction's subjects onto the store as it stands now.
   *
   * The conflict checks are against the *current* store rather than the snapshot the transaction
   * read. Two creators that both read a store with no such idempotency key would otherwise both
   * append, producing two subjects for one party — which is exactly what an idempotency key exists
   * to prevent, and exactly what the database's unique constraint would have refused.
   */
  #commit(base: readonly IdentitySubject[], working: readonly IdentitySubject[]): void {
    const baseIds = new Set(base.map((subject) => subject.subjectId));
    const appended = working.filter((subject) => !baseIds.has(subject.subjectId));
    if (appended.length === 0) return;

    const currentIds = new Set(this.#subjects.map((subject) => subject.subjectId));
    const currentKeys = new Map(
      this.#subjects.map((subject) => [subject.idempotencyKey, subject.subjectId]),
    );

    for (const subject of appended) {
      if (currentIds.has(subject.subjectId)) {
        throw new IdentityError(
          'duplicate-subject-id',
          `subject ${subject.subjectId} was created by another transaction while this one was open`,
        );
      }
      const holder = currentKeys.get(subject.idempotencyKey);
      if (holder !== undefined) {
        throw new IdentityError(
          'idempotency-key-reuse',
          `idempotency key "${subject.idempotencyKey}" was used by subject ${holder}, created by ` +
            'another transaction while this one was open',
        );
      }
    }

    this.#subjects = [...this.#subjects, ...appended.map(sealSubject)];
  }
}

class InMemoryIdentityTransaction implements IdentityTransaction {
  readonly #subjects: IdentitySubject[];

  constructor(subjects: IdentitySubject[]) {
    this.#subjects = subjects;
  }

  findSubjectById(subjectId: string): Promise<IdentitySubject | null> {
    const found = this.#subjects.find((subject) => subject.subjectId === subjectId);
    return Promise.resolve(found === undefined ? null : sealSubject(found));
  }

  findSubjectByIdempotencyKey(idempotencyKey: string): Promise<IdentitySubject | null> {
    const found = this.#subjects.find((subject) => subject.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealSubject(found));
  }

  insertSubject(subject: IdentitySubject): Promise<void> {
    if (this.#subjects.some((existing) => existing.subjectId === subject.subjectId)) {
      return Promise.reject(
        new IdentityError(
          'duplicate-subject-id',
          `subject ${subject.subjectId} already exists. An identity is created once and never ` +
            'rewritten, because everything downstream references it by this id',
        ),
      );
    }
    if (this.#subjects.some((existing) => existing.idempotencyKey === subject.idempotencyKey)) {
      return Promise.reject(
        new IdentityError(
          'idempotency-key-reuse',
          `idempotency key "${subject.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#subjects.push(sealSubject(subject));
    return Promise.resolve();
  }
}
