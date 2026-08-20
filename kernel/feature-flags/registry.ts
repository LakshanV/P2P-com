/**
 * K-07 Feature Flags — the vocabularies, and what a flag may not be (FND-004e).
 *
 * Three registries, and each exists because of a specific way a feature-flag system goes wrong.
 *
 * **Identifier rules are K-01's**, re-raised in this component's vocabulary exactly as K-02, K-03
 * and K-04 do them. A flag's subject key is hashed into a bucket and its scope id is written into
 * every row, so an email address arriving as either would put personal data somewhere nobody can
 * enumerate later.
 *
 * **Targeting attributes are allowlisted and typed.** A rule over an unregistered attribute would
 * never match, and a flag that never matches is not an obvious failure — it looks exactly like a
 * rollout that has not reached anybody yet. Refusing at publication turns a silent permanent
 * `false` into an error at the moment somebody could still fix it. It also bounds what a caller
 * may put in the context, which is what keeps a targeting request from becoming an arbitrary
 * key-value channel into rows and logs.
 *
 * **Flag keys are refused when they name another component's job.** This is the load-bearing one.
 * A feature flag is a deployment control; the moment somebody publishes `permissions.admin.enabled`
 * or `payout.commission.enabled`, the platform has an authorisation system and a pricing system
 * with no policy version, no audit trail and no revocation — changeable by whoever can reach this
 * service. §1 of the contract sets out the five things a flag is not, and this table is that
 * paragraph made executable.
 *
 * Owned by: K-07 Feature Flags.
 */

import { IdentityError, assertOpaqueIdentifier } from '../identity/index.ts';

import {
  FeatureFlagError,
  PREDICATE_KINDS,
  SCOPE_LEVELS,
  type FeatureFlagErrorCode,
  type Predicate,
  type ScopeLevel,
} from './types.ts';

/** K-01's identifier refusals, in this component's vocabulary. The mapping is total and tested. */
export const IDENTITY_REFUSALS: Readonly<Record<string, FeatureFlagErrorCode>> = Object.freeze({
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
export function assertFlagIdentifier(value: unknown, field: string): string {
  try {
    return assertOpaqueIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    const code = IDENTITY_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new FeatureFlagError(code, error.message);
  }
}

/**
 * Attributes a targeting rule may name, and what each is for.
 *
 * Small on purpose. Every entry here is something a *deployment* can reasonably vary on — where
 * the request is from, what kind of thing it is about, which release channel it arrived through.
 * Nothing here describes the party: no role, no verification level, no balance, no purchase
 * history. A flag that could target "verified sellers over £10,000" would be an entitlement system
 * built out of deployment controls.
 */
export const TARGET_ATTRIBUTES: Readonly<Record<string, string>> = Object.freeze({
  country: 'the country a request is being served for (v3 §36 "selected countries")',
  category: 'the commerce category a request concerns (v3 §36 "selected categories")',
  channel: 'the client channel a request arrived through — web, mobile, partner',
  cohort: 'an opaque operator-defined cohort handle, for "selected accounts" and pilot groups',
});

export const TARGET_ATTRIBUTE_NAMES: readonly string[] = Object.freeze(
  Object.keys(TARGET_ATTRIBUTES).sort(),
);

/**
 * Fields by which a caller would state the answer, or state something another component owns.
 *
 * The first group is the security group: a request carrying `enabled`, `allowed` or `variant` is
 * not making a typo, it is trying to be the evaluator. The rest name the five things §1 says a
 * flag is not, so a caller reaching for them is told which component to ask instead.
 */
export const ASSERTED_OUTCOME_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  enabled: 'the answer. K-07 decides whether a flag is on; a caller that could say so is the flag',
  disabled: 'the answer, inverted. K-07 decides; a caller that could say so is the flag',
  on: 'the answer. Whether a flag is on is what this component is for',
  off: 'the answer. Whether a flag is off is what this component is for',
  active: 'the answer. Which version is active is read from the activation chain, never supplied',
  result: 'the answer, which is derived from the active version and the request',
  outcome: 'the answer, which is derived from the active version and the request',
  explanation: 'the derived explanation, which names the version and never the context values',
  bucket: 'the rollout bucket, derived from a hash of the subject key and never accepted',
  evaluation: 'a whole evaluation, answer included',
  decision: 'a whole decision. K-04 Permissions decides authority; K-07 decides nothing about it',
  allowed: 'an authorisation. Ask K-04 Permissions; a flag is not a permission',
  permitted: 'an authorisation. Ask K-04 Permissions',
  authorized: 'an authorisation. Ask K-04 Permissions',
  authorised: 'an authorisation. Ask K-04 Permissions',
  role: 'a role. Roles are K-04 Permissions, and a flag has never conferred one',
  permissions: 'permissions. K-04 Permissions',
  grant: 'a grant. K-04 Permissions',
  entitled: 'an entitlement. The Capability & Verification module owns what a party has',
  entitlement: 'an entitlement. The Capability & Verification module',
  subscription: 'an entitlement. The Capability & Verification module',
  variant: 'an experiment assignment. Analytics (v3 §48) owns experiments; a rollout is not one',
  experiment: 'an experiment. Analytics (v3 §48)',
  price: 'money. K-10 Ledger foundation and the pricing modules own every amount',
  amount: 'money. K-10 Ledger foundation',
  fee: 'money. K-10 Ledger foundation',
  commission: 'money. K-10 Ledger foundation',
  currency: 'money. K-10 Ledger foundation',
  aiAuthority: 'what an agent may do. K-04 Permissions and v3 §38; never a deployment control',
  policyVersionId: 'a policy version. K-05 Configuration and K-06 Policy own versioned policy',
  subjectId: 'the party. K-07 never learns who a subject is — it takes an opaque key and hashes it',
  accountId: 'the party. K-01/K-03 own parties; a flag takes a scope handle, not an account record',
});

/** Flag-key fragments that mean the caller is building somebody else's component. */
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
    pattern: /\b(entitlement|entitled|subscription|plan|tier)\b/i,
    what: 'what a party has bought or been verified for',
    owner: 'the Capability & Verification module',
  },
  {
    pattern: /\b(price|pricing|fee|fees|commission|payout|ledger|refund|settlement|tax)\b/i,
    what: 'a financial decision',
    owner: 'K-10 Ledger foundation and the finance modules, where amounts are versioned policy',
  },
  {
    pattern: /\b(experiment|ab-test|abtest|variant|holdout)\b/i,
    what: 'an experiment assignment',
    owner: 'Analytics (v3 §48), where a variant is stable, recorded and analysable',
  },
  {
    pattern: /\b(ai-authority|agent-authority|autonomy-level|ai-approval)\b/i,
    what: 'what an AI agent is allowed to decide',
    owner: 'K-04 Permissions and v3 §38 — never a deployment control',
  },
]);

/** Flag keys are dotted lowercase segments: `commerce.autonomous-purchasing`. */
const FLAG_KEY = /^[a-z][a-z0-9-]{1,30}(\.[a-z][a-z0-9-]{1,30}){1,3}$/;

/**
 * Refuse a flag key that is malformed, or that names another component's decision.
 *
 * The refusal names the owner rather than saying no: somebody reaching for
 * `payout.commission.enabled` has a real need, and the useful answer is which component versions
 * that decision — not that this one declines.
 */
export function assertFlagKey(value: unknown, field = 'flagKey'): string {
  if (typeof value !== 'string') {
    throw new FeatureFlagError(
      'malformed-identifier',
      `${field} is ${value === null ? 'null' : typeof value}; expected a string`,
    );
  }
  if (!FLAG_KEY.test(value)) {
    throw new FeatureFlagError(
      'malformed-identifier',
      `${field} "${value}" is not a flag key. Keys are two to four dotted lowercase segments, ` +
        'like "commerce.autonomous-purchasing" — a namespace so an operator reading a list of ' +
        'flags can tell which part of the platform each one stops',
    );
  }
  const forbidden = FORBIDDEN_KEY_FRAGMENTS.find((entry) => entry.pattern.test(value));
  if (forbidden !== undefined) {
    throw new FeatureFlagError(
      'not-a-feature-flag',
      `${field} "${value}" names ${forbidden.what}, which is decided by ${forbidden.owner}. A ` +
        'feature flag is a deployment control: it says whether code is running, never whether ' +
        'something is permitted, owed, priced or assigned. Wiring one to that decision would ' +
        'create a second answer with no version, no audit trail and no way to revoke it',
    );
  }
  return value;
}

/** Refuse a request that carries the answer, or another component's subject matter. */
export function assertNoAssertedOutcome(request: object, operation: string): void {
  for (const field of Object.keys(request)) {
    const owner = ASSERTED_OUTCOME_FIELDS[field];
    if (owner === undefined) continue;
    throw new FeatureFlagError(
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
    throw new FeatureFlagError(
      'malformed-record',
      `${operation} does not accept the field "${field}". Accepted: ${known.join(', ')}. A field ` +
        'nobody reads is a setting somebody believes is in force',
    );
  }
}

export function assertScopeLevel(value: unknown, field: string): ScopeLevel {
  if (typeof value !== 'string' || !(SCOPE_LEVELS as readonly string[]).includes(value)) {
    throw new FeatureFlagError(
      'unsupported-scope',
      `${field} is "${String(value)}"; expected one of ${SCOPE_LEVELS.join(', ')}`,
    );
  }
  return value as ScopeLevel;
}

/** A scope: `global` carries no id, and every other level must carry an opaque one. */
export function assertScope(value: unknown, field = 'scope'): { level: ScopeLevel; id: string } {
  if (value === null || typeof value !== 'object') {
    throw new FeatureFlagError(
      'unsupported-scope',
      `${field} is ${value === null ? 'null' : typeof value}; expected { level, id }`,
    );
  }
  const candidate = value as { level?: unknown; id?: unknown };
  const level = assertScopeLevel(candidate.level, `${field}.level`);
  if (level === 'global') {
    if (candidate.id !== undefined && candidate.id !== '') {
      throw new FeatureFlagError(
        'unsupported-scope',
        `${field}.id must be empty for the global scope; "${String(candidate.id)}" was supplied`,
      );
    }
    return { level, id: '' };
  }
  return { level, id: assertFlagIdentifier(candidate.id, `${field}.id`) };
}

/** The levels a flag version may be evaluated at: non-empty, no duplicates, canonically ordered. */
export function assertSupportedScopes(value: unknown, field = 'supportedScopes'): ScopeLevel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FeatureFlagError(
      'unsupported-scope',
      `${field} must be a non-empty array. A flag supporting no scope can never be evaluated, ` +
        'which is a permanent silent off rather than an off anybody chose',
    );
  }
  const levels = value.map((entry, index) => assertScopeLevel(entry, `${field}[${index}]`));
  const unique = new Set(levels);
  if (unique.size !== levels.length) {
    throw new FeatureFlagError('unsupported-scope', `${field} names the same level twice`);
  }
  return SCOPE_LEVELS.filter((level) => unique.has(level));
}

/** A targeting attribute name: allowlisted, so a rule cannot be written over an unknown key. */
export function assertAttribute(value: unknown, field: string): string {
  if (typeof value !== 'string' || !(value in TARGET_ATTRIBUTES)) {
    throw new FeatureFlagError(
      'unsupported-predicate',
      `${field} is "${String(value)}", which is not a targeting attribute. Registered: ` +
        `${TARGET_ATTRIBUTE_NAMES.join(', ')}. A rule over an unregistered attribute would never ` +
        'match, and a flag that never matches looks exactly like a rollout that has not started',
    );
  }
  return value;
}

/**
 * Validate a targeting predicate, returning a frozen copy.
 *
 * There is no `not`, and no comparison other than equality and set membership. A negated rule is
 * the shape most likely to be read backwards in an incident, and a rollout control that somebody
 * misreads at three in the morning is worse than one that cannot express the case at all.
 */
export function assertPredicate(value: unknown, path = 'rules[0]'): Predicate {
  if (value === null || typeof value !== 'object') {
    throw new FeatureFlagError(
      'unsupported-predicate',
      `${path} is ${value === null ? 'null' : typeof value}; expected a predicate object`,
    );
  }
  const predicate = value as { kind?: unknown; [key: string]: unknown };
  if (
    typeof predicate.kind !== 'string' ||
    !(PREDICATE_KINDS as readonly string[]).includes(predicate.kind)
  ) {
    throw new FeatureFlagError(
      'unsupported-predicate',
      `${path}.kind is "${String(predicate.kind)}"; expected one of ${PREDICATE_KINDS.join(', ')}`,
    );
  }

  switch (predicate.kind) {
    case 'attribute-equals':
      return Object.freeze({
        kind: 'attribute-equals' as const,
        attribute: assertAttribute(predicate.attribute, `${path}.attribute`),
        value: assertFlagIdentifier(predicate.value, `${path}.value`),
      });

    case 'attribute-in': {
      if (!Array.isArray(predicate.values) || predicate.values.length === 0) {
        throw new FeatureFlagError(
          'unsupported-predicate',
          `${path}.values must be a non-empty array; a rule that can match nothing is a flag ` +
            'that never turns on',
        );
      }
      return Object.freeze({
        kind: 'attribute-in' as const,
        attribute: assertAttribute(predicate.attribute, `${path}.attribute`),
        values: Object.freeze(
          predicate.values.map((entry, index) =>
            assertFlagIdentifier(entry, `${path}.values[${index}]`),
          ),
        ),
      });
    }

    default: {
      const kind = predicate.kind as 'all' | 'any';
      if (!Array.isArray(predicate.of) || predicate.of.length === 0) {
        throw new FeatureFlagError(
          'unsupported-predicate',
          `${path}.of must be a non-empty array of predicates`,
        );
      }
      if (predicate.of.length > 8) {
        throw new FeatureFlagError(
          'unsupported-predicate',
          `${path}.of holds ${predicate.of.length} predicates; at most 8. A rollout rule nobody ` +
            'can read in one sitting is one nobody can safely turn off',
        );
      }
      return Object.freeze({
        kind,
        of: Object.freeze(
          predicate.of.map((entry, index) => assertPredicate(entry, `${path}.of[${index}]`)),
        ),
      });
    }
  }
}

/** Every attribute a rule tree names, so evaluation can fail closed on a missing one. */
export function attributesOf(predicate: Predicate): readonly string[] {
  switch (predicate.kind) {
    case 'attribute-equals':
    case 'attribute-in':
      return [predicate.attribute];
    default:
      return predicate.of.flatMap(attributesOf);
  }
}

/**
 * Validate an evaluation context: allowlisted keys, opaque values.
 *
 * The values are the reason this is strict. A context is supplied per request and is the one part
 * of an evaluation a caller controls entirely, so an unbounded one is a channel through which a
 * caller's data reaches this component's explanations and any log that carries them.
 */
export function assertContext(
  value: unknown,
  field = 'attributes',
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FeatureFlagError(
      'unsupported-predicate',
      `${field} is ${value === null ? 'null' : typeof value}; expected an object of attributes`,
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 8) {
    throw new FeatureFlagError(
      'unsupported-predicate',
      `${field} carries ${entries.length} attributes; at most 8`,
    );
  }
  const context: Record<string, string> = {};
  for (const [key, entry] of entries) {
    context[assertAttribute(key, `${field} key "${key}"`)] = assertFlagIdentifier(
      entry,
      `${field}.${key}`,
    );
  }
  return Object.freeze(context);
}

/**
 * Refuse an origin that is not a human or a system.
 *
 * There is no `ai` kind in this component at all — not refused at the boundary and permitted
 * internally, but absent from the type. An agent that could publish a flag version could enable
 * or disable any code path in the platform, and v3 §38 puts that decision behind a human.
 */
export function assertOrigin(value: unknown, field: string): { kind: 'human' | 'system'; id: string } {
  if (value === null || typeof value !== 'object') {
    throw new FeatureFlagError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected { kind, id }`,
    );
  }
  const origin = value as { kind?: unknown; id?: unknown };
  if (origin.kind === 'ai') {
    throw new FeatureFlagError(
      'not-a-feature-flag',
      `${field}.kind is "ai". No agent publishes, activates, kills or retires a flag: a flag ` +
        'turns code paths on and off across the whole deployment, and v3 §38 keeps that behind a ' +
        'human decision',
    );
  }
  if (origin.kind !== 'human' && origin.kind !== 'system') {
    throw new FeatureFlagError(
      'malformed-record',
      `${field}.kind is "${String(origin.kind)}"; expected "human" or "system"`,
    );
  }
  return { kind: origin.kind, id: assertFlagIdentifier(origin.id, `${field}.id`) };
}
