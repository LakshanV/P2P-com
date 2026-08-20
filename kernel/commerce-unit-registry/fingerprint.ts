/**
 * K-11 Commerce Unit Registry — canonical request forms and their fingerprints (FND-005c).
 *
 * An idempotency key identifies a caller's *intent to retry*. It does not identify the request,
 * and treating it as though it does is how K-04 shipped an authorisation obtainable by presenting
 * somebody else's key (CURRENT_IMPLEMENTATION_STATUS §11.27). Every mutation here stores a
 * fingerprint of the inputs it was decided from, and a retry converges only on an exact match.
 *
 * A reused key that converged on a *different* type would hand the caller a type version id
 * describing a category it did not register — and that id is copied into every listing created
 * under it, where it becomes the permanent answer to "what kind of thing is this".
 *
 * Two properties make the canonical form safe to hash: every value is JSON-quoted, so a value
 * containing the separator cannot impersonate a field boundary; and every collection is ordered
 * deterministically, so key order in the caller's object is not part of the question.
 *
 * Owned by: K-11 Commerce Unit Registry.
 */

import { createHash } from 'node:crypto';

import { ownerKey, type OwnerScope, type UnitOfMeasure } from './types.ts';

/** A stored fingerprint is a lowercase SHA-256 in hex, and nothing else. */
export const REQUEST_FINGERPRINT = /^[0-9a-f]{64}$/;

const quote = (value: string | number | boolean | null): string => JSON.stringify(value);

export const canonicalMeasures = (measures: readonly UnitOfMeasure[]): string =>
  `[${[...measures]
    .map((measure) => `${measure.family}/${measure.unit}`)
    .sort()
    .map(quote)
    .join(',')}]`;

/** Every input a published type version is decided from. */
export interface VersionRequestFacts {
  readonly typeVersionId: string;
  readonly typeKey: string;
  readonly kind: string;
  readonly owner: OwnerScope;
  readonly parentTypeKey: string | null;
  readonly measures: readonly UnitOfMeasure[];
  readonly riskPolicyKey: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly authorityId: string;
}

export function canonicalVersionRequest(facts: VersionRequestFacts): string {
  return [
    `typeVersionId=${quote(facts.typeVersionId)}`,
    `typeKey=${quote(facts.typeKey)}`,
    `kind=${quote(facts.kind)}`,
    `owner=${quote(ownerKey(facts.owner))}`,
    `parentTypeKey=${quote(facts.parentTypeKey)}`,
    `measures=${canonicalMeasures(facts.measures)}`,
    `riskPolicyKey=${quote(facts.riskPolicyKey)}`,
    `effectiveFrom=${quote(facts.effectiveFrom)}`,
    `effectiveUntil=${quote(facts.effectiveUntil)}`,
    `authorityId=${quote(facts.authorityId)}`,
  ].join('|');
}

/** Every input a lifecycle transition is decided from. */
export interface TransitionRequestFacts {
  readonly operation: 'activate' | 'retire';
  readonly recordId: string;
  readonly typeKey: string;
  /** The version being activated, or the reason text for a retirement. */
  readonly detail: string;
  readonly supersedesVersionId: string | null;
  readonly authorityId: string;
}

export function canonicalTransitionRequest(facts: TransitionRequestFacts): string {
  return [
    `operation=${quote(facts.operation)}`,
    `recordId=${quote(facts.recordId)}`,
    `typeKey=${quote(facts.typeKey)}`,
    `detail=${quote(facts.detail)}`,
    `supersedesVersionId=${quote(facts.supersedesVersionId)}`,
    `authorityId=${quote(facts.authorityId)}`,
  ].join('|');
}

const sha256 = (canonical: string): string =>
  createHash('sha256').update(canonical, 'utf8').digest('hex');

export function fingerprintVersionRequest(facts: VersionRequestFacts): string {
  return sha256(canonicalVersionRequest(facts));
}

export function fingerprintTransitionRequest(facts: TransitionRequestFacts): string {
  return sha256(canonicalTransitionRequest(facts));
}
