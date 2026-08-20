/**
 * K-07 Feature Flags — the immutability boundary (FND-004e).
 *
 * One function per record type, applied everywhere a record crosses a boundary: service results,
 * every in-memory seed, read and write, and PostgreSQL decoding. One boundary rather than a freeze
 * at each call site, because a rule applied in six places is a rule that will be applied in five
 * after the next change — which is how K-09 shipped with a frozen record whose `actor` was still
 * writable (CURRENT_IMPLEMENTATION_STATUS §11.20).
 *
 * The nested structures are the point here. A flag version holds a rule tree and a supported-scope
 * list: a caller handed a version who could push onto `supportedScopes` would widen where the flag
 * applies, and a caller who could edit a predicate's `values` would add themselves to a targeted
 * rollout. Neither is a write, so neither leaves a row anywhere.
 *
 * Owned by: K-07 Feature Flags.
 */

import type { Activation, FlagVersion, LifecycleEvent, Predicate } from './types.ts';

/** Frozen all the way down: a rule tree with a mutable branch is a mutable rollout. */
export function sealPredicate(predicate: Predicate): Predicate {
  switch (predicate.kind) {
    case 'attribute-in':
      return Object.freeze({ ...predicate, values: Object.freeze([...predicate.values]) });
    case 'all':
    case 'any':
      return Object.freeze({ ...predicate, of: Object.freeze(predicate.of.map(sealPredicate)) });
    default:
      return Object.freeze({ ...predicate });
  }
}

export function sealFlagVersion(version: FlagVersion): FlagVersion {
  return Object.freeze({
    ...version,
    supportedScopes: Object.freeze([...version.supportedScopes]),
    rules: Object.freeze(version.rules.map(sealPredicate)),
    publishedBy: Object.freeze({ ...version.publishedBy }),
  });
}

export function sealActivation(activation: Activation): Activation {
  return Object.freeze({ ...activation, activatedBy: Object.freeze({ ...activation.activatedBy }) });
}

export function sealLifecycleEvent(event: LifecycleEvent): LifecycleEvent {
  return Object.freeze({ ...event, recordedBy: Object.freeze({ ...event.recordedBy }) });
}

export function sealFlagVersions(versions: readonly FlagVersion[]): readonly FlagVersion[] {
  return Object.freeze(versions.map(sealFlagVersion));
}

export function sealActivations(activations: readonly Activation[]): readonly Activation[] {
  return Object.freeze(activations.map(sealActivation));
}

export function sealLifecycleEvents(
  events: readonly LifecycleEvent[],
): readonly LifecycleEvent[] {
  return Object.freeze(events.map(sealLifecycleEvent));
}
