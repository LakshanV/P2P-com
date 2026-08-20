/**
 * K-11 Commerce Unit Registry — parent and ancestor resolution (FND-005c).
 *
 * Pure: same types, same instant, same ancestry, on any machine, forever. Nothing here reads a
 * clock, opens a connection or generates randomness — the instant arrives as an argument.
 *
 * A hierarchy is where a registry either earns its keep or quietly corrupts everything downstream,
 * and the failures are all silent:
 *
 *   - **a cycle** makes resolution non-terminating, or — worse, if somebody adds a visited-set and
 *     stops there — makes a type its own ancestor, so a category rule written for the parent
 *     matches the child that contains it;
 *   - **a missing parent** leaves a type whose lineage cannot be stated. Treating it as a root
 *     would silently promote a subcategory to a top-level category, which is how a risk pack
 *     stops applying to the things it was written for;
 *   - **an unbounded chain** is not a correctness problem so much as a review problem: nobody can
 *     confirm a ten-deep lineage is right, and every downstream traversal pays for it;
 *   - **a cross-owner edge** lets one tenant's vocabulary depend on another's, so retiring a type
 *     in one tenant breaks listings in a second that never agreed to the relationship.
 *
 * Every one of those is refused here rather than resolved to a best guess. The registry is the
 * platform's shared vocabulary; a vocabulary that guesses is worse than one that says it cannot
 * answer, because everything downstream believes it.
 *
 * Owned by: K-11 Commerce Unit Registry.
 */

import { compareInstants } from '../../platform/time/instant.ts';

import { MAX_DEPTH } from './registry.ts';
import {
  CommerceUnitError,
  ownerKey,
  sameOwner,
  type OwnerScope,
  type UnitTypeVersion,
} from './types.ts';

/** What resolution is given: the version in force for a key, at the instant asked about. */
export interface InForce {
  readonly version: UnitTypeVersion;
  readonly riskPolicyVersionId: string | null;
}

/** How resolution reads the store, so this file stays pure and the service stays thin. */
export type LookupInForce = (typeKey: string) => InForce | undefined;

/**
 * Refuse a version whose effective window does not contain the instant.
 *
 * Separate from the ancestry walk because the answer differs: a *requested* type outside its
 * window is `version-not-effective`, while an *ancestor* outside its window is a broken lineage
 * (`missing-parent`) — the caller asked about the child, and the child's provenance is what has
 * gone missing.
 */
export function assertEffective(version: UnitTypeVersion, at: string, requested: boolean): void {
  const before = version.effectiveFrom !== null && compareInstants(at, version.effectiveFrom) < 0;
  const after = version.effectiveUntil !== null && compareInstants(at, version.effectiveUntil) > 0;
  if (!before && !after) return;

  if (requested) {
    throw new CommerceUnitError(
      'version-not-effective',
      `version ${version.version} of ${version.typeKey} ${
        before ? `takes effect at ${String(version.effectiveFrom)}` : `ceased at ${String(version.effectiveUntil)}`
      }, and ${at} is outside that window`,
    );
  }
  throw new CommerceUnitError(
    'missing-parent',
    `${version.typeKey} is an ancestor of the requested type but is not in force at ${at}, so the ` +
      'lineage cannot be stated. Treating it as absent would silently promote its descendant to a ' +
      'root, and every rule written for the parent would stop applying to it',
  );
}

/**
 * Walk from a type to its root, refusing anything that is not a single, bounded, same-owner chain.
 *
 * Returns the ancestry from the immediate parent outwards. A root returns `[]`.
 *
 * The cycle check is by *visited set rather than by depth alone*: a depth limit would turn a cycle
 * into `hierarchy-too-deep`, which sends whoever is debugging it looking for a long chain that
 * does not exist.
 */
export function resolveAncestry(
  start: UnitTypeVersion,
  lookup: LookupInForce,
  at: string,
): readonly string[] {
  const ancestry: string[] = [];
  const visited = new Set<string>([start.typeKey]);
  let current = start;

  while (current.parentTypeKey !== null) {
    const parentKey = current.parentTypeKey;

    if (parentKey === current.typeKey) {
      throw new CommerceUnitError(
        'self-parent',
        `${current.typeKey} names itself as its parent, which is a lineage of one thing ` +
          'containing itself',
      );
    }
    if (visited.has(parentKey)) {
      throw new CommerceUnitError(
        'hierarchy-cycle',
        `the parent chain from ${start.typeKey} reaches ${parentKey} twice: ` +
          `${[start.typeKey, ...ancestry, parentKey].join(' → ')}. A type that is its own ancestor ` +
          'would match every category rule written for the thing that contains it',
      );
    }

    const parent = lookup(parentKey);
    if (parent === undefined) {
      throw new CommerceUnitError(
        'missing-parent',
        `${current.typeKey} names ${parentKey} as its parent, and no version of ${parentKey} is ` +
          'in force. The lineage cannot be stated, and a type with no statable lineage must not ' +
          'be resolved as though it were a root',
      );
    }
    assertEffective(parent.version, at, false);
    assertSameOwnerEdge(current, parent.version);

    ancestry.push(parentKey);
    visited.add(parentKey);
    current = parent.version;

    if (ancestry.length + 1 > MAX_DEPTH) {
      throw new CommerceUnitError(
        'hierarchy-too-deep',
        `the chain from ${start.typeKey} is deeper than ${MAX_DEPTH}: ` +
          `${[start.typeKey, ...ancestry].join(' → ')}. A lineage nobody can hold in their head ` +
          'is one nobody can confirm is right',
      );
    }
  }

  return Object.freeze(ancestry);
}

/**
 * One edge of the chain, checked for the isolation rule.
 *
 * A tenant type may extend a **platform** type — that is v3 §11's "category adapters extend the
 * common object rather than duplicating the platform". What it may not do is extend *another
 * tenant's* type: that would let one tenant's retirement break a second tenant's listings, and
 * neither of them agreed to the relationship or can see it.
 */
export function assertSameOwnerEdge(child: UnitTypeVersion, parent: UnitTypeVersion): void {
  if (parent.owner.kind === 'platform') return;
  if (sameOwner(child.owner, parent.owner)) return;

  throw new CommerceUnitError(
    'cross-owner-relationship',
    `${child.typeKey} (${ownerKey(child.owner)}) names ${parent.typeKey} ` +
      `(${ownerKey(parent.owner)}) as its parent. A tenant may extend the platform vocabulary and ` +
      'its own, and nothing else: extending another tenant would make one tenant’s retirement ' +
      'break a second tenant’s listings, with neither able to see the relationship',
  );
}

/** Whether an owner may write to a type owned by this scope. Platform types are platform-only. */
export function mayAdminister(actor: OwnerScope, target: OwnerScope): boolean {
  return sameOwner(actor, target);
}

/** Deterministic text naming the version, its depth and its ancestry — never a tenant handle. */
export function explain(
  version: UnitTypeVersion,
  ancestry: readonly string[],
  riskPolicyVersionId: string | null,
): string {
  const lineage = ancestry.length === 0 ? 'a root type' : `descending from ${ancestry.join(' → ')}`;
  const pinned =
    riskPolicyVersionId === null
      ? 'and names no risk policy'
      : `and pins risk policy version ${riskPolicyVersionId}`;
  return (
    `version ${version.version} (${version.typeVersionId}) of ${version.typeKey} is a ` +
    `${version.kind} at depth ${ancestry.length + 1}, ${lineage}, permitting ` +
    `${version.measures.map((measure) => `${measure.family}/${measure.unit}`).join(', ')} ${pinned}`
  );
}
