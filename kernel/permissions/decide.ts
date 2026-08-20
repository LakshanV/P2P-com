/**
 * K-04 Permissions — the evaluation itself (FND-004d).
 *
 * Pure, deterministic and separate from the service on purpose: the decision is the thing most
 * worth testing exhaustively, and a function taking state and returning an outcome can be tested
 * exhaustively without a repository, a clock or a session.
 *
 * The order is the design, and it is fixed:
 *
 *   1. **Deny by default.** The answer is `deny` before anything is examined. Every other step can
 *      only move it to `allow` by finding a reason, and any step may move it back.
 *   2. **Filter to grants that could apply** — right subject, right account, right action, right
 *      resource. Anything else is not evidence about this request.
 *   3. **Discard what is not in force**: revoked, not yet valid, expired, or not permitted to the
 *      grant's role by the active policy version. A revoked grant is not a weak allow; it is not a
 *      grant.
 *   4. **Purpose limitation** for staff roles: no declared purpose, or one the grant does not
 *      name, and the grant does not apply.
 *   5. **Condition**: a typed predicate over an allowlisted context, evaluated against the
 *      presented context and the session's assurance.
 *   6. **Deny precedence.** If any surviving grant denies, the answer is `deny` — whatever else
 *      allows, however specific it is. There is no scoring, no specificity rule and no
 *      most-recent-wins, because every one of those is a way for an allow to beat a deny by
 *      accident.
 *
 * Ties are broken by grant id, so two equally-applicable grants always produce the same decision
 * record. A non-deterministic explanation is one nobody can reproduce in an incident.
 *
 * Owned by: K-04 Permissions.
 */

import { compareInstants } from '../../platform/time/instant.ts';

import {
  ASSURANCE_RANK,
  isStaffRole,
  type AssuranceLevel,
  type DecisionReason,
  type Effect,
  type Grant,
  type PolicyVersion,
  type Predicate,
  type Purpose,
} from './types.ts';

/** Everything the evaluation is allowed to look at. Nothing here comes from the caller unchecked. */
export interface EvaluationInput {
  readonly subjectId: string;
  readonly accountId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly purpose: Purpose | null;
  readonly context: Readonly<Record<string, string>>;
  readonly assurance: AssuranceLevel;
  readonly now: string;
  readonly policy: PolicyVersion;
  readonly grants: readonly Grant[];
  /** Grant ids with a revocation recorded against them. */
  readonly revokedGrantIds: ReadonlySet<string>;
}

export interface Evaluation {
  readonly effect: Effect;
  readonly reason: DecisionReason;
  readonly explanation: string;
  readonly decidingGrantId: string | null;
}

/** Why one grant did not apply, kept so the explanation can say which check it failed. */
type Rejection = Exclude<DecisionReason, 'explicit-allow' | 'explicit-deny' | 'no-matching-grant'>;

const REJECTION_PRIORITY: readonly Rejection[] = [
  // Ordered by how much the reader needs to know: a revoked grant is a different problem from a
  // missing purpose, and reporting the most actionable one first is what makes a denial useful.
  'grant-revoked',
  'purpose-not-satisfied',
  'outside-validity-window',
  'condition-unsatisfied',
  'not-permitted-by-policy',
];

/** Does the active policy version permit this role to do this at all? */
function policyPermits(policy: PolicyVersion, grant: Grant): boolean {
  const definition = policy.roles.find((entry) => entry.role === grant.role);
  if (definition === undefined) return false;
  return definition.capabilities.some(
    (capability) =>
      capability.action === grant.action && capability.resourceType === grant.resourceType,
  );
}

/** Is `now` inside the grant's window? Both bounds are optional; both are honoured when present. */
function inWindow(grant: Grant, now: string): boolean {
  if (grant.notBefore !== null && compareInstants(now, grant.notBefore) < 0) return false;
  if (grant.expiresAt !== null && compareInstants(now, grant.expiresAt) >= 0) return false;
  return true;
}

/**
 * Evaluate a predicate against the presented context.
 *
 * An attribute the context does not carry makes the predicate false rather than throwing: the
 * predicate's attributes were already checked against the allowlist when the grant was written, so
 * an absent value here means the caller did not supply it, and a grant conditioned on something
 * the caller did not supply does not apply. Deny-by-default, one level down.
 */
export function evaluatePredicate(
  predicate: Predicate,
  context: Readonly<Record<string, string>>,
  assurance: AssuranceLevel,
): boolean {
  switch (predicate.kind) {
    case 'always':
      return true;
    case 'attribute-equals':
      return context[predicate.attribute] === predicate.value;
    case 'attribute-in': {
      const value = context[predicate.attribute];
      return value !== undefined && predicate.values.includes(value);
    }
    case 'assurance-at-least':
      return ASSURANCE_RANK[assurance] >= ASSURANCE_RANK[predicate.assurance];
    case 'all':
      return predicate.of.every((entry) => evaluatePredicate(entry, context, assurance));
    case 'any':
      return predicate.of.some((entry) => evaluatePredicate(entry, context, assurance));
  }
}

/** Does this grant address this request at all? Scope only — nothing about whether it is in force. */
function addresses(grant: Grant, input: EvaluationInput): boolean {
  if (grant.subjectId !== input.subjectId) return false;
  if (grant.accountId !== input.accountId) return false;
  if (grant.action !== input.action) return false;
  if (grant.resourceType !== input.resourceType) return false;
  // A grant with no resourceId covers every resource of that type inside the account; one with a
  // resourceId covers exactly that resource and nothing else.
  if (grant.resourceId !== null && grant.resourceId !== input.resourceId) return false;
  return true;
}

/** The check a grant failed, or null when it applies. */
function rejectionFor(grant: Grant, input: EvaluationInput): Rejection | null {
  if (input.revokedGrantIds.has(grant.grantId)) return 'grant-revoked';
  if (!inWindow(grant, input.now)) return 'outside-validity-window';
  if (!policyPermits(input.policy, grant)) return 'not-permitted-by-policy';

  if (isStaffRole(grant.role)) {
    // Purpose limitation. The grant names one purpose; the caller declared one; they must be the
    // same. A staff grant is authority to act *for a stated reason*, not authority to act.
    if (input.purpose === null || grant.purpose !== input.purpose) return 'purpose-not-satisfied';
  }

  if (grant.condition !== null) {
    if (!evaluatePredicate(grant.condition, input.context, input.assurance)) {
      return 'condition-unsatisfied';
    }
  }
  return null;
}

const describe = (grant: Grant): string =>
  `${grant.effect} ${grant.action} on ${grant.resourceType}` +
  `${grant.resourceId === null ? '' : ` ${grant.resourceId}`} held as ${grant.role}`;

/**
 * Decide, and say why.
 *
 * Returns the same answer for the same input every time, including the explanation string — which
 * is what makes a decision record comparable across a replay.
 */
export function evaluate(input: EvaluationInput): Evaluation {
  const addressed = input.grants
    .filter((grant) => addresses(grant, input))
    .slice()
    .sort((a, b) => a.grantId.localeCompare(b.grantId));

  if (addressed.length === 0) {
    return {
      effect: 'deny',
      reason: 'no-matching-grant',
      explanation:
        `denied: nothing grants ${input.action} on ${input.resourceType}` +
        `${input.resourceId === null ? '' : ` ${input.resourceId}`} to this subject in account ` +
        `${input.accountId}. Access is denied unless something explicitly allows it`,
      decidingGrantId: null,
    };
  }

  const applying: Grant[] = [];
  const rejected: Array<{ grant: Grant; rejection: Rejection }> = [];
  for (const grant of addressed) {
    const rejection = rejectionFor(grant, input);
    if (rejection === null) applying.push(grant);
    else rejected.push({ grant, rejection });
  }

  // Deny precedence, before anything else is considered. This is the one rule that must not be
  // reachable by any other path through this function.
  const denying = applying.find((grant) => grant.effect === 'deny');
  if (denying !== undefined) {
    return {
      effect: 'deny',
      reason: 'explicit-deny',
      explanation:
        `denied: grant ${denying.grantId} explicitly denies ${denying.action} on ` +
        `${denying.resourceType}. A deny outranks every allow, however specific the allow is`,
      decidingGrantId: denying.grantId,
    };
  }

  const allowing = applying.find((grant) => grant.effect === 'allow');
  if (allowing !== undefined) {
    return {
      effect: 'allow',
      reason: 'explicit-allow',
      explanation:
        `allowed: grant ${allowing.grantId} permits ${describe(allowing)}` +
        `${allowing.purpose === null ? '' : ` for the declared purpose ${allowing.purpose}`}, ` +
        `under policy version ${input.policy.version}, and nothing denies it`,
      decidingGrantId: allowing.grantId,
    };
  }

  // Everything that addressed the request failed a check. Report the most actionable failure, and
  // name the grant, so the reader knows the authority exists and what stopped it applying.
  const best = REJECTION_PRIORITY.map((rejection) =>
    rejected.find((entry) => entry.rejection === rejection),
  ).find((entry) => entry !== undefined);

  const entry = best ?? rejected[0];
  if (entry === undefined) {
    return {
      effect: 'deny',
      reason: 'no-matching-grant',
      explanation: `denied: no grant applies to ${input.action} on ${input.resourceType}`,
      decidingGrantId: null,
    };
  }

  return {
    effect: 'deny',
    reason: entry.rejection,
    explanation: `denied: grant ${entry.grant.grantId} would permit ${describe(entry.grant)}, but ${explain(entry.rejection, entry.grant, input)}`,
    decidingGrantId: entry.grant.grantId,
  };
}

function explain(rejection: Rejection, grant: Grant, input: EvaluationInput): string {
  switch (rejection) {
    case 'grant-revoked':
      return 'it has been revoked. A revoked grant is not a weaker grant; it is not a grant';
    case 'outside-validity-window':
      return (
        `it is outside its validity window (${grant.notBefore ?? 'no start'} to ` +
        `${grant.expiresAt ?? 'no end'}) at ${input.now}`
      );
    case 'not-permitted-by-policy':
      return (
        `policy version ${input.policy.version} does not permit ${grant.role} to ` +
        `${grant.action} a ${grant.resourceType}. A grant cannot exceed the policy it was made under`
      );
    case 'purpose-not-satisfied':
      return input.purpose === null
        ? `it is held as ${grant.role}, a staff role, and no purpose was declared. Staff access is ` +
            'role-based, purpose-based and audited'
        : `the declared purpose "${input.purpose}" is not the purpose it was granted for ` +
            `("${String(grant.purpose)}")`;
    case 'condition-unsatisfied':
      return 'its condition does not hold against the presented context';
  }
}
