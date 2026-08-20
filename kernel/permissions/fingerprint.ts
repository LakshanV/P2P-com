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

/**
 * Everything an administration request depends on: who asked, from which session and account, and
 * what they asked for.
 *
 * The three administration operations — publish a policy, grant, revoke — each write a statement
 * about authority, so "the same request" has to include **who made it**. Without the actor in here,
 * an idempotency key captured from an administrator could be replayed by anybody else holding it,
 * and the record would converge on the original as though the second caller had never existed.
 *
 * `operation` is in the fingerprint so one key cannot be shared across two different kinds of
 * authority statement, and `bootstrap` is in it so a bootstrap publication and an administered one
 * can never be mistaken for each other however identical their content.
 */
export interface AdministrationRequestFacts {
  readonly operation: 'publish-policy' | 'grant' | 'revoke';
  /** The record's own id: policy version id, grant id or revocation id. */
  readonly recordId: string;
  /** The authenticated administrator, from the validated session. Never caller-supplied. */
  readonly actorSubjectId: string;
  readonly actorSessionId: string;
  readonly actorAccountId: string;
  /** True only for the bootstrap publication, which has no authenticated administrator. */
  readonly bootstrap: boolean;
  /** The declared purpose the administration was authorised under, when one was required. */
  readonly purpose: string | null;
  /**
   * The content of the statement, already canonical.
   *
   * Kept as one opaque string rather than a shape per operation, because what makes a grant "the
   * same grant" is decided by `differencesBetweenGrants` and duplicating that here would be a
   * second rule to keep in step.
   */
  readonly content: string;
}

/** The canonical text an administration fingerprint is taken over. */
export function canonicalAdministrationRequest(facts: AdministrationRequestFacts): string {
  return [
    `"operation":${JSON.stringify(facts.operation)}`,
    `"recordId":${JSON.stringify(facts.recordId)}`,
    `"actorSubjectId":${JSON.stringify(facts.actorSubjectId)}`,
    `"actorSessionId":${JSON.stringify(facts.actorSessionId)}`,
    `"actorAccountId":${JSON.stringify(facts.actorAccountId)}`,
    `"bootstrap":${JSON.stringify(facts.bootstrap)}`,
    `"purpose":${JSON.stringify(facts.purpose)}`,
    `"content":${JSON.stringify(facts.content)}`,
  ].join(',');
}

/** SHA-256 of the canonical form, lower-case hex. */
export function fingerprintAdministrationRequest(facts: AdministrationRequestFacts): string {
  return createHash('sha256').update(canonicalAdministrationRequest(facts), 'utf8').digest('hex');
}
