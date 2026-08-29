/**
 * K-10 Ledger Foundation — the persistence port.
 *
 * The service is written against this interface. The port exposes the four ledger concerns — asset
 * types, accounts, transactions/entries, and derived balances — plus the outbox insert every
 * producing module must support.
 *
 * Owned by: K-10 Ledger Foundation.
 */

import { InMemoryOutboxStore } from '../../platform/outbox/repository.ts';
import type { OutboxEntry, OutboxTransaction } from '../../platform/outbox/types.ts';

import {
  sealAccount,
  sealAccounts,
  sealAssetType,
  sealAssetTypes,
  sealEntry,
  sealTransaction,
  sealTransactions,
} from './immutable.ts';
import {
  LedgerError,
  type AssetType,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerTransaction,
} from './types.ts';

export interface LedgerTransactionPort extends OutboxTransaction {
  /** Asset type lookup. */
  findAssetTypeById(assetTypeId: string): Promise<AssetType | null>;
  insertAssetType(assetType: AssetType): Promise<void>;

  /** Ledger account lookup and creation. */
  findAccountById(accountId: string): Promise<LedgerAccount | null>;
  findAccountByIdempotencyKey(idempotencyKey: string): Promise<LedgerAccount | null>;
  findAccountsById(accountIds: readonly string[]): Promise<ReadonlyMap<string, LedgerAccount>>;
  insertAccount(account: LedgerAccount): Promise<void>;

  /** Transaction lookup and creation. */
  findTransactionById(transactionId: string): Promise<LedgerTransaction | null>;
  findTransactionByIdempotencyKey(idempotencyKey: string): Promise<LedgerTransaction | null>;
  insertTransaction(transaction: LedgerTransaction): Promise<void>;

  /** Entries for balance derivation. */
  findEntriesByAccountId(accountId: string): Promise<readonly LedgerEntry[]>;
}

export interface LedgerRepository {
  /**
   * Run `body` in one transaction. An exception must roll everything back — a caller that sees a
   * failure must be able to assume nothing was written, including a half-posted transaction.
   */
  withTransaction<T>(body: (tx: LedgerTransactionPort) => Promise<T>): Promise<T>;
}

/**
 * An in-memory repository.
 *
 * The reference implementation of the port's contract. It enforces the same uniqueness rules the
 * database does, and checks them **at commit against the store as it stands** rather than against the
 * snapshot the transaction read. Two callers that both read "no such account" must not both win.
 */
export class InMemoryLedgerRepository implements LedgerRepository {
  #assetTypes: AssetType[] = [];
  #accounts: LedgerAccount[] = [];
  #transactions: LedgerTransaction[] = [];
  #entries: { readonly transactionId: string; readonly entry: LedgerEntry }[] = [];
  readonly #outbox = new InMemoryOutboxStore('K-10', 'kernel_ledger_foundation');
  transactionsCommitted = 0;
  transactionsRolledBack = 0;

  assetTypes(): readonly AssetType[] {
    return sealAssetTypes(this.#assetTypes);
  }

  accounts(): readonly LedgerAccount[] {
    return sealAccounts(this.#accounts);
  }

  transactions(): readonly LedgerTransaction[] {
    return sealTransactions(this.#transactions);
  }

  outbox(): InMemoryOutboxStore {
    return this.#outbox;
  }

  /** Seed state directly, for tests that need a starting point without going through the service. */
  seed(state: {
    readonly assetTypes?: readonly AssetType[];
    readonly accounts?: readonly LedgerAccount[];
    readonly transactions?: readonly LedgerTransaction[];
  }): void {
    this.#assetTypes = (state.assetTypes ?? []).map(sealAssetType);
    this.#accounts = (state.accounts ?? []).map(sealAccount);
    this.#transactions = (state.transactions ?? []).map(sealTransaction);
    this.#entries = (state.transactions ?? []).flatMap((transaction) =>
      transaction.entries.map((entry) => ({
        transactionId: transaction.transactionId,
        entry: sealEntry(entry),
      })),
    );
  }

  async withTransaction<T>(body: (tx: LedgerTransactionPort) => Promise<T>): Promise<T> {
    const working = {
      assetTypes: this.#assetTypes.map(sealAssetType),
      accounts: this.#accounts.map(sealAccount),
      transactions: this.#transactions.map(sealTransaction),
      entries: this.#entries.map((row) => ({ ...row, entry: sealEntry(row.entry) })),
    };
    const outboxWorking = new InMemoryOutboxStore(this.#outbox.name, this.#outbox.schema);
    outboxWorking.seed(this.#outbox.entries());

    const touched = new Touched();
    const tx = new InMemoryLedgerTransaction(working, outboxWorking, touched);

    try {
      const result = await body(tx);
      this.#commit(working, touched);
      this.#outbox.seed(outboxWorking.entries());
      this.transactionsCommitted += 1;
      return result;
    } catch (error) {
      this.transactionsRolledBack += 1;
      throw error;
    }
  }

  #commit(working: WorkingSet, touched: Touched): void {
    // Asset types
    for (const assetType of working.assetTypes) {
      if (touched.assetTypes.has(assetType.assetTypeId)) {
        if (this.#assetTypes.some((held) => held.assetTypeId === assetType.assetTypeId)) {
          throw new LedgerError(
            'duplicate-asset-type-id',
            `asset type ${assetType.assetTypeId} was created by another transaction while this one was open`,
          );
        }
      }
    }

    // Accounts
    for (const account of working.accounts) {
      if (touched.accounts.has(account.accountId)) {
        if (this.#accounts.some((held) => held.accountId === account.accountId)) {
          throw new LedgerError(
            'duplicate-account-id',
            `account ${account.accountId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.accountKeys.has(account.idempotencyKey)) {
        const holder = this.#accounts.find(
          (held) => held.idempotencyKey === account.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new LedgerError(
            'idempotency-key-reuse',
            `idempotency key "${account.idempotencyKey}" was used by account ${holder.accountId}, ` +
              'created by another transaction while this one was open',
          );
        }
      }
    }

    // Transactions
    for (const transaction of working.transactions) {
      if (touched.transactions.has(transaction.transactionId)) {
        if (this.#transactions.some((held) => held.transactionId === transaction.transactionId)) {
          throw new LedgerError(
            'duplicate-transaction-id',
            `transaction ${transaction.transactionId} was created by another transaction while this one was open`,
          );
        }
      }
      if (touched.transactionKeys.has(transaction.idempotencyKey)) {
        const holder = this.#transactions.find(
          (held) => held.idempotencyKey === transaction.idempotencyKey,
        );
        if (holder !== undefined) {
          throw new LedgerError(
            'idempotency-key-reuse',
            `idempotency key "${transaction.idempotencyKey}" was used by transaction ` +
              `${holder.transactionId}, created by another transaction while this one was open`,
          );
        }
      }
    }

    this.#assetTypes = [
      ...this.#assetTypes,
      ...working.assetTypes.filter((at) => touched.assetTypes.has(at.assetTypeId)),
    ];
    this.#accounts = [
      ...this.#accounts,
      ...working.accounts.filter((a) => touched.accounts.has(a.accountId)),
    ];
    this.#transactions = [
      ...this.#transactions,
      ...working.transactions.filter((t) => touched.transactions.has(t.transactionId)),
    ];
    this.#entries = [
      ...this.#entries,
      ...working.entries
        .filter((row) => touched.transactions.has(row.transactionId))
        .map((row) => ({ transactionId: row.transactionId, entry: sealEntry(row.entry) })),
    ];
  }
}

class WorkingSet {
  assetTypes: AssetType[];
  accounts: LedgerAccount[];
  transactions: LedgerTransaction[];
  entries: { readonly transactionId: string; readonly entry: LedgerEntry }[];

  constructor(snapshot: {
    assetTypes: AssetType[];
    accounts: LedgerAccount[];
    transactions: LedgerTransaction[];
    entries: { readonly transactionId: string; readonly entry: LedgerEntry }[];
  }) {
    this.assetTypes = snapshot.assetTypes;
    this.accounts = snapshot.accounts;
    this.transactions = snapshot.transactions;
    this.entries = snapshot.entries;
  }
}

class Touched {
  readonly assetTypes = new Set<string>();
  readonly accounts = new Set<string>();
  readonly accountKeys = new Set<string>();
  readonly transactions = new Set<string>();
  readonly transactionKeys = new Set<string>();
}

class InMemoryLedgerTransaction implements LedgerTransactionPort {
  readonly #state: WorkingSet;
  readonly #outbox: InMemoryOutboxStore;
  readonly #touched: Touched;

  constructor(state: WorkingSet, outbox: InMemoryOutboxStore, touched: Touched) {
    this.#state = state;
    this.#outbox = outbox;
    this.#touched = touched;
  }

  insertOutbox(entry: OutboxEntry): Promise<void> {
    this.#outbox.insert(entry);
    return Promise.resolve();
  }

  findAssetTypeById(assetTypeId: string): Promise<AssetType | null> {
    const found = this.#state.assetTypes.find((at) => at.assetTypeId === assetTypeId);
    return Promise.resolve(found === undefined ? null : sealAssetType(found));
  }

  insertAssetType(assetType: AssetType): Promise<void> {
    if (this.#state.assetTypes.some((held) => held.assetTypeId === assetType.assetTypeId)) {
      return Promise.reject(
        new LedgerError(
          'duplicate-asset-type-id',
          `asset type ${assetType.assetTypeId} already exists. Asset types name a unit of account and are never overwritten`,
        ),
      );
    }
    this.#state.assetTypes.push(sealAssetType(assetType));
    this.#touched.assetTypes.add(assetType.assetTypeId);
    return Promise.resolve();
  }

  findAccountById(accountId: string): Promise<LedgerAccount | null> {
    const found = this.#state.accounts.find((a) => a.accountId === accountId);
    return Promise.resolve(found === undefined ? null : sealAccount(found));
  }

  findAccountByIdempotencyKey(idempotencyKey: string): Promise<LedgerAccount | null> {
    const found = this.#state.accounts.find((a) => a.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealAccount(found));
  }

  findAccountsById(accountIds: readonly string[]): Promise<ReadonlyMap<string, LedgerAccount>> {
    const index = new Map<string, LedgerAccount>();
    for (const account of this.#state.accounts) {
      if (accountIds.includes(account.accountId)) {
        index.set(account.accountId, sealAccount(account));
      }
    }
    return Promise.resolve(index);
  }

  insertAccount(account: LedgerAccount): Promise<void> {
    if (this.#state.accounts.some((held) => held.accountId === account.accountId)) {
      return Promise.reject(
        new LedgerError(
          'duplicate-account-id',
          `account ${account.accountId} already exists. A ledger account is created once and never rewritten`,
        ),
      );
    }
    if (this.#state.accounts.some((held) => held.idempotencyKey === account.idempotencyKey)) {
      return Promise.reject(
        new LedgerError(
          'idempotency-key-reuse',
          `idempotency key "${account.idempotencyKey}" has already been used`,
        ),
      );
    }
    this.#state.accounts.push(sealAccount(account));
    this.#touched.accounts.add(account.accountId);
    this.#touched.accountKeys.add(account.idempotencyKey);
    return Promise.resolve();
  }

  findTransactionById(transactionId: string): Promise<LedgerTransaction | null> {
    const found = this.#state.transactions.find((t) => t.transactionId === transactionId);
    return Promise.resolve(found === undefined ? null : sealTransaction(found));
  }

  findTransactionByIdempotencyKey(idempotencyKey: string): Promise<LedgerTransaction | null> {
    const found = this.#state.transactions.find((t) => t.idempotencyKey === idempotencyKey);
    return Promise.resolve(found === undefined ? null : sealTransaction(found));
  }

  insertTransaction(transaction: LedgerTransaction): Promise<void> {
    if (this.#state.transactions.some((held) => held.transactionId === transaction.transactionId)) {
      return Promise.reject(
        new LedgerError(
          'duplicate-transaction-id',
          `transaction ${transaction.transactionId} already exists. A transaction is written once and never rewritten`,
        ),
      );
    }
    if (
      this.#state.transactions.some((held) => held.idempotencyKey === transaction.idempotencyKey)
    ) {
      return Promise.reject(
        new LedgerError(
          'idempotency-key-reuse',
          `idempotency key "${transaction.idempotencyKey}" has already been used`,
        ),
      );
    }
    const sealed = sealTransaction(transaction);
    this.#state.transactions.push(sealed);
    for (const entry of sealed.entries) {
      this.#state.entries.push({ transactionId: sealed.transactionId, entry: sealEntry(entry) });
    }
    this.#touched.transactions.add(sealed.transactionId);
    this.#touched.transactionKeys.add(sealed.idempotencyKey);
    return Promise.resolve();
  }

  findEntriesByAccountId(accountId: string): Promise<readonly LedgerEntry[]> {
    const found = this.#state.entries
      .filter((row) => row.entry.accountId === accountId)
      .map((row) => sealEntry(row.entry));
    return Promise.resolve(Object.freeze(found));
  }
}
