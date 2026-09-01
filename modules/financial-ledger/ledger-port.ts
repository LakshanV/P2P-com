/**
 * M-13 Financial Ledger — the journal port.
 *
 * M-13 does not keep balances. It asks K-10 Ledger Foundation to open accounts and post balanced
 * transactions, and records which K-10 transaction moved each leg.
 *
 * This is a **narrow port rather than a direct dependency on K-10's service class**, for two
 * reasons. It names the two operations M-13 actually needs, out of K-10's six, so a reader can see
 * the whole of the coupling in one screen. And it leaves room for the implementation that matters
 * for correctness: an adapter that enlists in M-13's own database transaction, so a posted leg and
 * its journal entry commit together. `K10LedgerPort` is not that adapter — see the note there — and
 * the gap is stated in `CONTRACT.md` rather than hidden.
 *
 * Owned by: M-13 Financial Ledger.
 */

/** Open a position in K-10, or return the one that already exists under this key. */
export interface LedgerAccountRequest {
  readonly ledgerAccountId: string;
  readonly assetTypeId: string;
  /** The party the position belongs to. */
  readonly ownerId: string;
  /**
   * Which way the account moves.
   *
   * A holder's wallet is a liability of the platform — the platform owes them the value — so it is
   * credit-normal. A platform issuance position is debit-normal. M-13 states this rather than
   * letting K-10 guess, because the sign of every reported balance depends on it.
   */
  readonly normalBalance: 'debit' | 'credit';
  readonly createdAt: string;
  readonly idempotencyKey: string;
}

/** One line of a posting. Every line of one posting is in the same asset type. */
export interface LedgerPostingEntry {
  readonly ledgerAccountId: string;
  readonly side: 'debit' | 'credit';
  readonly amountMinor: bigint;
}

export interface LedgerPostingRequest {
  readonly transactionId: string;
  readonly assetTypeId: string;
  readonly postedAt: string;
  readonly idempotencyKey: string;
  readonly entries: readonly LedgerPostingEntry[];
}

export interface LedgerAccountResult {
  readonly ledgerAccountId: string;
  /** True when the account already existed under this key and nothing new was created. */
  readonly deduplicated: boolean;
}

export interface LedgerPostingResult {
  readonly transactionId: string;
  /**
   * True when this transaction had already been posted under this key.
   *
   * This is what makes a retry after a crash safe: M-13 posts to the journal *before* it records
   * the leg as posted, so a process that dies between the two leaves the money moved and the leg
   * still `planned`. The retry re-posts under the same key, K-10 answers `deduplicated`, and the
   * leg is then marked — converging on the same state rather than moving the value twice.
   */
  readonly deduplicated: boolean;
}

export interface LedgerPort {
  createAccount(request: LedgerAccountRequest): Promise<LedgerAccountResult>;
  post(request: LedgerPostingRequest): Promise<LedgerPostingResult>;
}
