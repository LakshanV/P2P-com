/**
 * K-06 Policy Engine — the vocabularies, and what a policy may not be (FND-005b).
 *
 * Four registries, each closing a specific way a policy system goes wrong.
 *
 * **Identifier rules are K-01's**, re-raised in this component's vocabulary exactly as K-02, K-03,
 * K-04 and K-07 do them. A seller handle and a category code are written into every policy row and
 * into every decision that pins one, so an email address arriving as either would put personal
 * data somewhere nobody can enumerate later — and a policy row is kept forever, because a decision
 * from last March still has to be explicable.
 *
 * **Facts are allowlisted.** A rule over an unregistered fact would never match, and a policy that
 * never matches is not an obvious failure: it looks exactly like a policy whose case has not come
 * up yet. Refusing at authoring turns a silent permanent miss into an error while somebody can
 * still fix it, and it bounds what a caller may put into an evaluation request.
 *
 * **The predicate language cannot compute.** No arithmetic, no regular expressions, no
 * interpolation, no function values — a policy is data an operator reads, and anything executable
 * would be a second runtime with no review and no tests. `assertPredicate` refuses a function, a
 * `RegExp` and anything else that is not one of six literal shapes.
 *
 * **Policy keys are refused when they name another component's job.** A policy key called
 * `permissions.staff.elevated` would be an authorisation system with no grant and no revocation;
 * one called `release.checkout-v2.enabled` would be a deployment control that survives a rollback.
 * The refusal names the owner, because somebody reaching for either has a real need.
 *
 * Owned by: K-06 Policy Engine.
 */

import { IdentityError, assertOpaqueIdentifier } from '../identity/index.ts';

import { assertDecimal, refuseFloatingPoint } from './decimal.ts';
import {
  PREDICATE_KINDS,
  PolicyError,
  SCOPE_DIMENSIONS,
  type Predicate,
  type PolicyErrorCode,
  type ScopeDimension,
  type ScopeSelector,
} from './types.ts';

/** K-01's identifier refusals, in this component's vocabulary. The mapping is total and tested. */
export const IDENTITY_REFUSALS: Readonly<Record<string, PolicyErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * An `IdentityError` this cannot translate is rethrown unchanged rather than mislabelled — an
 * error that lies about its own cause is worse than one naming an unexpected component.
 */
export function assertPolicyIdentifier(value: unknown, field: string): string {
  try {
    return assertOpaqueIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    const code = IDENTITY_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new PolicyError(code, error.message);
  }
}

/**
 * The facts a rule may name, and what each is for.
 *
 * The four scope dimensions of v3 §24 plus the transaction amount that section's rules also vary
 * by. Nothing here describes a *person*: no name, no address, no age, no payment instrument, no
 * purchase history. A policy that could vary by those would be a personalisation engine, and it
 * would put the data into every rule row that mentioned it.
 */
export const FACTS: Readonly<Record<string, string>> = Object.freeze({
  country: 'the country the transaction is being conducted in (v3 §24 "geography")',
  category: 'the commerce category the transaction concerns (v3 §24 "category")',
  sellerTier: 'the seller tier, as an opaque handle (v3 §24 "seller tier")',
  seller: 'the seller, as an opaque handle (v3 §24 "seller")',
  amount: 'the transaction amount, as an exact decimal (v3 §24 "transaction amount")',
});

export const FACT_NAMES: readonly string[] = Object.freeze(Object.keys(FACTS).sort());

/** The fact carrying the transaction amount, which the amount predicates read. */
export const AMOUNT_FACT = 'amount';

/**
 * Fields by which a caller would state the answer, or name the version that produced it.
 *
 * The second group matters as much as the first here. A caller supplying `policyVersionId` would
 * be choosing which policy applied to its own transaction — the exact thing v3 §24 forbids when it
 * says changing future policy must not rewrite historical economics, arriving from the other
 * direction.
 */
export const ASSERTED_OUTCOME_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  outputs: 'the answer. K-06 decides what policy says; a caller that could say so is the policy',
  outcome: 'the answer, derived from the rules and the facts',
  decision: 'a whole decision, answer included',
  result: 'the answer, derived from the rules and the facts',
  rate: 'an answer a policy produces, never one it is given',
  commission: 'an answer a policy produces (v3 §24), never one it is given',
  explanation: 'the derived explanation, which names the version and never the fact values',
  ruleId: 'which rule decided it, which is derived from precedence',
  configurationVersionId: 'the K-05 version pinned, which is whatever K-05 actually returned',
  allowed: 'an authorisation. Ask K-04 Permissions; a policy is not a permission',
  permitted: 'an authorisation. Ask K-04 Permissions',
  role: 'a role. K-04 Permissions',
  enabled: 'whether code is running. Ask K-07 Feature Flags; a policy is not a deployment control',
  amountDue: 'money. K-06 returns the rate and K-10 Ledger foundation computes the amount',
  total: 'money. K-10 Ledger foundation',
  balance: 'money. K-10 Ledger foundation',
});

/**
 * Fields an **evaluation** may not carry, on top of the table above.
 *
 * These are legitimate inputs elsewhere: `publish` supplies the opaque id of the version it is
 * creating, exactly as every other component here does. What a caller may never do is name the
 * version its own evaluation should be decided by — that is choosing the economics of its own
 * transaction, which is v3 §24 ("changing future policy must not rewrite historical economics")
 * read backwards. The version that applies is the one in force, and nothing else.
 */
export const PINNED_VERSION_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  policyVersionId:
    'the version that applied. The version in force decides; a caller choosing it would be ' +
    'picking the economics of its own transaction',
  version: 'the version number, which is read from what is in force and never supplied',
  draftId: 'a draft, which is never evaluated — only a published, activated version decides',
});

/** Refuse an evaluation that names the version it wants to be decided by. */
export function assertNoPinnedVersion(request: object): void {
  for (const field of Object.keys(request)) {
    const why = PINNED_VERSION_FIELDS[field];
    if (why === undefined) continue;
    throw new PolicyError(
      'caller-asserted-outcome',
      `evaluate refuses the field "${field}": it is ${why}`,
    );
  }
}

/** Policy-key fragments that mean the caller is building somebody else's component. */
const FORBIDDEN_KEY_FRAGMENTS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly what: string;
  readonly owner: string;
}> = Object.freeze([
  {
    pattern: /\b(permission|permissions|authoris|authoriz|rbac|abac|grant|role)\b/i,
    what: 'authority over what a party may do',
    owner: 'K-04 Permissions, from an explicit grant against a published policy version',
  },
  {
    pattern: /\b(feature-flag|featureflag|rollout|kill-switch|release-toggle)\b/i,
    what: 'whether a code path is running',
    owner: 'K-07 Feature Flags, where a kill switch outranks every definition',
  },
  {
    pattern: /\b(credential|password|session|token|mfa)\b/i,
    what: 'authentication',
    owner: 'K-02 Authentication',
  },
]);

/** Policy keys are dotted lowercase segments: `commerce.commission`, `payout.hold-period`. */
const POLICY_KEY = /^[a-z][a-z0-9-]{1,30}(\.[a-z][a-z0-9-]{1,30}){1,3}$/;

export function assertPolicyKey(value: unknown, field = 'policyKey'): string {
  if (typeof value !== 'string') {
    throw new PolicyError(
      'malformed-identifier',
      `${field} is ${value === null ? 'null' : typeof value}; expected a string`,
    );
  }
  if (!POLICY_KEY.test(value)) {
    throw new PolicyError(
      'malformed-identifier',
      `${field} "${value}" is not a policy key. Keys are two to four dotted lowercase segments, ` +
        'like "commerce.commission" — a namespace, so somebody auditing a historic decision can ' +
        'tell which part of the business the version they pinned belongs to',
    );
  }
  const forbidden = FORBIDDEN_KEY_FRAGMENTS.find((entry) => entry.pattern.test(value));
  if (forbidden !== undefined) {
    throw new PolicyError(
      'malformed-identifier',
      `${field} "${value}" names ${forbidden.what}, which is decided by ${forbidden.owner}. K-06 ` +
        'holds business policy — what the commission is, how long proceeds are held, what the ' +
        'reserve percentage is — and every one of its answers is pinned into a historic record. ' +
        'Authority and deployment state are neither of those',
    );
  }
  return value;
}

export function assertFactName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !(value in FACTS)) {
    throw new PolicyError(
      'unsupported-predicate',
      `${field} is "${String(value)}", which is not a registered fact. Registered: ` +
        `${FACT_NAMES.join(', ')}. A rule over an unregistered fact would never match, and a ` +
        'policy that never matches looks exactly like one whose case has not come up yet',
    );
  }
  return value;
}

export function assertScopeDimension(value: unknown, field: string): ScopeDimension {
  if (typeof value !== 'string' || !(SCOPE_DIMENSIONS as readonly string[]).includes(value)) {
    throw new PolicyError(
      'unsupported-scope',
      `${field} is "${String(value)}"; expected one of ${SCOPE_DIMENSIONS.join(', ')}`,
    );
  }
  return value as ScopeDimension;
}

/** A rule's scope selector: allowlisted dimensions, opaque values, at most one of each. */
export function assertScopeSelector(value: unknown, field = 'selector'): ScopeSelector {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError(
      'unsupported-scope',
      `${field} is ${value === null ? 'null' : typeof value}; expected an object of dimensions`,
    );
  }
  const selector: Record<string, string> = {};
  for (const [dimension, bound] of Object.entries(value as Record<string, unknown>)) {
    const known = assertScopeDimension(dimension, `${field} key "${dimension}"`);
    selector[known] = assertPolicyIdentifier(bound, `${field}.${dimension}`);
  }
  return Object.freeze(selector);
}

/** The deepest a rule tree may nest, and the widest a branch may be. */
export const MAX_PREDICATE_DEPTH = 4;
export const MAX_PREDICATE_BRANCH = 8;
/** The most rules one policy version may carry. */
export const MAX_RULES = 64;

/**
 * Validate a predicate, returning a frozen copy.
 *
 * Bounded on both axes. An unbounded rule tree is not a correctness problem — evaluation would
 * still terminate — it is a *review* problem: a condition nobody can hold in their head is one
 * nobody can confirm is right, and this component's output is pinned into financial records.
 */
export function assertPredicate(value: unknown, path = 'condition', depth = 1): Predicate {
  if (typeof value === 'function' || value instanceof RegExp) {
    throw new PolicyError(
      'unsupported-predicate',
      `${path} is ${typeof value === 'function' ? 'a function' : 'a regular expression'}. A ` +
        'policy is data, not code: anything executable here would be a second runtime with no ' +
        'review, no tests and no version an auditor could read',
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError(
      'unsupported-predicate',
      `${path} is ${value === null ? 'null' : typeof value}; expected a predicate object`,
    );
  }
  if (depth > MAX_PREDICATE_DEPTH) {
    throw new PolicyError(
      'unbounded-structure',
      `${path} nests deeper than ${MAX_PREDICATE_DEPTH}. A condition nobody can read in one ` +
        'sitting is one nobody can confirm, and what this returns is pinned into a financial record',
    );
  }

  const predicate = value as { kind?: unknown; [key: string]: unknown };
  if (
    typeof predicate.kind !== 'string' ||
    !(PREDICATE_KINDS as readonly string[]).includes(predicate.kind)
  ) {
    throw new PolicyError(
      'unsupported-predicate',
      `${path}.kind is "${String(predicate.kind)}"; expected one of ${PREDICATE_KINDS.join(', ')}`,
    );
  }

  switch (predicate.kind) {
    case 'fact-equals':
      return Object.freeze({
        kind: 'fact-equals' as const,
        fact: assertFactName(predicate.fact, `${path}.fact`),
        value: assertPolicyIdentifier(predicate.value, `${path}.value`),
      });

    case 'fact-in': {
      if (!Array.isArray(predicate.values) || predicate.values.length === 0) {
        throw new PolicyError(
          'unsupported-predicate',
          `${path}.values must be a non-empty array; a condition that can match nothing is a rule ` +
            'that never applies',
        );
      }
      if (predicate.values.length > 64) {
        throw new PolicyError(
          'unbounded-structure',
          `${path}.values holds ${predicate.values.length} entries; at most 64`,
        );
      }
      return Object.freeze({
        kind: 'fact-in' as const,
        fact: assertFactName(predicate.fact, `${path}.fact`),
        values: Object.freeze(
          predicate.values.map((entry, index) =>
            assertPolicyIdentifier(entry, `${path}.values[${index}]`),
          ),
        ),
      });
    }

    case 'amount-at-least':
    case 'amount-below': {
      refuseFloatingPoint(predicate.amount, `${path}.amount`);
      return Object.freeze({
        kind: predicate.kind,
        amount: assertDecimal(predicate.amount, `${path}.amount`),
      });
    }

    default: {
      const kind = predicate.kind as 'all' | 'any';
      if (!Array.isArray(predicate.of) || predicate.of.length === 0) {
        throw new PolicyError(
          'unsupported-predicate',
          `${path}.of must be a non-empty array of predicates`,
        );
      }
      if (predicate.of.length > MAX_PREDICATE_BRANCH) {
        throw new PolicyError(
          'unbounded-structure',
          `${path}.of holds ${predicate.of.length} predicates; at most ${MAX_PREDICATE_BRANCH}`,
        );
      }
      return Object.freeze({
        kind,
        of: Object.freeze(
          predicate.of.map((entry, index) =>
            assertPredicate(entry, `${path}.of[${index}]`, depth + 1),
          ),
        ),
      });
    }
  }
}

/** Every fact a predicate tree names, so evaluation can fail closed on a missing one. */
export function factsOf(predicate: Predicate): readonly string[] {
  switch (predicate.kind) {
    case 'fact-equals':
    case 'fact-in':
      return [predicate.fact];
    case 'amount-at-least':
    case 'amount-below':
      return [AMOUNT_FACT];
    default:
      return predicate.of.flatMap(factsOf);
  }
}

/** Refuse a request that carries the answer, or names the version that produced it. */
export function assertNoAssertedOutcome(request: object, operation: string): void {
  for (const field of Object.keys(request)) {
    const owner = ASSERTED_OUTCOME_FIELDS[field];
    if (owner === undefined) continue;
    throw new PolicyError(
      'caller-asserted-outcome',
      `${operation} refuses the field "${field}": it is ${owner}`,
    );
  }
}

/** Refuse a field this component has no meaning for, so a typo is not silently ignored. */
export function assertKnownFields(
  request: object,
  known: readonly string[],
  operation: string,
): void {
  for (const field of Object.keys(request)) {
    if (known.includes(field)) continue;
    throw new PolicyError(
      'malformed-record',
      `${operation} does not accept the field "${field}". Accepted: ${known.join(', ')}. A field ` +
        'nobody reads is a rule somebody believes is in force',
    );
  }
}

/**
 * Refuse an origin that is not a human or a system.
 *
 * There is no `ai` kind in this component at all — not refused at the boundary and permitted
 * internally, but absent from the type. v3 §38 says AI must never be the financial authority, and
 * an agent that could author the commission policy would be exactly that, one indirection out.
 */
export function assertOrigin(value: unknown, field: string): { kind: 'human' | 'system'; id: string } {
  if (value === null || typeof value !== 'object') {
    throw new PolicyError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected { kind, id }`,
    );
  }
  const origin = value as { kind?: unknown; id?: unknown };
  if (origin.kind === 'ai') {
    throw new PolicyError(
      'malformed-record',
      `${field}.kind is "ai". No agent drafts, publishes, activates or retires a policy: v3 §38 ` +
        'says AI must never be the financial authority, and the commission rate, the hold period ' +
        'and the reserve percentage are exactly that authority written down',
    );
  }
  if (origin.kind !== 'human' && origin.kind !== 'system') {
    throw new PolicyError(
      'malformed-record',
      `${field}.kind is "${String(origin.kind)}"; expected "human" or "system"`,
    );
  }
  return { kind: origin.kind, id: assertPolicyIdentifier(origin.id, `${field}.id`) };
}
