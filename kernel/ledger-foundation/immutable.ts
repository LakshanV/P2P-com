/**
 * K-10 Ledger Foundation — the immutability boundary.
 *
 * Every record that crosses a service or repository boundary is deep-frozen and cloned, so a caller
 * cannot edit what was stored. The ledger is append-only; the only defence against silent mutation
 * at the boundary is to make mutation throw.
 *
 * Owned by: K-10 Ledger Foundation.
 */

import type { AssetType, LedgerAccount, LedgerEntry, LedgerTransaction } from './types.ts';

function sealJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(sealJson));
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = sealJson(entry);
  return Object.freeze(copy);
}

/**
 * A deep, frozen copy of an asset type.
 *
 * `restrictions` is arbitrary caller-supplied JSON, so a shallow freeze would leave it editable
 * through the returned record. It is sealed all the way down.
 */
export function sealAssetType(assetType: AssetType): AssetType {
  return Object.freeze({
    ...assetType,
    restrictions: sealJson(assetType.restrictions) as Readonly<Record<string, unknown>>,
  });
}

/** A deep, frozen copy of a ledger account. */
export function sealAccount(account: LedgerAccount): LedgerAccount {
  return Object.freeze({ ...account });
}

/** A deep, frozen copy of one ledger entry. */
export function sealEntry(entry: LedgerEntry): LedgerEntry {
  return Object.freeze({ ...entry });
}

/** A deep, frozen copy of a transaction and its entries. */
export function sealTransaction(transaction: LedgerTransaction): LedgerTransaction {
  return Object.freeze({
    ...transaction,
    entries: Object.freeze(transaction.entries.map(sealEntry)),
  });
}

/** Frozen copies of a list. */
export function sealAssetTypes(assetTypes: readonly AssetType[]): readonly AssetType[] {
  return Object.freeze(assetTypes.map(sealAssetType));
}

export function sealAccounts(accounts: readonly LedgerAccount[]): readonly LedgerAccount[] {
  return Object.freeze(accounts.map(sealAccount));
}

export function sealTransactions(
  transactions: readonly LedgerTransaction[],
): readonly LedgerTransaction[] {
  return Object.freeze(transactions.map(sealTransaction));
}
