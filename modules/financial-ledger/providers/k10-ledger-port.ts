/**
 * The K-10 implementation of M-13's journal port.
 *
 * A thin translation: M-13's vocabulary in, K-10's out, and K-10's refusals re-raised in M-13's
 * vocabulary so a caller of M-13 never has to catch two error classes.
 *
 * **This adapter does not share M-13's transaction.** K-10 opens its own, so a posted leg and its
 * journal entry commit separately. M-13 posts to the journal *first* and records the leg *second*,
 * which makes the failure mode the safe one — the money moved and the leg says `planned`, which a
 * retry under the same key converges — rather than the unsafe one, a leg claiming a posting that
 * never happened. The remaining gap is a leg nobody retries, and it is stated in `CONTRACT.md` as
 * needing a reconciliation job rather than being papered over here.
 *
 * Owned by: M-13 Financial Ledger.
 */

import { LedgerError, type LedgerService } from '../../../kernel/ledger-foundation/index.ts';

import type {
  LedgerAccountRequest,
  LedgerAccountResult,
  LedgerPort,
  LedgerPostingRequest,
  LedgerPostingResult,
} from '../ledger-port.ts';
import { FinancialLedgerError } from '../types.ts';

/**
 * K-10 refusals M-13 restates as its own.
 *
 * Everything else — an unbalanced posting, an unknown account, a mixed asset type — is a defect in
 * M-13's own arithmetic rather than something the caller did, so it is re-raised as
 * `ledger-refused` carrying K-10's code, which is a distinct and loud thing to see in a log.
 */
const RESTATED: Readonly<Record<string, 'malformed-identifier' | 'idempotency-key-reuse'>> =
  Object.freeze({
    'malformed-identifier': 'malformed-identifier',
    'natural-identifier': 'malformed-identifier',
    'secret-bearing-input': 'malformed-identifier',
    'idempotency-key-reuse': 'idempotency-key-reuse',
  });

function restate(error: unknown, what: string): unknown {
  if (!(error instanceof LedgerError)) return error;
  const code = RESTATED[error.code];
  if (code !== undefined) return new FinancialLedgerError(code, error.message);
  return new FinancialLedgerError(
    'ledger-refused',
    `K-10 refused ${what} with "${error.code}": ${error.message}`,
  );
}

export class K10LedgerPort implements LedgerPort {
  readonly #ledger: LedgerService;

  constructor(ledger: LedgerService) {
    this.#ledger = ledger;
  }

  async createAccount(request: LedgerAccountRequest): Promise<LedgerAccountResult> {
    try {
      const { account, deduplicated } = await this.#ledger.createAccount({
        accountId: request.ledgerAccountId,
        assetTypeId: request.assetTypeId,
        ownerId: request.ownerId,
        normalBalance: request.normalBalance,
        createdAt: request.createdAt,
        idempotencyKey: request.idempotencyKey,
      });
      return { ledgerAccountId: account.accountId, deduplicated };
    } catch (error) {
      throw restate(error, `opening ledger account ${request.ledgerAccountId}`);
    }
  }

  async post(request: LedgerPostingRequest): Promise<LedgerPostingResult> {
    try {
      const { transaction, deduplicated } = await this.#ledger.postTransaction({
        transactionId: request.transactionId,
        idempotencyKey: request.idempotencyKey,
        postedAt: request.postedAt,
        assetTypeId: request.assetTypeId,
        entries: request.entries.map((entry) => ({
          accountId: entry.ledgerAccountId,
          side: entry.side,
          // Left to default to `available`. A leg of a value plan moves spendable value; reserving
          // it against an obligation is a different operation, and naming `pending` here would
          // quietly make every payment a reservation.
          amount: entry.amountMinor,
        })),
      });
      return { transactionId: transaction.transactionId, deduplicated };
    } catch (error) {
      throw restate(error, `posting transaction ${request.transactionId}`);
    }
  }
}
