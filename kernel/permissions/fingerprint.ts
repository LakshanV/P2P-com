/**
 * K-04 Permissions — the canonical form of a decision request (FND-004d correction).
 *
 * An idempotency key is a **claim about identity of intent**, and on its own it is a bearer token
 * for an answer somebody else was given. The first revision of `authorize` compared a retry against
 * the stored decision's `decisionId`, `accountId`, `action`, `resourceType`, `resourceId` and
 * `purpose` — six of the nine facts the decision actually depended on. The three it omitted were
 * the three worth stealing:
 *
 *   - **the subject and session the answer was computed for.** A caller presenting somebody else's
 *     idempotency key received their `allow`, and — because the lookup happened before the token
 *     was validated — did not have to present a working session at all.
 *   - **the ABAC context.** A grant conditioned on `region = north` could be satisfied once and
 *     then replayed from anywhere, because the context that satisfied it was never recorded.
 *
 * So every decision now carries a SHA-256 over **all** of its authoritative inputs, in a canonical
 * form, and a retry is answered from storage only when that fingerprint matches. The fingerprint is
 * stored rather than recomputed-and-compared-field-by-field because the context is not a column: it
 * is a variable-shaped map, and the only honest way to say "the same context" is to have written
 * down what it was.
 *
 * Canonical means: fixed field order, sorted context keys, and every value JSON-quoted so a value
 * containing a separator cannot impersonate two fields. `{"a":"b:c"}` and `{"a:b":"c"}` must not
 * collide, or the fingerprint is decorative.
 *
 * Owned by: K-04 Permissions.
 */

import { createHash } from 'node:crypto';

import type { Purpose } from './types.ts';

/**
 * Every input a decision depends on, and nothing that it does not.
 *
 * `decisionId` is here because a caller that could reuse a key with a fresh decision id would get
 * two records of one decision. `decidedAt` is **not**: it is service-generated, so including it
 * would make every retry a mismatch and idempotency impossible.
 */
export interface DecisionRequestFacts {
  readonly decisionId: string;
  /** From the validated session. The caller never supplies this. */
  readonly subjectId: string;
  /** From the validated session. Binds the answer to the session that earned it. */
  readonly sessionId: string;
  readonly accountId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly purpose: Purpose | null;
  /** The allowlisted ABAC context, exactly as the evaluation saw it. */
  readonly context: Readonly<Record<string, string>>;
}

/**
 * The canonical text a fingerprint is taken over.
 *
 * Exported so a test — and a person debugging a mismatch — can see precisely what was compared,
 * rather than being handed two hashes and told they differ.
 */
export function canonicalDecisionRequest(facts: DecisionRequestFacts): string {
  const context = Object.keys(facts.context)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(facts.context[key] ?? null)}`)
    .join(',');

  // Fixed order, every value quoted. A field is `"name":"value"`, so no value can be mistaken for
  // a field boundary however it is spelled.
  return [
    `"decisionId":${JSON.stringify(facts.decisionId)}`,
    `"subjectId":${JSON.stringify(facts.subjectId)}`,
    `"sessionId":${JSON.stringify(facts.sessionId)}`,
    `"accountId":${JSON.stringify(facts.accountId)}`,
    `"action":${JSON.stringify(facts.action)}`,
    `"resourceType":${JSON.stringify(facts.resourceType)}`,
    `"resourceId":${JSON.stringify(facts.resourceId)}`,
    `"purpose":${JSON.stringify(facts.purpose)}`,
    `"context":{${context}}`,
  ].join(',');
}

/** SHA-256 of the canonical form, lower-case hex. The stored shape of "the same question". */
export function fingerprintDecisionRequest(facts: DecisionRequestFacts): string {
  return createHash('sha256').update(canonicalDecisionRequest(facts), 'utf8').digest('hex');
}

/** Exactly what `fingerprintDecisionRequest` emits, and nothing else. */
export const REQUEST_FINGERPRINT = /^[0-9a-f]{64}$/;
