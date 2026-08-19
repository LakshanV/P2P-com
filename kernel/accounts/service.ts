/**
 * K-03 Accounts — the service (FND-004b).
 *
 * Two operations: open one universal account for an existing party, and look one up. As with K-01,
 * the interesting half of `open` is what it refuses.
 *
 * **Open.** Validate, confirm the subject exists through K-01's contract, then append. The order
 * matters: a malformed request never reaches K-01, and an unknown subject never opens an account
 * transaction. A retry with the same idempotency key returns the original account, and two retries
 * that overlap converge on the winner — a caller retrying after a timeout has done nothing wrong.
 *
 * **One account per subject** is the invariant everything else serves. It is enforced three times
 * over: read-then-refuse inside the transaction, a uniqueness check at commit in the reference
 * repository, and a `UNIQUE` constraint in migration 0007. Two of those exist because the first is
 * a race: two callers that both read "no account for this subject" would both insert, and one party
 * would end up split across two histories that can never be reconciled.
 *
 * **Look up.** By account id or by subject id. Nothing else — no search, no listing, no "find by
 * email", because this component holds nothing to search by that is not an opaque handle.
 *
 * There is deliberately **no third operation**. Nothing here updates, relinks, closes, deletes or
 * merges an account, and nothing activates a capability, grants a role, sets a verification level
 * or records a balance. Those belong to components named in `FOREIGN_FIELDS`.
 *
 * Deterministic by construction: the caller supplies the account id, the instant and the
 * idempotency key. This component reads no clock and generates no randomness.
 *
 * Owned by: K-03 Accounts. No API, no UI — see CONTRACT.md for why.
 */

import { sealAccount } from './immutable.ts';
import { FOREIGN_FIELDS, assertAccountIdentifier } from './registry.ts';
import type { AccountRepository, AccountTransaction } from './repository.ts';
import type { SubjectLookup } from './subject-lookup.ts';
import { validateAccount } from './validate.ts';
import { AccountError, type AccountOrigin, type UniversalAccount } from './types.ts';

/** Everything that identifies one logical account opening. */
export interface OpenAccountRequest {
  readonly accountId: string;
  readonly subjectId: string;
  readonly createdAt: string;
  readonly origin: AccountOrigin;
  readonly idempotencyKey: string;
}

export interface OpenAccountResult {
  readonly account: UniversalAccount;
  /** True when this idempotency key had already produced this exact account. */
  readonly deduplicated: boolean;
}

/** Exactly the keys a request may carry. Anything else is a modelling error, not a typo. */
const PERMITTED_REQUEST_KEYS: readonly string[] = [
  'accountId',
  'subjectId',
  'createdAt',
  'origin',
  'idempotencyKey',
];

export class AccountService {
  readonly #repository: AccountRepository;
  readonly #subjects: SubjectLookup;

  /**
   * @param repository where accounts are stored.
   * @param subjects K-01's existence check, injected. `IdentityService` satisfies it structurally;
   *   see subject-lookup.ts for why this is a port rather than a foreign key.
   */
  constructor(repository: AccountRepository, subjects: SubjectLookup) {
    this.#repository = repository;
    this.#subjects = subjects;
  }

  /**
   * Open the universal account for an existing party.
   *
   * Validation happens before K-01 is consulted, and K-01 is consulted before a transaction opens.
   * A request that cannot be written never occupies a connection, and never troubles another
   * component either.
   */
  async open(request: OpenAccountRequest): Promise<OpenAccountResult> {
    // Two checks, and they are different jobs. The first refuses fields belonging to K-01, K-02,
    // K-04, a profile or a financial module — only a *request* can carry those. The second is the
    // shared judgement of a finished account, and the PostgreSQL decoder runs the very same
    // function on every row it reads.
    assertNoForeignConcerns(request);
    const validated = validateAccount(
      {
        accountId: request.accountId,
        subjectId: request.subjectId,
        createdAt: request.createdAt,
        origin: request.origin,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    // K-01, through its public contract and nothing else. Before the transaction, so an account for
    // a party nobody has heard of never touches the table — and so the refusal names the subject
    // rather than arriving later as a constraint violation somebody has to decode.
    if (!(await this.#subjects.exists(validated.subjectId))) {
      throw new AccountError(
        'unknown-subject',
        `no identity subject ${validated.subjectId}. An account is the party a contract is with, ` +
          'so it must belong to a subject K-01 has already recorded — creating one here would ' +
          'invent a party, which is exactly what K-01 exists to prevent',
      );
    }

    const account = sealAccount(validated);

    try {
      return await this.#insert(account);
    } catch (error) {
      // Two retries of one opening that overlap in time each read a store with no such key, so
      // both try to insert and one loses. The loser has not failed — the opening it was retrying
      // succeeded — so it re-reads and converges, checking the content exactly as the sequential
      // path does.
      //
      // `subject-already-has-account` is deliberately *not* in this list. A second account id for
      // one subject is a caller error, not a retry, and converging on it would hand back an
      // account the caller did not ask for and then let it believe its own id had been used.
      const conflicted =
        error instanceof AccountError &&
        (error.code === 'idempotency-key-reuse' || error.code === 'duplicate-account-id');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findAccountByIdempotencyKey(account.idempotencyKey),
      );
      if (winner === null) throw error;

      assertSameAccount(winner, account);
      return { account: sealAccount(winner), deduplicated: true };
    }
  }

  async #insert(account: UniversalAccount): Promise<OpenAccountResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existing = await tx.findAccountByIdempotencyKey(account.idempotencyKey);
      if (existing !== null) {
        assertSameAccount(existing, account);
        return { account: sealAccount(existing), deduplicated: true };
      }

      // Read-then-refuse, so the common case gets a refusal naming the account the party already
      // has rather than a bare uniqueness violation. The uniqueness constraint behind it is what
      // handles the race this read cannot see.
      const held = await tx.findAccountBySubjectId(account.subjectId);
      if (held !== null) {
        throw new AccountError(
          'subject-already-has-account',
          `subject ${account.subjectId} already holds account ${held.accountId}. One party, one ` +
            'universal account (guide §4): a second would split the same person across two ' +
            'histories that can never be reconciled. Capabilities are what differ between ' +
            'parties, and they are activated against the account that exists',
        );
      }

      await tx.insertAccount(account);
      return { account: sealAccount(account), deduplicated: false };
    });
  }

  /** One account, by id, or null. */
  async findAccount(accountId: string): Promise<UniversalAccount | null> {
    assertAccountIdentifier(accountId, 'accountId');
    const account = await this.#repository.withTransaction((tx: AccountTransaction) =>
      tx.findAccountById(accountId),
    );
    return account === null ? null : sealAccount(account);
  }

  /** The same, for a caller whose next step makes no sense without the account. */
  async requireAccount(accountId: string): Promise<UniversalAccount> {
    const account = await this.findAccount(accountId);
    if (account === null) {
      throw new AccountError('no-such-account', `no universal account ${accountId}`);
    }
    return account;
  }

  /**
   * The account belonging to a party, or null.
   *
   * The lookup a caller holding a K-01 subject actually wants. Singular by construction — the
   * one-per-subject rule is what makes a `find`, rather than a `list`, the honest signature.
   */
  async findAccountForSubject(subjectId: string): Promise<UniversalAccount | null> {
    assertAccountIdentifier(subjectId, 'subjectId');
    const account = await this.#repository.withTransaction((tx: AccountTransaction) =>
      tx.findAccountBySubjectId(subjectId),
    );
    return account === null ? null : sealAccount(account);
  }

  /** Does this party already have an account? The question `open` asks, exposed for a caller. */
  async hasAccount(subjectId: string): Promise<boolean> {
    return (await this.findAccountForSubject(subjectId)) !== null;
  }
}

/**
 * Refuse a request that carries another component's concern.
 *
 * The executable half of "one universal account with capabilities". A caller passing `capabilities`
 * or `balance` is not making a typo — it is modelling the thing wrongly — and silently ignoring the
 * field would store nothing while leaving the caller believing a seller capability had been
 * activated or a balance recorded. Unknown keys are refused too, so a field invented tomorrow is
 * refused rather than dropped.
 */
function assertNoForeignConcerns(request: OpenAccountRequest): void {
  if (request === null || typeof request !== 'object') {
    throw new AccountError(
      'malformed-record',
      `an open request must be an object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (PERMITTED_REQUEST_KEYS.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new AccountError(
        'foreign-concern',
        `an open request carried "${key}", but ${owner}. A universal account is a link and a ` +
          'provenance record; the moment it carries a capability, a balance or a persona, the ' +
          '"one account" rule starts bending — because the next question is what to do about a ' +
          'party that needs two of them, and the answer people reach for is a second account',
      );
    }
    throw new AccountError(
      'foreign-concern',
      `an open request carried the unrecognised field "${key}". The permitted fields are ` +
        `${PERMITTED_REQUEST_KEYS.join(', ')}; anything else would be accepted and silently ` +
        'dropped, leaving the caller believing it had been stored',
    );
  }
}

/**
 * A retry must be a retry of *this* opening.
 *
 * Compared field by field rather than by a stored digest, because the record has five fields and
 * they all fit in one comparison. A digest would be a second representation of the same content
 * that could drift out of step with it.
 */
function assertSameAccount(existing: UniversalAccount, incoming: UniversalAccount): void {
  const differences: string[] = [];
  const compare = (field: string, was: unknown, now: unknown): void => {
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      differences.push(`${field} was ${JSON.stringify(was)}, now ${JSON.stringify(now)}`);
    }
  };

  compare('accountId', existing.accountId, incoming.accountId);
  compare('subjectId', existing.subjectId, incoming.subjectId);
  compare('createdAt', existing.createdAt, incoming.createdAt);
  compare('origin', existing.origin, incoming.origin);

  if (differences.length === 0) return;

  throw new AccountError(
    'idempotency-key-reuse',
    `idempotency key "${incoming.idempotencyKey}" was already used for a different account ` +
      `(${differences.join('; ')}). Returning the earlier account would hand back the wrong ` +
      "party's account, which the caller would then transact against",
  );
}
