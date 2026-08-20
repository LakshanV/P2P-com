/**
 * K-11 Commerce Unit Registry — the immutability boundary (FND-005c).
 *
 * One function per record type, applied everywhere a record crosses a boundary: service results,
 * every in-memory seed, read and write, and PostgreSQL decoding. One boundary rather than a freeze
 * at each call site, because a rule applied in six places is a rule that will be applied in five
 * after the next change — which is how K-09 shipped with a frozen record whose `actor` was still
 * writable (CURRENT_IMPLEMENTATION_STATUS §11.20).
 *
 * The nested structures here decide what can be sold and how it is priced. A caller handed a type
 * who could push onto `measures` would let a category be sold in a unit nobody registered, and one
 * who could edit `parentTypeKey` would move a whole subtree under a different risk pack — neither
 * of which is a write, so neither leaves a row.
 *
 * Owned by: K-11 Commerce Unit Registry.
 */

import type {
  UnitTypeActivation,
  UnitTypeRetirement,
  UnitTypeVersion,
  ResolvedUnitType,
} from './types.ts';

export function sealVersion(version: UnitTypeVersion): UnitTypeVersion {
  return Object.freeze({
    ...version,
    owner: Object.freeze({ ...version.owner }),
    measures: Object.freeze(version.measures.map((measure) => Object.freeze({ ...measure }))),
    publishedBy: Object.freeze({ ...version.publishedBy }),
  });
}

export function sealActivation(activation: UnitTypeActivation): UnitTypeActivation {
  return Object.freeze({
    ...activation,
    activatedBy: Object.freeze({ ...activation.activatedBy }),
  });
}

export function sealRetirement(retirement: UnitTypeRetirement): UnitTypeRetirement {
  return Object.freeze({ ...retirement, retiredBy: Object.freeze({ ...retirement.retiredBy }) });
}

export function sealResolved(resolved: ResolvedUnitType): ResolvedUnitType {
  return Object.freeze({
    ...resolved,
    owner: Object.freeze({ ...resolved.owner }),
    measures: Object.freeze(resolved.measures.map((measure) => Object.freeze({ ...measure }))),
    ancestry: Object.freeze([...resolved.ancestry]),
  });
}

export const sealVersions = (versions: readonly UnitTypeVersion[]): readonly UnitTypeVersion[] =>
  Object.freeze(versions.map(sealVersion));

export const sealActivations = (
  activations: readonly UnitTypeActivation[],
): readonly UnitTypeActivation[] => Object.freeze(activations.map(sealActivation));

export const sealRetirements = (
  retirements: readonly UnitTypeRetirement[],
): readonly UnitTypeRetirement[] => Object.freeze(retirements.map(sealRetirement));
