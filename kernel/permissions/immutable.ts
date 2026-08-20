/**
 * K-04 Permissions — the immutability boundary (FND-004d).
 *
 * One function per record type, applied at every point one crosses a boundary: service results,
 * every in-memory seed, read and write, and PostgreSQL decoding. One boundary rather than a freeze
 * at each site, because a rule applied in six places is a rule that will be applied in five after
 * the next change — which is how K-09 shipped with a frozen record whose `actor` was still
 * writable (CURRENT_IMPLEMENTATION_STATUS §11.20).
 *
 * The nested structures matter more here than anywhere else. A grant holds a `condition` tree and
 * a policy version holds a role list holding capability lists: a caller that could push onto the
 * capability array of a policy it was handed could give itself an authority nobody granted, and it
 * would leave no trace anywhere, because no write ever happened.
 *
 * Owned by: K-04 Permissions.
 */

import type {
  Capability,
  Decision,
  Grant,
  PolicyVersion,
  Predicate,
  Revocation,
  RoleDefinition,
} from './types.ts';

/** Sorted and frozen, so two equal capability sets compare equal by value. */
export function sealCapabilities(capabilities: readonly Capability[]): readonly Capability[] {
  return Object.freeze(
    [...capabilities]
      .map((capability) => Object.freeze({ ...capability }))
      .sort((a, b) =>
        a.resourceType === b.resourceType
          ? a.action.localeCompare(b.action)
          : a.resourceType.localeCompare(b.resourceType),
      ),
  );
}

/** Frozen all the way down: a predicate tree with a mutable branch is a mutable policy. */
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

export function sealRoleDefinition(definition: RoleDefinition): RoleDefinition {
  return Object.freeze({ ...definition, capabilities: sealCapabilities(definition.capabilities) });
}

export function sealPolicyVersion(policy: PolicyVersion): PolicyVersion {
  return Object.freeze({
    ...policy,
    publishedBy: Object.freeze({ ...policy.publishedBy }),
    roles: Object.freeze(
      [...policy.roles].map(sealRoleDefinition).sort((a, b) => a.role.localeCompare(b.role)),
    ),
  });
}

export function sealGrant(grant: Grant): Grant {
  return Object.freeze({
    ...grant,
    grantedBy: Object.freeze({ ...grant.grantedBy }),
    condition: grant.condition === null ? null : sealPredicate(grant.condition),
  });
}

export function sealGrants(grants: readonly Grant[]): readonly Grant[] {
  return Object.freeze(grants.map(sealGrant));
}

export function sealRevocation(revocation: Revocation): Revocation {
  return Object.freeze({ ...revocation, revokedBy: Object.freeze({ ...revocation.revokedBy }) });
}

export function sealRevocations(revocations: readonly Revocation[]): readonly Revocation[] {
  return Object.freeze(revocations.map(sealRevocation));
}

export function sealDecision(decision: Decision): Decision {
  return Object.freeze({ ...decision });
}

export function sealDecisions(decisions: readonly Decision[]): readonly Decision[] {
  return Object.freeze(decisions.map(sealDecision));
}

/**
 * Is this record sealed all the way down?
 *
 * Exported so a test can assert the property directly rather than by attempting one mutation and
 * hoping that attempt was representative of the rest.
 */
export function isSealed(record: object): boolean {
  if (!Object.isFrozen(record)) return false;
  for (const value of Object.values(record)) {
    if (value === null || typeof value !== 'object') continue;
    if (!isSealed(value as object)) return false;
  }
  return true;
}
