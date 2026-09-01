/**
 * M-13 Financial Ledger — immutability boundary.
 *
 * Every record that crosses a service or repository boundary is deep-frozen and cloned, so a caller
 * cannot edit what was stored.
 *
 * A leg's `rate` is frozen with it. A caller that could edit the rate after the fact could change
 * what a posted leg was worth against its obligation, and the plan's arithmetic — the whole point of
 * the module — would no longer describe what happened.
 *
 * Owned by: M-13 Financial Ledger.
 */

import type { ValueLeg, ValuePlan, Wallet, WalletStateRecord } from './types.ts';

/** A frozen copy of a wallet. */
export function sealWallet(wallet: Wallet): Wallet {
  return Object.freeze({ ...wallet });
}

/** A frozen copy of a wallet state record. */
export function sealWalletState(record: WalletStateRecord): WalletStateRecord {
  return Object.freeze({ ...record });
}

/** A frozen copy of a plan. */
export function sealValuePlan(plan: ValuePlan): ValuePlan {
  return Object.freeze({ ...plan });
}

/** A frozen copy of a leg, its rate included. */
export function sealValueLeg(leg: ValueLeg): ValueLeg {
  return Object.freeze({
    ...leg,
    rate: Object.freeze({ ...leg.rate }),
  });
}

export function sealWallets(wallets: readonly Wallet[]): readonly Wallet[] {
  return Object.freeze(wallets.map(sealWallet));
}

export function sealWalletStates(
  records: readonly WalletStateRecord[],
): readonly WalletStateRecord[] {
  return Object.freeze(records.map(sealWalletState));
}

export function sealValuePlans(plans: readonly ValuePlan[]): readonly ValuePlan[] {
  return Object.freeze(plans.map(sealValuePlan));
}

export function sealValueLegs(legs: readonly ValueLeg[]): readonly ValueLeg[] {
  return Object.freeze(legs.map(sealValueLeg));
}

/**
 * Whether a record has been through the seal.
 *
 * Used by tests to assert the boundary actually holds, rather than trusting that every path
 * remembered to call it.
 */
export function isWalletSealed(wallet: Wallet): boolean {
  return Object.isFrozen(wallet);
}

export function isValuePlanSealed(plan: ValuePlan): boolean {
  return Object.isFrozen(plan);
}

/** A leg is sealed only when its rate is frozen too. */
export function isValueLegSealed(leg: ValueLeg): boolean {
  return Object.isFrozen(leg) && Object.isFrozen(leg.rate);
}
