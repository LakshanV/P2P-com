/**
 * K-07 Feature Flags — the evaluation core (FND-004e).
 *
 * Pure: same inputs, same answer, on any machine, forever. Nothing here reads a clock, opens a
 * connection, or generates randomness — `now` and the deployment stage arrive as arguments, and
 * the rollout bucket is a hash. That is what makes an incident reproducible: an operator who can
 * say what the active version was and what the request carried can replay the exact evaluation.
 *
 * **Fail closed, always.** Every uncertainty resolves to *disabled*: an unknown flag, a retired
 * one, a scope the version was not published for, a rule naming an attribute the request did not
 * supply, a percentage rollout with no subject key, a deployment stage that could not be resolved.
 * A feature flag exists to stop code running; a flag system that guessed "probably on" when it did
 * not know would be a system that fails towards the risky answer, which is the wrong direction for
 * the exact functions v3 §36 says need one — autonomous purchasing, AI negotiation, referral
 * payouts.
 *
 * **The precedence order is fixed and total**, and the order itself is load-bearing:
 *
 *   1. **kill** — an emergency stop outranks every definition, including `on`. It is checked first
 *      so that stopping a feature in an incident never depends on what any version says.
 *   2. **retire** — the orderly end of a flag's life.
 *   3. **no active version** — nothing was ever activated, so there is nothing to run.
 *   4. **scope** — the request named a level this version was not published for.
 *   5. **window** — now is outside the bounded activation window.
 *   6. **state** — and only now does the definition get a say.
 *
 * Nothing later can re-enable something an earlier rule turned off. There is no "override", no
 * "force on" and no escape hatch, because the point of a kill switch is that it cannot be argued
 * with by a definition somebody publishes afterwards.
 *
 * Owned by: K-07 Feature Flags.
 */

import { compareInstants } from '../../platform/time/instant.ts';

import { attributesOf } from './registry.ts';
import { bucketOf, inRollout } from './rollout.ts';
import {
  scopeKey,
  type Evaluation,
  type FlagVersion,
  type LifecycleEvent,
  type Predicate,
  type Scope,
} from './types.ts';

/** The deployment stages `internal-only` distinguishes. Resolved through K-05, never asserted. */
export const DEPLOYMENT_STAGES = ['internal', 'production'] as const;
export type DeploymentStage = (typeof DEPLOYMENT_STAGES)[number];

export interface EvaluationInput {
  readonly flagKey: string;
  /** The active version, or null when this flag has never been activated. */
  readonly version: FlagVersion | null;
  /** Kill and retire events for this flag key, in any order. */
  readonly lifecycle: readonly LifecycleEvent[];
  readonly scope: Scope;
  /** The opaque, non-PII key a percentage rollout buckets on. */
  readonly subjectKey: string | null;
  readonly attributes: Readonly<Record<string, string>>;
  readonly now: string;
  /** What K-05 says this deployment is, or null when it could not be resolved. */
  readonly deploymentStage: DeploymentStage | null;
}

function answer(
  input: EvaluationInput,
  enabled: boolean,
  reason: Evaluation['reason'],
  explanation: string,
  bucket: number | null = null,
): Evaluation {
  return Object.freeze({
    flagKey: input.flagKey,
    enabled,
    reason,
    explanation,
    flagVersionId: input.version?.flagVersionId ?? null,
    version: input.version?.version ?? null,
    scope: Object.freeze({ ...input.scope }),
    bucket,
  });
}

/** Which version this answer came from, for every explanation that has one. */
const from = (version: FlagVersion): string =>
  `version ${version.version} (${version.flagVersionId})`;

/**
 * Does this rule tree match the supplied attributes?
 *
 * `null` means *undecidable*: a rule named an attribute the request did not carry. That is
 * distinct from `false` — a caller who forgot to pass `country` has not been excluded from the
 * rollout, they have asked a question this component cannot answer — and the caller is told which
 * attribute was missing, by name and never by value.
 */
export function matches(
  predicate: Predicate,
  attributes: Readonly<Record<string, string>>,
): boolean | null {
  switch (predicate.kind) {
    case 'attribute-equals': {
      const supplied = attributes[predicate.attribute];
      return supplied === undefined ? null : supplied === predicate.value;
    }
    case 'attribute-in': {
      const supplied = attributes[predicate.attribute];
      return supplied === undefined ? null : predicate.values.includes(supplied);
    }
    case 'all': {
      let undecided = false;
      for (const entry of predicate.of) {
        const result = matches(entry, attributes);
        // A definite `false` settles an `all` even when a sibling is undecidable: the rule cannot
        // match whatever the missing attribute turns out to be.
        if (result === false) return false;
        if (result === null) undecided = true;
      }
      return undecided ? null : true;
    }
    default: {
      let undecided = false;
      for (const entry of predicate.of) {
        const result = matches(entry, attributes);
        if (result === true) return true;
        if (result === null) undecided = true;
      }
      return undecided ? null : false;
    }
  }
}

/** The deterministic answer. Nothing in here can throw: an evaluation always produces one. */
export function evaluate(input: EvaluationInput): Evaluation {
  const killed = input.lifecycle.find((event) => event.kind === 'kill');
  if (killed !== undefined) {
    return answer(
      input,
      false,
      'kill-switch',
      `the emergency kill switch for ${input.flagKey} is in force, recorded at ` +
        `${killed.recordedAt}; it outranks every published version`,
    );
  }

  const retired = input.lifecycle.find((event) => event.kind === 'retire');
  if (retired !== undefined) {
    return answer(
      input,
      false,
      'flag-retired',
      `${input.flagKey} was retired at ${retired.recordedAt} and evaluates to off for good`,
    );
  }

  const version = input.version;
  if (version === null) {
    return answer(
      input,
      false,
      'no-such-flag',
      `no version of ${input.flagKey} has been activated, so there is nothing to run. An unknown ` +
        'flag is off — a typo must never enable a code path',
    );
  }

  if (!version.supportedScopes.includes(input.scope.level)) {
    return answer(
      input,
      false,
      'unsupported-scope',
      `${from(version)} of ${input.flagKey} is published for ${version.supportedScopes.join(
        ', ',
      )} and was evaluated at ${scopeKey(input.scope)}. Evaluating at a level it was not written ` +
        'for would apply it more widely than anybody chose',
    );
  }

  if (version.notBefore !== null && compareInstants(input.now, version.notBefore) < 0) {
    return answer(
      input,
      false,
      'outside-activation-window',
      `${from(version)} of ${input.flagKey} starts at ${version.notBefore}, which is after now`,
    );
  }
  if (version.notAfter !== null && compareInstants(input.now, version.notAfter) > 0) {
    return answer(
      input,
      false,
      'outside-activation-window',
      `${from(version)} of ${input.flagKey} ended at ${version.notAfter}`,
    );
  }

  switch (version.state) {
    case 'off':
      return answer(
        input,
        false,
        'flag-off',
        `${from(version)} of ${input.flagKey} is published off`,
      );

    case 'on':
      return answer(
        input,
        true,
        'full-rollout',
        `${from(version)} of ${input.flagKey} is published on for every supported scope`,
      );

    case 'internal-only': {
      if (input.deploymentStage === null) {
        return answer(
          input,
          false,
          'deployment-stage-unknown',
          `${from(version)} of ${input.flagKey} is internal-only and the deployment stage could ` +
            'not be resolved through K-05, so this deployment is treated as not internal',
        );
      }
      const internal = input.deploymentStage === 'internal';
      return answer(
        input,
        internal,
        internal ? 'internal-only' : 'not-internal-deployment',
        `${from(version)} of ${input.flagKey} is internal-only and this deployment is ` +
          `${input.deploymentStage}`,
      );
    }

    case 'targeted': {
      const undecidable = version.rules
        .flatMap(attributesOf)
        .filter((attribute) => input.attributes[attribute] === undefined);
      if (undecidable.length > 0) {
        return answer(
          input,
          false,
          'missing-context',
          `${from(version)} of ${input.flagKey} targets on ${[...new Set(undecidable)]
            .sort()
            .join(', ')}, which the request did not supply. A rollout cannot be decided from ` +
            'context that is not there',
        );
      }
      const matched = version.rules.some((rule) => matches(rule, input.attributes) === true);
      return answer(
        input,
        matched,
        matched ? 'targeting-matched' : 'targeting-unmatched',
        `${from(version)} of ${input.flagKey} has ${version.rules.length} targeting rule(s) and ` +
          `the request ${matched ? 'matched one' : 'matched none'}`,
      );
    }

    default: {
      if (input.subjectKey === null) {
        return answer(
          input,
          false,
          'missing-subject-key',
          `${from(version)} of ${input.flagKey} is a ${version.percentage}% rollout and the ` +
            'request carried no subject key to bucket. Without one the answer would have to be ' +
            'random, and a rollout that moves between requests is not a rollout',
        );
      }
      const bucket = bucketOf(version.flagKey, version.rolloutSalt, input.subjectKey);
      const included = inRollout(bucket, version.percentage);
      return answer(
        input,
        included,
        included ? 'percentage-included' : 'percentage-excluded',
        `${from(version)} of ${input.flagKey} is a ${version.percentage}% rollout; this subject ` +
          `is in bucket ${bucket} of 10000`,
        bucket,
      );
    }
  }
}
