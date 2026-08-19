/**
 * K-03 Accounts — the immutability boundary (FND-004b).
 *
 * One function, applied at every point an account crosses a boundary: the service's results, every
 * in-memory seed, read and write, and the PostgreSQL decoder. One boundary rather than a freeze at
 * each site, because a rule applied in six places is a rule that will be applied in five after the
 * next change — which is how K-09 shipped with a frozen record whose `actor` was still writable
 * (CURRENT_IMPLEMENTATION_STATUS §11.20).
 *
 * `sealAccount` both **clones and freezes**:
 *
 *   - *Cloning* severs the caller's reference. A shallow `{ ...account }` gives a new top level over
 *     the *same* `origin` object, so storing a caller's account and then letting the caller edit its
 *     origin edits what was stored, after the fact, with nothing to see.
 *   - *Freezing* makes the attempt throw rather than fail silently, which is the difference between
 *     a caller learning it did something wrong and a caller believing it worked.
 *
 * Owned by: K-03 Accounts.
 */

import type { AccountOrigin, UniversalAccount } from './types.ts';

/** A deep, frozen copy of an account. `origin` is the only nested object. Idempotent. */
export function sealAccount(account: UniversalAccount): UniversalAccount {
  return Object.freeze({
    ...account,
    origin: sealOrigin(account.origin),
  });
}

/** The same for a list. */
export function sealAccounts(accounts: readonly UniversalAccount[]): readonly UniversalAccount[] {
  return Object.freeze(accounts.map(sealAccount));
}

export function sealOrigin(origin: AccountOrigin): AccountOrigin {
  return Object.freeze({ ...origin });
}

/**
 * Is this account sealed all the way down?
 *
 * Exported so a test can assert the property directly rather than by attempting one mutation and
 * hoping that attempt was representative of the rest.
 */
export function isSealed(account: UniversalAccount): boolean {
  return Object.isFrozen(account) && Object.isFrozen(account.origin);
}
