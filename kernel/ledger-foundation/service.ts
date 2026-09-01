/**
 * K-10 Ledger Foundation — the service.
 *
 * Four operations:
 *
 *   `registerAssetType` — create an asset type, refusing duplicates and malformed definitions.
 *   `createAccount`     — create a ledger account in one asset type.
 *   `postTransaction`   — atomically store a balanced transaction and its entries, then emit an
 *                         event and an audit record through the module's outbox.
 *   `getBalance`        — derive the account's available, pending and locked positions from every
 *                         entry posted to it.
 *
 * Deterministic by construction: the caller supplies the identifiers and the instants. Nothing here
 * reads a clock or generates randomness.
 *
 * Owned by: K-10 Ledger Foundation.
 */

import { sealAssetType } from './immutable.ts';
import { makeLedgerTransactionPostedAction, makeLedgerTransactionPostedEvent } from './outbox.ts';
import type { LedgerRepository } from './repository.ts';
import { assertAssetTypeId, assertOpaqueIdentifier } from './registry.ts';
import { validateAccount, validateAssetType, validateTransaction } from './validate.ts';
import {
  LedgerError,
  type AssetClass,
  type AssetType,
  type BalanceState,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerTransaction,
  type NormalBalance,
  type AccountBalance,
} from './types.ts';

export interface RegisterAssetTypeRequest {
  readonly assetTypeId: string;
  readonly assetClass: AssetClass;
  readonly symbol: string;
  readonly precision: number;
  readonly transferability: boolean;
  readonly withdrawability: boolean;
  readonly valuationSource: string;
  /** The opaque identifier of the party that issued this value and stands behind it. */
  readonly issuer: string;
  /** The lower_snake_case name of the minor unit, e.g. `cent`, `satoshi`, `point`. */
  readonly unit: string;
  readonly redeemable: boolean;
  readonly convertible: boolean;
  /** Days from issue until the value expires, or null when it never expires. */
  readonly expiryDays: number | null;
  /** Structured limits on how the value may be used. An empty object means unrestricted. */
  readonly restrictions: Readonly<Record<string, unknown>>;
  /** The custodian holding the underlying value, or null when the platform holds it. */
  readonly custodyProvider: string | null;
  /** ISO 3166-1 alpha-2, or `GLOBAL` when the value is not bound to one jurisdiction. */
  readonly jurisdiction: string;
}

export interface CreateAccountRequest {
  readonly accountId: string;
  readonly assetTypeId: string;
  readonly ownerId: string;
  readonly normalBalance: NormalBalance;
  readonly createdAt: string;
  readonly idempotencyKey: string;
}

export interface PostTransactionRequestEntry {
  readonly accountId: string;
  readonly side: 'debit' | 'credit';
  /**
   * Which of the account's three positions this line moves. Omitted means `available`: a line that
   * does not say otherwise is moving spendable value.
   */
  readonly balanceState?: BalanceState;
  /** Non-negative integer minor units. Accepts bigint, a safe integer number, or a decimal string. */
  readonly amount: bigint | number | string;
}

export interface PostTransactionRequest {
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly postedAt: string;
  /** Every entry must reference an account denominated in this asset type. */
  readonly assetTypeId: string;
  readonly entries: readonly PostTransactionRequestEntry[];
}

export interface RegisterAssetTypeResult {
  readonly assetType: AssetType;
  readonly deduplicated: boolean;
}

export interface CreateAccountResult {
  readonly account: LedgerAccount;
  readonly deduplicated: boolean;
}

export interface PostTransactionResult {
  readonly transaction: LedgerTransaction;
  readonly deduplicated: boolean;
}

export class LedgerService {
  readonly #repository: LedgerRepository;

  constructor(repository: LedgerRepository) {
    this.#repository = repository;
  }

  /**
   * Register an asset type.
   *
   * A duplicate id is refused. There is no idempotency key: an asset type is a named unit of account,
   * and re-registering the same id with different properties would silently change what every account
   * denominated in it means.
   */
  async registerAssetType(request: RegisterAssetTypeRequest): Promise<RegisterAssetTypeResult> {
    assertNoForeignConcerns(request, REGISTER_ASSET_KEYS, 'registerAssetType');
    // Sealed here, not only in the repository. `restrictions` is caller-supplied JSON, so the
    // record the caller gets back must not be a handle onto the object it passed in.
    const assetType = sealAssetType(
      validateAssetType(
        {
          assetTypeId: request.assetTypeId,
          assetClass: request.assetClass,
          symbol: request.symbol,
          precision: request.precision,
          transferability: request.transferability,
          withdrawability: request.withdrawability,
          valuationSource: request.valuationSource,
          issuer: request.issuer,
          unit: request.unit,
          redeemable: request.redeemable,
          convertible: request.convertible,
          expiryDays: request.expiryDays,
          restrictions: request.restrictions,
          custodyProvider: request.custodyProvider,
          jurisdiction: request.jurisdiction,
        },
        'request',
      ),
    );

    return this.#repository.withTransaction(async (tx) => {
      const existing = await tx.findAssetTypeById(assetType.assetTypeId);
      if (existing !== null) {
        if (assetTypeEquals(existing, assetType)) {
          return { assetType: existing, deduplicated: true };
        }
        throw new LedgerError(
          'duplicate-asset-type-id',
          `asset type ${assetType.assetTypeId} already exists with different properties. ` +
            'Asset types name a unit of account; redefining one would change what every account ' +
            'denominated in it means',
        );
      }

      await tx.insertAssetType(assetType);
      return { assetType, deduplicated: false };
    });
  }

  /**
   * Create a ledger account.
   *
   * Refuses duplicate ids, reused idempotency keys, unknown asset types and malformed identifiers.
   */
  async createAccount(request: CreateAccountRequest): Promise<CreateAccountResult> {
    assertNoForeignConcerns(request, CREATE_ACCOUNT_KEYS, 'createAccount');
    const account = validateAccount(
      {
        accountId: request.accountId,
        assetTypeId: request.assetTypeId,
        ownerId: request.ownerId,
        normalBalance: request.normalBalance,
        createdAt: request.createdAt,
        idempotencyKey: request.idempotencyKey,
      },
      'request',
    );

    try {
      return await this.#insertAccount(account);
    } catch (error) {
      const conflicted =
        error instanceof LedgerError &&
        (error.code === 'duplicate-account-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findAccountByIdempotencyKey(account.idempotencyKey),
      );
      if (winner === null || !accountEquals(winner, account)) throw error;
      return { account: winner, deduplicated: true };
    }
  }

  async #insertAccount(account: LedgerAccount): Promise<CreateAccountResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findAccountByIdempotencyKey(account.idempotencyKey);
      if (existingKey !== null) {
        if (!accountEquals(existingKey, account)) {
          throw new LedgerError(
            'idempotency-key-reuse',
            `idempotency key "${account.idempotencyKey}" has already been used for a different account`,
          );
        }
        return { account: existingKey, deduplicated: true };
      }

      const existingId = await tx.findAccountById(account.accountId);
      if (existingId !== null) {
        if (accountEquals(existingId, account)) {
          return { account: existingId, deduplicated: true };
        }
        throw new LedgerError(
          'duplicate-account-id',
          `account ${account.accountId} already exists. A ledger account is created once and ` +
            'never rewritten, because every entry references it',
        );
      }

      const assetType = await tx.findAssetTypeById(account.assetTypeId);
      if (assetType === null) {
        throw new LedgerError(
          'unknown-asset-type',
          `asset type ${account.assetTypeId} is not registered. An account must be denominated in ` +
            'an asset type K-10 already recognises',
        );
      }

      await tx.insertAccount(account);
      return { account, deduplicated: false };
    });
  }

  /**
   * Post a balanced ledger transaction.
   *
   * Validation checks every entry against a real account, enforces a single asset type across all
   * lines, ensures debits equal credits, and refuses negative amounts. The transaction and its
   * entries, plus the outbox rows, are stored atomically.
   */
  async postTransaction(request: PostTransactionRequest): Promise<PostTransactionResult> {
    assertNoForeignConcerns(request, POST_TRANSACTION_KEYS, 'postTransaction');
    for (const entry of request.entries) {
      assertNoForeignConcerns(entry, ENTRY_KEYS, 'postTransaction entry');
    }

    const transaction = validateTransaction(
      {
        transactionId: request.transactionId,
        idempotencyKey: request.idempotencyKey,
        postedAt: request.postedAt,
        assetTypeId: request.assetTypeId,
        entries: request.entries.map((entry) => ({
          accountId: entry.accountId,
          side: entry.side,
          // Left undefined when the caller did not say; `validate` reads that as `available`.
          balanceState: entry.balanceState,
          amount: entry.amount,
        })),
      },
      'request',
    );

    try {
      return await this.#insertTransaction(transaction);
    } catch (error) {
      const conflicted =
        error instanceof LedgerError &&
        (error.code === 'duplicate-transaction-id' || error.code === 'idempotency-key-reuse');
      if (!conflicted) throw error;

      const winner = await this.#repository.withTransaction((tx) =>
        tx.findTransactionByIdempotencyKey(transaction.idempotencyKey),
      );
      if (winner === null || !transactionEquals(winner, transaction)) throw error;
      return { transaction: winner, deduplicated: true };
    }
  }

  async #insertTransaction(transaction: LedgerTransaction): Promise<PostTransactionResult> {
    return this.#repository.withTransaction(async (tx) => {
      const existingKey = await tx.findTransactionByIdempotencyKey(transaction.idempotencyKey);
      if (existingKey !== null) {
        if (!transactionEquals(existingKey, transaction)) {
          throw new LedgerError(
            'idempotency-key-reuse',
            `idempotency key "${transaction.idempotencyKey}" has already been used for a different transaction`,
          );
        }
        return { transaction: existingKey, deduplicated: true };
      }

      const existingId = await tx.findTransactionById(transaction.transactionId);
      if (existingId !== null) {
        throw new LedgerError(
          'duplicate-transaction-id',
          `transaction ${transaction.transactionId} already exists. A transaction is written ` +
            'once and never rewritten, because it is the evidence that value moved',
        );
      }

      const accounts = await tx.findAccountsById(
        transaction.entries.map((entry) => entry.accountId),
      );
      for (const entry of transaction.entries) {
        const account = accounts.get(entry.accountId);
        if (account === undefined) {
          throw new LedgerError(
            'unknown-account',
            `entry references account ${entry.accountId}, which does not exist. A transaction may ` +
              'only move value between accounts K-10 has already created',
          );
        }
        if (account.assetTypeId !== transaction.assetTypeId) {
          throw new LedgerError(
            'mixed-asset-type',
            `entry references account ${entry.accountId} denominated in ${account.assetTypeId}, ` +
              `but the transaction is in ${transaction.assetTypeId}. All lines of a transaction ` +
              'must be in the same asset type',
          );
        }
      }

      await tx.insertTransaction(transaction);

      const correlationId = transaction.transactionId;
      const causationId: string | null = null;
      await tx.insertOutbox(
        makeLedgerTransactionPostedEvent(transaction, correlationId, causationId),
      );
      await tx.insertOutbox(
        makeLedgerTransactionPostedAction(transaction, correlationId, causationId),
      );

      return { transaction, deduplicated: false };
    });
  }

  /** The derived balance for one account, or a refusal if the account does not exist. */
  async getBalance(accountId: string): Promise<AccountBalance> {
    assertOpaqueIdentifier(accountId, 'accountId');
    return this.#repository.withTransaction(async (tx) => {
      const account = await tx.findAccountById(accountId);
      if (account === null) {
        throw new LedgerError('no-such-account', `no ledger account ${accountId}`);
      }
      const entries = await tx.findEntriesByAccountId(accountId);
      return computeBalance(account, entries);
    });
  }

  /** Look up one account, or null. */
  async findAccount(accountId: string): Promise<LedgerAccount | null> {
    assertOpaqueIdentifier(accountId, 'accountId');
    return this.#repository.withTransaction((tx) => tx.findAccountById(accountId));
  }

  /** Look up one transaction, or null. */
  async findTransaction(transactionId: string): Promise<LedgerTransaction | null> {
    assertOpaqueIdentifier(transactionId, 'transactionId');
    return this.#repository.withTransaction((tx) => tx.findTransactionById(transactionId));
  }

  /**
   * Look up one asset type, or null.
   *
   * K-10 records what a value *is* — its issuer, whether it may be withdrawn or transferred, what
   * it expires after, what it is restricted to — and until now provided no way to read any of it
   * back. That made the metadata unusable by the units that need it most: a screen showing somebody
   * a reward balance has to be able to say the value cannot be withdrawn, and the honest place to
   * say so is next to the number. Without this it would either omit the fact or hardcode it, and
   * both are how a holder finds out at the till.
   */
  async findAssetType(assetTypeId: string): Promise<AssetType | null> {
    // Held to K-10's own id rule rather than the opaque-identifier rule: an asset type id is
    // lower_snake_case and public, not an opaque handle.
    assertAssetTypeId(assetTypeId, 'assetTypeId');
    return this.#repository.withTransaction((tx) => tx.findAssetTypeById(assetTypeId));
  }
}

const REGISTER_ASSET_KEYS: readonly string[] = [
  'assetTypeId',
  'assetClass',
  'symbol',
  'precision',
  'transferability',
  'withdrawability',
  'valuationSource',
  'issuer',
  'unit',
  'redeemable',
  'convertible',
  'expiryDays',
  'restrictions',
  'custodyProvider',
  'jurisdiction',
];

const CREATE_ACCOUNT_KEYS: readonly string[] = [
  'accountId',
  'assetTypeId',
  'ownerId',
  'normalBalance',
  'createdAt',
  'idempotencyKey',
];

const POST_TRANSACTION_KEYS: readonly string[] = [
  'transactionId',
  'idempotencyKey',
  'postedAt',
  'assetTypeId',
  'entries',
];

const ENTRY_KEYS: readonly string[] = ['accountId', 'side', 'balanceState', 'amount'];

const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // K-01 owns the party.
  subjectId:
    'K-01 Identity owns the subject; an account references one by ownerId and does not embed it',
  // K-02 owns authentication.
  sessionId: 'K-02 Authentication owns sessions; nothing has authenticated anybody yet',
  token: 'K-02 Authentication owns tokens',
  // K-03 owns the universal account.
  universalAccountId: 'K-03 Accounts owns the universal account; the ledger owns positions',
  // K-04 owns permissions.
  role: 'K-04 Permissions owns roles and grants',
  // No AI in the financial authority zone.
  aiSuggested: 'AI may not author a ledger transaction',
  // No business-module fields on a ledger record.
  price: 'pricing is a business-module concern; only amounts are posted here',
  listingId: 'listings belong to the marketplace modules, not to the ledger',
  orderId: 'orders belong to the marketplace modules, not to the ledger',
});

function assertNoForeignConcerns(
  request: object,
  permitted: readonly string[],
  operation: string,
): void {
  if (request === null || typeof request !== 'object') {
    throw new LedgerError(
      'malformed-record',
      `${operation} needs a request object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const owner = FOREIGN_FIELDS[key];
    if (owner !== undefined) {
      throw new LedgerError(
        'foreign-concern',
        `${operation} carried "${key}", but ${owner}. A ledger record carries only what K-10 owns`,
      );
    }
    throw new LedgerError(
      'foreign-concern',
      `${operation} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

/**
 * Derive an account's three positions from its entries.
 *
 * Each position is summed independently and then signed by the account's normal balance, so a
 * transfer between positions — debit one, credit another, on the same account — moves value without
 * changing the total. `debitTotal` and `creditTotal` remain the totals across every position, which
 * is what makes them the right thing to reconcile a transaction against.
 */
export function computeBalance(
  account: LedgerAccount,
  entries: readonly LedgerEntry[],
): AccountBalance {
  const debits: Record<BalanceState, bigint> = { available: 0n, pending: 0n, locked: 0n };
  const credits: Record<BalanceState, bigint> = { available: 0n, pending: 0n, locked: 0n };

  for (const entry of entries) {
    const bucket = entry.side === 'debit' ? debits : credits;
    bucket[entry.balanceState] += entry.amount;
  }

  const signed = (state: BalanceState): bigint =>
    account.normalBalance === 'debit'
      ? debits[state] - credits[state]
      : credits[state] - debits[state];

  const available = signed('available');
  const pending = signed('pending');
  const locked = signed('locked');

  return {
    accountId: account.accountId,
    assetTypeId: account.assetTypeId,
    normalBalance: account.normalBalance,
    debitTotal: debits.available + debits.pending + debits.locked,
    creditTotal: credits.available + credits.pending + credits.locked,
    available,
    pending,
    locked,
    total: available + pending + locked,
  };
}

function assetTypeEquals(a: AssetType, b: AssetType): boolean {
  return (
    a.assetTypeId === b.assetTypeId &&
    a.assetClass === b.assetClass &&
    a.symbol === b.symbol &&
    a.precision === b.precision &&
    a.transferability === b.transferability &&
    a.withdrawability === b.withdrawability &&
    a.valuationSource === b.valuationSource &&
    a.issuer === b.issuer &&
    a.unit === b.unit &&
    a.redeemable === b.redeemable &&
    a.convertible === b.convertible &&
    a.expiryDays === b.expiryDays &&
    JSON.stringify(a.restrictions) === JSON.stringify(b.restrictions) &&
    a.custodyProvider === b.custodyProvider &&
    a.jurisdiction === b.jurisdiction
  );
}

function accountEquals(a: LedgerAccount, b: LedgerAccount): boolean {
  return (
    a.accountId === b.accountId &&
    a.assetTypeId === b.assetTypeId &&
    a.ownerId === b.ownerId &&
    a.normalBalance === b.normalBalance &&
    a.createdAt === b.createdAt
  );
}

function transactionEquals(a: LedgerTransaction, b: LedgerTransaction): boolean {
  return (
    a.transactionId === b.transactionId &&
    a.idempotencyKey === b.idempotencyKey &&
    a.postedAt === b.postedAt &&
    a.assetTypeId === b.assetTypeId &&
    entriesEqual(a.entries, b.entries)
  );
}

function entriesEqual(a: readonly LedgerEntry[], b: readonly LedgerEntry[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort(compareEntry);
  const sortedB = [...b].sort(compareEntry);
  for (let i = 0; i < sortedA.length; i += 1) {
    const left = sortedA[i] as LedgerEntry;
    const right = sortedB[i] as LedgerEntry;
    if (
      left.accountId !== right.accountId ||
      left.side !== right.side ||
      left.amount !== right.amount
    ) {
      return false;
    }
  }
  return true;
}

function compareEntry(a: LedgerEntry, b: LedgerEntry): number {
  return (
    a.accountId.localeCompare(b.accountId) ||
    a.side.localeCompare(b.side) ||
    (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0)
  );
}
