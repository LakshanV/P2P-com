/**
 * K-06 Policy Engine — domain types (FND-005b).
 *
 * K-06 answers: **what does business policy say about this situation, and which version said it?**
 * The second half is the whole reason the component exists. v3 §35 requires that policies be
 * versioned and that *historic transactions retain the policy version originally applied*; v3 §24
 * requires that every transaction store the exact commission policy version applied at purchase
 * time, and that changing future policy must not rewrite historical economics.
 *
 * So **every successful evaluation returns a `policyVersionId`**, and there is no code path that
 * returns an answer without one. A caller that stores the outputs and discards the version id has
 * recorded a number nobody can ever explain again — which is why the id is not optional, not
 * nullable and not derived: it is the first field of the result.
 *
 * Where it sits between its neighbours:
 *
 * | Question | Component |
 * |---|---|
 * | What is the current value of one setting | **K-05 Configuration** — one key, one value, one version |
 * | What does policy say, given these facts | **K-06** — rules over facts, typed outputs, one version |
 * | Is this code path running | **K-07 Feature Flags** — a deployment control, never a business rule |
 * | May this party do this | **K-04 Permissions** — authority, from grants |
 * | What is this amount | **K-10 Ledger foundation** — K-06 returns the *rate*; it never multiplies |
 *
 * That last row is a boundary, not a detail. K-06 hands back "17.5000%" and the version that said
 * so. It does not compute a commission, because a policy engine that did arithmetic would be a
 * second place money is calculated, and v3 §38 wants exactly one.
 *
 * Deterministic and provider-neutral by construction: no clock is read here, no randomness is
 * generated here, no floating-point number exists anywhere in the component, and nothing in it
 * knows that AI exists.
 *
 * Owned by: K-06 Policy Engine. See kernel/policy-engine/CONTRACT.md.
 */

import type { Decimal } from './decimal.ts';

export type { Decimal };

/**
 * The scope dimensions a policy may vary by, ordered from least to most specific.
 *
 * Taken from v3 §24, which lists what commission rules may vary by: seller, seller tier, category,
 * geography, and so on. They are a **hierarchy** rather than a set of independent switches,
 * because precedence has to be decidable: given two matching rules, the more specific wins, and
 * "more specific" has to mean something exact.
 */
export const SCOPE_DIMENSIONS = ['country', 'category', 'sellerTier', 'seller'] as const;
export type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

/**
 * A scope selector: which dimensions a rule binds, and to what.
 *
 * An absent dimension means "any". `{}` is the global rule — the least specific thing that can
 * match, and the one a policy falls back to only if it declares it.
 */
export type ScopeSelector = Partial<Readonly<Record<ScopeDimension, string>>>;

/** The facts an evaluation is about. Every value is an opaque handle; none is personal data. */
export type PolicyFacts = Partial<Readonly<Record<ScopeDimension, string>>>;

/**
 * How specific a selector is: the number of dimensions it binds.
 *
 * Precedence is by this rank, and **a tie between two matching rules is an error**, not a
 * coin toss. Two rules of equal specificity that both match describe a situation the author did
 * not decide, and guessing which one applies would produce a commission that depends on row
 * order. See `ambiguous-precedence`.
 */
export function specificity(selector: ScopeSelector): number {
  return SCOPE_DIMENSIONS.filter((dimension) => selector[dimension] !== undefined).length;
}

/** The value kinds a policy output may declare. Deliberately small, and all exact. */
export const OUTPUT_KINDS = [
  /** An exact decimal: a rate, a percentage, a threshold amount. Never a float. */
  'decimal',
  /** A whole number of seconds: a hold period, a refund window, an inspection period. */
  'duration-seconds',
  'boolean',
  /** One of a closed list declared by the output. */
  'enum',
  /**
   * The current value of a **K-05 Configuration** key, resolved at evaluation time.
   *
   * This is the one place K-06 reads configuration, and it exists because v3 §35's list spans both
   * systems: some of what it names is a single value (K-05) and some is a rule set (K-06), and a
   * policy that could not reference the first would force operators to duplicate it. The
   * configuration version id resolved is **pinned into the decision alongside the policy version
   * id**, so the answer stays reproducible; if K-05 cannot resolve it, the evaluation is refused
   * rather than defaulted.
   */
  'configured',
] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export type OutputSchema =
  | { readonly kind: 'decimal'; readonly scale: number; readonly minimum: Decimal; readonly maximum: Decimal }
  | { readonly kind: 'duration-seconds'; readonly minimum: number; readonly maximum: number }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'configured'; readonly key: string };

export type OutputValue =
  | { readonly kind: 'decimal'; readonly value: Decimal }
  | { readonly kind: 'duration-seconds'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'configured'; readonly key: string };

/**
 * The predicate kinds a rule condition may use.
 *
 * All total, all deterministic, all decidable from the facts alone. There is no arithmetic, no
 * regular expression, no function, no string interpolation and **no way to express executable
 * code** — a policy is data an operator can read, and a policy language that could compute would
 * be a second runtime with no tests and no review.
 */
export const PREDICATE_KINDS = [
  'fact-equals',
  'fact-in',
  /** Inclusive lower bound on a decimal fact, for v3 §24's "transaction amount" dimension. */
  'amount-at-least',
  'amount-below',
  'all',
  'any',
] as const;
export type PredicateKind = (typeof PREDICATE_KINDS)[number];

export type Predicate =
  | { readonly kind: 'fact-equals'; readonly fact: string; readonly value: string }
  | { readonly kind: 'fact-in'; readonly fact: string; readonly values: readonly string[] }
  | { readonly kind: 'amount-at-least'; readonly amount: Decimal }
  | { readonly kind: 'amount-below'; readonly amount: Decimal }
  | { readonly kind: 'all'; readonly of: readonly Predicate[] }
  | { readonly kind: 'any'; readonly of: readonly Predicate[] };

/** One rule: when this matches, policy says that. */
export interface PolicyRule {
  readonly ruleId: string;
  readonly selector: ScopeSelector;
  /** An optional further condition, evaluated after the selector matches. */
  readonly condition: Predicate | null;
  readonly outputs: Readonly<Record<string, OutputValue>>;
}

/** Who authored something. There is no `ai` kind, deliberately — see `registry.ts`. */
export type OriginKind = 'human' | 'system';

export interface Origin {
  readonly kind: OriginKind;
  readonly id: string;
}

/**
 * A candidate policy, not yet published.
 *
 * Drafts are **immutable and append-only** like everything else here: revising one means writing
 * another, not editing the first. A draft has no version number and can never be evaluated — v3
 * §35 wants historic decisions explicable, and a decision taken against something an author was
 * still editing is not.
 */
export interface PolicyDraft {
  readonly draftId: string;
  readonly policyKey: string;
  readonly outputSchema: Readonly<Record<string, OutputSchema>>;
  readonly rules: readonly PolicyRule[];
  /** Applied when no rule matches. Absent means "no match is an error" — see §5 of the contract. */
  readonly defaultOutputs: Readonly<Record<string, OutputValue>> | null;
  readonly notes: string;
  readonly draftedAt: string;
  readonly draftedBy: Origin;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

/**
 * One immutable, numbered version of a policy.
 *
 * Numbered per policy key. Never edited: v3 §24's "changing future policy must not rewrite
 * historical economics" is this sentence expressed as a table with no `UPDATE` path.
 */
export interface PolicyVersion {
  readonly policyVersionId: string;
  readonly policyKey: string;
  readonly version: number;
  /** The draft this was published from, so authorship is traceable to the thing reviewed. */
  readonly draftId: string;
  readonly outputSchema: Readonly<Record<string, OutputSchema>>;
  readonly rules: readonly PolicyRule[];
  readonly defaultOutputs: Readonly<Record<string, OutputValue>> | null;
  /** Bounded effective window, both ends optional, both inclusive of the instant they name. */
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly publishedAt: string;
  readonly publishedBy: Origin;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

/**
 * An appended record that a version became the one in force.
 *
 * Guarded: an activation names the version it supersedes, so two operators changing policy at once
 * cannot both win and leave a history in which two versions were simultaneously authoritative.
 */
export interface PolicyActivation {
  readonly activationId: string;
  readonly policyKey: string;
  readonly policyVersionId: string;
  readonly supersedesVersionId: string | null;
  readonly activatedAt: string;
  readonly activatedBy: Origin;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

/**
 * The end of a policy key's life. Appended, terminal, one per key.
 *
 * Retiring a policy does not erase the versions decisions were pinned to — it stops new
 * evaluations. A retired policy that still had to answer would be a policy nobody could ever
 * withdraw; one whose history vanished would make every pinned decision unexplainable.
 */
export interface PolicyRetirement {
  readonly retirementId: string;
  readonly policyKey: string;
  readonly reason: string;
  readonly retiredAt: string;
  readonly retiredBy: Origin;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

/** Why an evaluation produced what it did. Every reason is reachable. */
export const DECISION_REASONS = [
  'rule-matched',
  /** No rule matched and the version declares defaults, which the author chose explicitly. */
  'default-applied',
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

/**
 * What a policy said, and everything needed to say it again.
 *
 * `policyVersionId` and `version` are what a downstream record pins (v3 §24, §35, §50). The
 * `explanation` is deterministic text naming the version, the rule and the reason — and never a
 * fact value, because an explanation is the thing most likely to be logged.
 */
export interface PolicyDecision {
  readonly policyKey: string;
  readonly policyVersionId: string;
  readonly version: number;
  readonly outputs: Readonly<Record<string, ResolvedOutput>>;
  readonly reason: DecisionReason;
  /** The rule that decided it, or null when the declared defaults applied. */
  readonly ruleId: string | null;
  readonly explanation: string;
  readonly evaluatedAt: string;
  /**
   * K-05 versions this decision depends on, by configuration key.
   *
   * Empty unless an output was `configured`. Pinned for the same reason the policy version is: an
   * answer that quietly followed a configuration change would make a historic decision
   * irreproducible, which is the failure v3 §35 exists to prevent.
   */
  readonly configurationVersions: Readonly<Record<string, string>>;
}

/** An output with its value resolved — `configured` outputs carry what K-05 returned. */
export type ResolvedOutput =
  | { readonly kind: 'decimal'; readonly value: Decimal }
  | { readonly kind: 'duration-seconds'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'enum'; readonly value: string }
  | {
      readonly kind: 'configured';
      readonly key: string;
      readonly value: boolean | number | string;
      readonly configurationVersionId: string;
    };

export type PolicyErrorCode =
  /** The value is not a well-formed opaque identifier. */
  | 'malformed-identifier'
  /** The value looks like a natural or personal identifier. */
  | 'natural-identifier'
  /** The value looks like a credential. */
  | 'secret-bearing-input'
  /** A request carried a field by which the caller would decide the answer or name the version. */
  | 'caller-asserted-outcome'
  /** No policy by that key has a version in force. */
  | 'no-such-policy'
  /** The named draft or version does not exist, or belongs to a different policy key. */
  | 'no-such-version'
  /** A fact a matching rule needs was not supplied. Fail closed; never assume. */
  | 'missing-fact'
  /** Two rules of equal specificity both matched, so the author did not decide this case. */
  | 'ambiguous-precedence'
  /** No rule matched and the version declares no defaults. */
  | 'no-matching-rule'
  /** A predicate kind, output kind, scope dimension or fact this component does not support. */
  | 'unsupported-predicate'
  | 'unsupported-output'
  | 'unsupported-scope'
  /** A decimal that is malformed, out of range, or carrying more digits than permitted. */
  | 'malformed-decimal'
  /** A `number` where an exact decimal belongs. */
  | 'lossy-numeric-value'
  /** A rule tree deeper or wider than the bound, which is an evaluation nobody can review. */
  | 'unbounded-structure'
  /** `effectiveUntil` is not after `effectiveFrom`, or a bound is not a finite instant. */
  | 'invalid-effective-window'
  /** The version is not in force at the instant asked about. */
  | 'version-not-effective'
  | 'duplicate-draft'
  | 'duplicate-policy-version'
  | 'duplicate-activation'
  | 'duplicate-retirement'
  /** An idempotency key was reused with any authority-bearing input changed. */
  | 'idempotency-key-reuse'
  /** An activation lost a race: the version it claimed to supersede is no longer in force. */
  | 'stale-activation'
  /** Nobody is permitted to author policy: no authoring authority was injected. */
  | 'authoring-refused'
  /** A mutation was attempted on a policy that has been retired. */
  | 'policy-retired'
  /** An enlisted path tried to control a transaction it does not own. */
  | 'nested-transaction'
  /** A write tried to rewrite policy history. */
  | 'immutable-history'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record';

export class PolicyError extends Error {
  readonly code: PolicyErrorCode;

  constructor(code: PolicyErrorCode, message: string) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}
