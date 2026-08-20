/**
 * K-07 Feature Flags — canonical request forms and their fingerprints (FND-004e).
 *
 * An idempotency key identifies a caller's *intent to retry*. It does not identify the request,
 * and treating it as though it does is how K-04 shipped an authorisation obtainable by presenting
 * somebody else's key (CURRENT_IMPLEMENTATION_STATUS §11.27). So every mutation here stores a
 * fingerprint of the inputs it was decided from, and a retry converges only on an exact match.
 *
 * Two properties make the canonical form safe to hash:
 *
 *   - **every value is JSON-quoted**, so a value containing the separator cannot impersonate a
 *     field boundary — `a|b` in one field must not hash the same as `a` and `b` in two;
 *   - **every collection is ordered deterministically**, so key order and array order in the
 *     caller's object are not part of the question being asked.
 *
 * Owned by: K-07 Feature Flags.
 */

import { createHash } from 'node:crypto';

import type { Predicate } from './types.ts';

/** A stored fingerprint is a lowercase SHA-256 in hex, and nothing else. */
export const REQUEST_FINGERPRINT = /^[0-9a-f]{64}$/;

const quote = (value: string | number | boolean | null): string => JSON.stringify(value);

/** A rule tree in canonical text: kind first, then its parts, children in written order. */
export function canonicalPredicate(predicate: Predicate): string {
  switch (predicate.kind) {
    case 'attribute-equals':
      return `equals(${quote(predicate.attribute)},${quote(predicate.value)})`;
    case 'attribute-in':
      return `in(${quote(predicate.attribute)},[${[...predicate.values]
        .sort()
        .map(quote)
        .join(',')}])`;
    default:
      return `${predicate.kind}([${predicate.of.map(canonicalPredicate).join(',')}])`;
  }
}

/** Every input a published flag version is decided from. */
export interface VersionRequestFacts {
  readonly flagVersionId: string;
  readonly flagKey: string;
  readonly version: number;
  readonly state: string;
  readonly supportedScopes: readonly string[];
  readonly rules: readonly Predicate[];
  readonly percentage: number;
  readonly rolloutSalt: string;
  readonly notBefore: string | null;
  readonly notAfter: string | null;
  readonly authorityId: string;
}

export function canonicalVersionRequest(facts: VersionRequestFacts): string {
  return [
    `flagVersionId=${quote(facts.flagVersionId)}`,
    `flagKey=${quote(facts.flagKey)}`,
    `version=${quote(facts.version)}`,
    `state=${quote(facts.state)}`,
    `supportedScopes=[${[...facts.supportedScopes].sort().map(quote).join(',')}]`,
    `rules=[${facts.rules.map(canonicalPredicate).join(',')}]`,
    `percentage=${quote(facts.percentage)}`,
    `rolloutSalt=${quote(facts.rolloutSalt)}`,
    `notBefore=${quote(facts.notBefore)}`,
    `notAfter=${quote(facts.notAfter)}`,
    `authorityId=${quote(facts.authorityId)}`,
  ].join('|');
}

/** Every input an activation or a lifecycle event is decided from. */
export interface TransitionRequestFacts {
  readonly operation: 'activate' | 'kill' | 'retire';
  readonly recordId: string;
  readonly flagKey: string;
  /** The version being activated, or the reason text for a lifecycle event. */
  readonly detail: string;
  readonly supersedesVersionId: string | null;
  readonly authorityId: string;
}

export function canonicalTransitionRequest(facts: TransitionRequestFacts): string {
  return [
    `operation=${quote(facts.operation)}`,
    `recordId=${quote(facts.recordId)}`,
    `flagKey=${quote(facts.flagKey)}`,
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
