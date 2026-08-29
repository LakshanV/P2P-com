/**
 * M-01 Universal Account — the immutability boundary.
 *
 * Every record that crosses a service or repository boundary is deep-frozen and cloned, so a caller
 * cannot edit what was stored. Capability state rows are append-only; the capability row itself is
 * updated only through the service's lifecycle operations. The only defence against silent mutation
 * at the boundary is to make mutation throw.
 *
 * Owned by: M-01 Universal Account.
 */

import type { AccountCapability, CapabilityState } from './types.ts';

function sealRecord(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(sealRecord));
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = sealRecord(entry);
  }
  return Object.freeze(copy);
}

/** A deep, frozen copy of an account capability. */
export function sealAccountCapability(capability: AccountCapability): AccountCapability {
  return Object.freeze({
    capabilityId: capability.capabilityId,
    accountId: capability.accountId,
    capability: capability.capability,
    status: capability.status,
    activatedAt: capability.activatedAt,
    deactivatedAt: capability.deactivatedAt,
    attributes: sealRecord(capability.attributes) as Readonly<Record<string, unknown>>,
    createdAt: capability.createdAt,
    updatedAt: capability.updatedAt,
    correlationId: capability.correlationId,
    idempotencyKey: capability.idempotencyKey,
  });
}

/** A deep, frozen copy of a capability state row. */
export function sealCapabilityState(state: CapabilityState): CapabilityState {
  return Object.freeze({ ...state });
}

/** Frozen copies of a list of capabilities. */
export function sealAccountCapabilities(
  capabilities: readonly AccountCapability[],
): readonly AccountCapability[] {
  return Object.freeze(capabilities.map(sealAccountCapability));
}

/** Frozen copies of a list of capability states. */
export function sealCapabilityStates(
  states: readonly CapabilityState[],
): readonly CapabilityState[] {
  return Object.freeze(states.map(sealCapabilityState));
}

/** Is this capability sealed all the way down? */
export function isAccountCapabilitySealed(capability: AccountCapability): boolean {
  return Object.isFrozen(capability) && Object.isFrozen(capability.attributes);
}

/** Is this capability state sealed? */
export function isCapabilityStateSealed(state: CapabilityState): boolean {
  return Object.isFrozen(state);
}
