/**
 * K-06 Policy Engine — canonical request forms and their fingerprints (FND-005b).
 *
 * An idempotency key identifies a caller's *intent to retry*. It does not identify the request,
 * and treating it as though it does is how K-04 shipped an authorisation obtainable by presenting
 * somebody else's key (CURRENT_IMPLEMENTATION_STATUS §11.27). Every mutation here therefore stores
 * a fingerprint of the inputs it was decided from, and a retry converges only on an exact match.
 *
 * The stakes are higher in this component than in any before it. A reused key that converged on a
 * *different* rule set would hand the caller a policy version id that does not describe the policy
 * it asked for — and that id gets pinned into a financial record, where it becomes the permanent
 * explanation for an amount it never justified.
 *
 * Two properties make the canonical form safe to hash:
 *
 *   - **every value is JSON-quoted**, so a value containing the separator cannot impersonate a
 *     field boundary — `a|b` in one field must not hash the same as `a` and `b` in two;
 *   - **every collection is ordered deterministically** — object keys sorted, rules in written
 *     order because order is meaningful for nothing but must still be stable — so key order in the
 *     caller's object is not part of the question being asked.
 *
 * Decimals are canonicalised through their exact text form, never through a `number`. Hashing
 * `216.04800000000003` when the author wrote `216.048` would make two identical requests differ.
 *
 * Owned by: K-06 Policy Engine.
 */

import { createHash } from 'node:crypto';

import { decimalToText } from './decimal.ts';
import type { OutputSchema, OutputValue, PolicyRule, Predicate, ScopeSelector } from './types.ts';

/** A stored fingerprint is a lowercase SHA-256 in hex, and nothing else. */
export const REQUEST_FINGERPRINT = /^[0-9a-f]{64}$/;

const quote = (value: string | number | boolean | null): string => JSON.stringify(value);

export function canonicalPredicate(predicate: Predicate | null): string {
  if (predicate === null) return 'none';
  switch (predicate.kind) {
    case 'fact-equals':
      return `eq(${quote(predicate.fact)},${quote(predicate.value)})`;
    case 'fact-in':
      return `in(${quote(predicate.fact)},[${[...predicate.values].sort().map(quote).join(',')}])`;
    case 'amount-at-least':
      return `gte(${quote(decimalToText(predicate.amount))})`;
    case 'amount-below':
      return `lt(${quote(decimalToText(predicate.amount))})`;
    default:
      return `${predicate.kind}([${predicate.of.map(canonicalPredicate).join(',')}])`;
  }
}

export function canonicalSelector(selector: ScopeSelector): string {
  const bound = Object.entries(selector)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dimension, value]) => `${quote(dimension)}:${quote(value)}`);
  return `{${bound.join(',')}}`;
}

export function canonicalOutputValue(output: OutputValue): string {
  switch (output.kind) {
    case 'decimal':
      return `decimal(${quote(decimalToText(output.value))},${quote(output.value.scale)})`;
    case 'duration-seconds':
      return `duration(${quote(output.value)})`;
    case 'boolean':
      return `boolean(${quote(output.value)})`;
    case 'enum':
      return `enum(${quote(output.value)})`;
    default:
      return `configured(${quote(output.key)})`;
  }
}

export function canonicalOutputSchema(schema: OutputSchema): string {
  switch (schema.kind) {
    case 'decimal':
      return `decimal(${quote(schema.scale)},${quote(decimalToText(schema.minimum))},${quote(
        decimalToText(schema.maximum),
      )})`;
    case 'duration-seconds':
      return `duration(${quote(schema.minimum)},${quote(schema.maximum)})`;
    case 'boolean':
      return 'boolean()';
    case 'enum':
      return `enum([${[...schema.values].sort().map(quote).join(',')}])`;
    default:
      return `configured(${quote(schema.key)})`;
  }
}

const canonicalMap = <T>(entries: Readonly<Record<string, T>>, render: (value: T) => string): string =>
  `{${Object.entries(entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${quote(name)}:${render(value)}`)
    .join(',')}}`;

export function canonicalRule(rule: PolicyRule): string {
  return [
    `ruleId=${quote(rule.ruleId)}`,
    `selector=${canonicalSelector(rule.selector)}`,
    `condition=${canonicalPredicate(rule.condition)}`,
    `outputs=${canonicalMap(rule.outputs, canonicalOutputValue)}`,
  ].join(';');
}

/** Every input a drafted policy is decided from. */
export interface DraftRequestFacts {
  readonly draftId: string;
  readonly policyKey: string;
  readonly outputSchema: Readonly<Record<string, OutputSchema>>;
  readonly rules: readonly PolicyRule[];
  readonly defaultOutputs: Readonly<Record<string, OutputValue>> | null;
  readonly notes: string;
  readonly authorityId: string;
}

export function canonicalDraftRequest(facts: DraftRequestFacts): string {
  return [
    `draftId=${quote(facts.draftId)}`,
    `policyKey=${quote(facts.policyKey)}`,
    `outputSchema=${canonicalMap(facts.outputSchema, canonicalOutputSchema)}`,
    `rules=[${facts.rules.map(canonicalRule).join('|')}]`,
    `defaultOutputs=${
      facts.defaultOutputs === null ? 'none' : canonicalMap(facts.defaultOutputs, canonicalOutputValue)
    }`,
    `notes=${quote(facts.notes)}`,
    `authorityId=${quote(facts.authorityId)}`,
  ].join('|');
}

/** Every input a lifecycle transition is decided from. */
export interface TransitionRequestFacts {
  readonly operation: 'publish' | 'activate' | 'retire';
  readonly recordId: string;
  readonly policyKey: string;
  /** The draft or version this concerns, or the reason text for a retirement. */
  readonly detail: string;
  readonly supersedesVersionId: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly authorityId: string;
}

export function canonicalTransitionRequest(facts: TransitionRequestFacts): string {
  return [
    `operation=${quote(facts.operation)}`,
    `recordId=${quote(facts.recordId)}`,
    `policyKey=${quote(facts.policyKey)}`,
    `detail=${quote(facts.detail)}`,
    `supersedesVersionId=${quote(facts.supersedesVersionId)}`,
    `effectiveFrom=${quote(facts.effectiveFrom)}`,
    `effectiveUntil=${quote(facts.effectiveUntil)}`,
    `authorityId=${quote(facts.authorityId)}`,
  ].join('|');
}

const sha256 = (canonical: string): string =>
  createHash('sha256').update(canonical, 'utf8').digest('hex');

export function fingerprintDraftRequest(facts: DraftRequestFacts): string {
  return sha256(canonicalDraftRequest(facts));
}

export function fingerprintTransitionRequest(facts: TransitionRequestFacts): string {
  return sha256(canonicalTransitionRequest(facts));
}
