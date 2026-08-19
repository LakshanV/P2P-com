/**
 * K-03 Accounts — the persistence port (FND-004b).
 *
 * Four operations, and the shortness is the contract:
 *
 *   - `insertAccount` — create, refusing a duplicate id, a reused idempotency key, and a subject
 *     that already has an account
 *   - `findAccountById` — the lookup every downstream component will use
 *   - `findAccountBySubjectId` — "does this party already have an account", which is both the
 *     one-per-subject check and the way a caller holding a K-01 subject reaches its account
 *   - `findAccountByIdempotencyKey` — what makes a retry return the original rather than a second
 *     account for one party
 *
 * **There is no update, no delete, no relink and no merge.** Not a restricted one, not an internal
 * one. Orders, payments, ledger entries and audit records will all name these account ids; an
 * account whose subject can change silently reattributes every one of them, and one that can vanish
 * leaves them pointing at nothing. `tests/accounts-repository.test.ts` inspects the transaction
 * object at runtime and fails if an operation matching update, delete, relink or merge ever appears
 * — a rule enforced by a type is a rule a cast can undo.
 *
 * There is also no capability, role, balance or credential operation, because there is no such
 * state to operate on. That absence is asserted too: a port that grew a `setCapability` would be
 * the moment the one-account rule started bending.
 *
 * Owned by: K-03 Accounts.
 */

import { sealAccount, sealAccounts } from './immutable.ts';

import { AccountError, type UniversalAccount } from './types.ts';

export interface AccountTransaction {
  /** The exact account, or null. */
  findAccountById(accountId: string): Promise<UniversalAccount | null>;

  /**
   * The account belonging to this subject, or null.
   *
   * At most one can ever exist — that is the one-universal-account rule, and it is a uniqueness
   * constraint here and in the database rather than a convention.
   */
  findAccountBySubjectId(subjectId: string): Promise<UniversalAccount | null>;

  /** A previous creation with this idempotency key, if one exists. */
  findAccountByIdempotencyKey(idempotencyKey: string): Promise<UniversalAccount | null>;

  /**
   * Create an account. Must refuse a duplicate id, a reused idempotency key, and a second account
   * for a subject that already has one.
   *
   * There is deliberately no counterpart. An account is written once and read for ever.
   */
  insertAccount(account: UniversalAccount): Promise<void>;
}

export interface AccountRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written.
   */
  withTransaction<T>(body: (tx: AccountTransaction) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract, not a convenience double: it enforces the
 * same three uniqueness rules the database does, and it checks them **at commit against the store
 * as it stands** rather than against the snapshot the transaction read.
 *
 * That last part is what makes the one-account-per-subject race behave here as it would against a
 * server. Two creators that both read a store with no account for a subject would otherwise both
 * insert, producing two accounts for one party — which is the single invariant this component
 * exists to hold. K-08 shipped without that parity and every concurrency guarantee proved against
 * it was worth less than it appeared (CURRENT_IMPLEMENTATION_STATUS §11.15).
 */
export class InMemoryAccountRepository implements AccountRepository {
  #accounts: UniversalAccount[] = [];
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  accounts(): readonly UniversalAccount[] {
    return sealAccounts(this.#accounts);
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(accounts: readonly UniversalAccount[]): void {
    // Sealed on the way in: a test that seeds an array and then edits it must not be editing the
    // store. A shallow copy would have shared every `origin` object.
    this.#accounts = accounts.map(sealAccount);
  }

  async withTransaction<T>(body: (tx: AccountTransaction) => Promise<T>): Promise<T> {
    const base = this.#accounts.map(sealAccount);
    const working = base.map(sealAccount);
    const tx = new InMemoryAccountTransaction(working);

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

  /** Append this transaction's accounts onto the store as it stands now, or refuse. */
  #commit(base: readonly UniversalAccount[], working: readonly UniversalAccount[]): void {
    const baseIds = new Set(base.map((account) => account.accountId));
    const appended = working.filter((account) => !baseIds.has(account.accountId));
    if (appended.length === 0) return;

    const currentIds = new Set(this.#accounts.map((account) => account.accountId));
    const currentSubjects = new Map(
      this.#accounts.map((account) => [account.subjectId, account.accountId]),
    );
    const currentKeys = new Map(
      this.#accounts.map((account) => [account.idempotencyKey, account.accountId]),
    );

    for (const account of appended) {
      if (currentIds.has(account.accountId)) {
        throw new AccountError(
          'duplicate-account-id',
          `account ${account.accountId} was created by another transaction while this one was open`,
        );
      }
      const holder = currentSubjects.get(account.subjectId);
      if (holder !== undefined) {
        throw new AccountError(
          'subject-already-has-account',
          `subject ${account.subjectId} was given account ${holder} by another transaction while ` +
            'this one was open. A party has exactly one universal account',
        );
      }
      const keyHolder = currentKeys.get(account.idempotencyKey);
      if (keyHolder !== undefined) {
        throw new AccountError(
          'idempotency-key-reuse',
          `idempotency key "${account.idempotencyKey}" was used by account ${keyHolder}, created ` +
            'by another transaction while this one was open',
        );
      }
    }

    this.#accounts = [...this.#accounts, ...appended.map(sealAccount)];
  }
}

class InMemoryAccountTransaction implements AccountTransaction {
  readonly #accounts: UniversalAccount[];

  constructor(accounts: UniversalAccount[]) {
    this.#accounts = accounts;
  }

  findAccountById(accountId: string): Promise<UniversalAccount | null> {
    return this.#find((account) => account.accountId === accountId);
  }

  findAccountBySubjectId(subjectId: string): Promise<UniversalAccount | null> {
    return this.#find((account) => account.subjectId === subjectId);
  }

  findAccountByIdempotencyKey(idempotencyKey: string): Promise<UniversalAccount | null> {
    return this.#find((account) => account.idempotencyKey === idempotencyKey);
  }

  #find(predicate: (account: UniversalAccount) => boolean): Promise<UniversalAccount | null> {
    const found = this.#accounts.find(predicate);
    return Promise.resolve(found === undefined ? null : sealAccount(found));
  }

  insertAccount(account: UniversalAccount): Promise<void> {
    if (this.#accounts.some((existing) => existing.accountId === account.accountId)) {
      return Promise.reject(
        new AccountError(
          'duplicate-account-id',
          `account ${account.accountId} already exists. An account is created once and never ` +
            'rewritten, because everything downstream references it by this id',
        ),
      );
    }
    if (this.#accounts.some((existing) => existing.subjectId === account.subjectId)) {
      return Promise.reject(
        new AccountError(
          'subject-already-has-account',
          `subject ${account.subjectId} already has an account. One party, one universal ` +
            'account: a second would split the same person across two histories',
        ),
      );
    }
    if (this.#accounts.some((existing) => existing.idempotencyKey === account.idempotencyKey)) {
      return Promise.reject(
        new AccountError(
          'idempotency-key-reuse',
          `idempotency key "${account.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#accounts.push(sealAccount(account));
    return Promise.resolve();
  }
}
