/**
 * K-06 Policy Engine — the evaluation core (FND-005b).
 *
 * Pure: same version, same facts, same instant, same answer, on any machine, forever. Nothing here
 * reads a clock, opens a connection or generates randomness. That is not tidiness — it is the
 * mechanism by which v3 §35's promise is kept. "Historic transactions retain the policy version
 * originally applied" is only worth anything if re-running that version against those facts still
 * produces the same number, and the way to guarantee that is for evaluation to be a function.
 *
 * **Precedence is by specificity, and a tie is an error.** Rules bind scope dimensions; the rule
 * binding more of them wins. When two matching rules bind the same number, the author did not
 * decide that case, and this refuses with `ambiguous-precedence` rather than picking one. That
 * refusal is deliberate and it is the most important line in the file: the alternative — first
 * match wins, or last, or highest rate — makes a commission depend on the order rows came back in,
 * which is a difference nobody would ever find and which changes when a query plan changes.
 *
 * **Fail closed on every uncertainty.** A fact a matching rule needs but the request did not carry
 * is `missing-fact`, never "treat it as absent and match anyway". A version outside its effective
 * window is `version-not-effective`. No rule matching and no declared defaults is
 * `no-matching-rule`. Each of those is a refusal rather than a value, because the caller is about
 * to write whatever comes back into a financial record, and a guess there is permanent.
 *
 * **Defaults apply only where the policy declares them.** There is no built-in zero, no implicit
 * false, no empty-string fallback. A policy that has not said what happens when nothing matches
 * has not been asked yet, and this says so.
 *
 * Owned by: K-06 Policy Engine.
 */

import { compareInstants } from '../../platform/time/instant.ts';

import { assertDecimal, compareDecimals, type Decimal } from './decimal.ts';
import { AMOUNT_FACT, factsOf } from './registry.ts';
import {
  PolicyError,
  SCOPE_DIMENSIONS,
  specificity,
  type OutputValue,
  type PolicyDecision,
  type PolicyFacts,
  type PolicyRule,
  type PolicyVersion,
  type Predicate,
  type ResolvedOutput,
  type ScopeDimension,
} from './types.ts';

/** The facts an evaluation is given: scope handles plus the transaction amount. */
export interface EvaluationFacts extends PolicyFacts {
  readonly amount?: Decimal;
}

export interface EvaluationInput {
  readonly version: PolicyVersion;
  readonly facts: EvaluationFacts;
  readonly at: string;
}

/** The rule that decided, before its `configured` outputs were resolved. */
export interface Selection {
  readonly rule: PolicyRule | null;
  readonly outputs: Readonly<Record<string, OutputValue>>;
  readonly reason: PolicyDecision['reason'];
  readonly explanation: string;
}

/**
 * Does this rule's scope selector match the facts?
 *
 * `null` means *undecidable*: the selector binds a dimension the request did not supply. That is
 * distinct from `false` — the caller has not been ruled out, they have asked a question this
 * component cannot answer — and the difference decides whether the answer is a refusal or a
 * different rule.
 */
function selectorMatches(rule: PolicyRule, facts: EvaluationFacts): boolean | null {
  for (const dimension of SCOPE_DIMENSIONS) {
    const bound = rule.selector[dimension];
    if (bound === undefined) continue;
    const supplied = facts[dimension];
    if (supplied === undefined) return null;
    if (supplied !== bound) return false;
  }
  return true;
}

/**
 * Does this condition hold?
 *
 * `null` is undecidable, for the same reason and with the same consequence as above. An `all`
 * settles on any definite `false` even when a sibling is undecidable, because the condition cannot
 * hold whatever the missing fact turns out to be; an `any` settles on any definite `true`.
 */
export function conditionHolds(predicate: Predicate, facts: EvaluationFacts): boolean | null {
  switch (predicate.kind) {
    case 'fact-equals': {
      const supplied = facts[predicate.fact as ScopeDimension];
      return supplied === undefined ? null : supplied === predicate.value;
    }
    case 'fact-in': {
      const supplied = facts[predicate.fact as ScopeDimension];
      return supplied === undefined ? null : predicate.values.includes(supplied);
    }
    case 'amount-at-least': {
      const amount = facts.amount;
      return amount === undefined ? null : compareDecimals(amount, predicate.amount) >= 0;
    }
    case 'amount-below': {
      const amount = facts.amount;
      return amount === undefined ? null : compareDecimals(amount, predicate.amount) < 0;
    }
    case 'all': {
      let undecided = false;
      for (const entry of predicate.of) {
        const held = conditionHolds(entry, facts);
        if (held === false) return false;
        if (held === null) undecided = true;
      }
      return undecided ? null : true;
    }
    default: {
      let undecided = false;
      for (const entry of predicate.of) {
        const held = conditionHolds(entry, facts);
        if (held === true) return true;
        if (held === null) undecided = true;
      }
      return undecided ? null : false;
    }
  }
}

/** Every fact a rule needs but the request did not supply, by name and never by value. */
function missingFacts(rule: PolicyRule, facts: EvaluationFacts): readonly string[] {
  const needed = new Set<string>();
  for (const dimension of SCOPE_DIMENSIONS) {
    if (rule.selector[dimension] !== undefined) needed.add(dimension);
  }
  if (rule.condition !== null) for (const fact of factsOf(rule.condition)) needed.add(fact);

  return [...needed]
    .filter((fact) =>
      fact === AMOUNT_FACT
        ? facts.amount === undefined
        : facts[fact as ScopeDimension] === undefined,
    )
    .sort();
}

/**
 * Choose the rule that decides, or refuse.
 *
 * The order of the refusals matters. A rule that *would have matched* but for a fact the request
 * omitted is reported as `missing-fact`, not silently skipped in favour of a less specific rule —
 * otherwise omitting `sellerTier` would quietly buy the caller the global commission rate, which
 * is the cheapest possible way to underpay.
 */
export function select(input: EvaluationInput): Selection {
  const { version, facts } = input;

  if (version.effectiveFrom !== null && compareInstants(input.at, version.effectiveFrom) < 0) {
    throw new PolicyError(
      'version-not-effective',
      `version ${version.version} of ${version.policyKey} takes effect at ${version.effectiveFrom}, ` +
        `which is after ${input.at}`,
    );
  }
  if (version.effectiveUntil !== null && compareInstants(input.at, version.effectiveUntil) > 0) {
    throw new PolicyError(
      'version-not-effective',
      `version ${version.version} of ${version.policyKey} ceased at ${version.effectiveUntil}, ` +
        `which is before ${input.at}`,
    );
  }

  const matched: PolicyRule[] = [];
  const undecidable: PolicyRule[] = [];

  for (const rule of version.rules) {
    const scope = selectorMatches(rule, facts);
    if (scope === false) continue;

    const condition = rule.condition === null ? true : conditionHolds(rule.condition, facts);
    if (scope === null || condition === null) {
      undecidable.push(rule);
      continue;
    }
    if (condition === true) matched.push(rule);
  }

  if (undecidable.length > 0) {
    const wanted = [...new Set(undecidable.flatMap((rule) => missingFacts(rule, facts)))].sort();
    throw new PolicyError(
      'missing-fact',
      `${version.policyKey} has ${undecidable.length} rule(s) that turn on ${wanted.join(', ')}, ` +
        'which the request did not supply. Deciding without them would quietly award whatever a ' +
        'less specific rule says, and that answer would be pinned into the record as though it ' +
        'had been the right one',
    );
  }

  if (matched.length === 0) {
    if (version.defaultOutputs === null) {
      throw new PolicyError(
        'no-matching-rule',
        `no rule of version ${version.version} of ${version.policyKey} matches, and the version ` +
          'declares no defaults. A policy that has not said what happens in this case has not ' +
          'been asked yet — there is no implicit zero here',
      );
    }
    return {
      rule: null,
      outputs: version.defaultOutputs,
      reason: 'default-applied',
      explanation:
        `no rule of version ${version.version} (${version.policyVersionId}) of ` +
        `${version.policyKey} matched, so the defaults the version declares applied`,
    };
  }

  const best = Math.max(...matched.map((rule) => specificity(rule.selector)));
  const winners = matched.filter((rule) => specificity(rule.selector) === best);

  if (winners.length > 1) {
    throw new PolicyError(
      'ambiguous-precedence',
      `rules ${winners.map((rule) => `"${rule.ruleId}"`).join(' and ')} of version ` +
        `${version.version} of ${version.policyKey} all match and all bind ${best} scope ` +
        'dimension(s), so specificity cannot separate them. Picking one would make the answer ' +
        'depend on row order; the author has to decide which applies',
    );
  }

  const winner = winners[0] as PolicyRule;
  return {
    rule: winner,
    outputs: winner.outputs,
    reason: 'rule-matched',
    explanation:
      `rule "${winner.ruleId}" of version ${version.version} (${version.policyVersionId}) of ` +
      `${version.policyKey} matched, binding ${best} scope dimension(s), and was the most ` +
      `specific of ${matched.length} matching rule(s)`,
  };
}

/** Validate the facts a caller supplied, refusing anything not exactly what a fact may be. */
export function assertFacts(value: unknown, field = 'facts'): EvaluationFacts {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError(
      'malformed-record',
      `${field} is ${value === null ? 'null' : typeof value}; expected an object of facts`,
    );
  }
  const supplied = value as Record<string, unknown>;
  const facts: Record<string, unknown> = {};

  for (const [name, fact] of Object.entries(supplied)) {
    if (name === AMOUNT_FACT) {
      if (typeof fact === 'number') {
        throw new PolicyError(
          'lossy-numeric-value',
          `${field}.amount is the number ${String(fact)}. A transaction amount is an exact ` +
            'decimal: a double cannot hold most of them, and a threshold comparison against an ' +
            'inexact amount decides a commission band incorrectly at exactly the boundary',
        );
      }
      facts.amount = assertDecimal(fact, `${field}.amount`);
      continue;
    }
    if (!(SCOPE_DIMENSIONS as readonly string[]).includes(name)) {
      throw new PolicyError(
        'unsupported-scope',
        `${field} carries "${name}", which is not a fact this component recognises. Recognised: ` +
          `${[...SCOPE_DIMENSIONS, AMOUNT_FACT].join(', ')}`,
      );
    }
    facts[name] = fact;
  }
  return Object.freeze(facts);
}

/** An output that needs nothing resolved, as it will appear in the decision. */
export function staticOutput(output: OutputValue): ResolvedOutput | null {
  return output.kind === 'configured' ? null : (output);
}
