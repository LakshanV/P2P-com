/**
 * K-06 Policy Engine — the injected ports (FND-005b).
 *
 * Three things this component refuses to determine for itself, each behind an interface it does
 * not import an implementation of. Every default fails closed, so a service constructed without
 * thinking about one of them refuses rather than quietly guessing.
 *
 * Owned by: K-06 Policy Engine.
 */

import { PolicyError } from './types.ts';

/** Time. Supplied so every behaviour in this component is reproducible in a test. */
export interface Clock {
  now(): string;
}

/**
 * K-05 Configuration, through its public contract and nothing else.
 *
 * This is the only place K-06 reads configuration, and the design of it is the answer to a real
 * question: v3 §35's list of "frequently changing business policy" spans two systems. *Payout
 * delay* is a rule set that varies by category and milestone — K-06. *AI confidence threshold* is
 * one number — K-05. A policy that could not reference the second would force operators to keep
 * two copies of it and hope they stay in step.
 *
 * So a policy output may be declared `configured`, and evaluation resolves it here. Two properties
 * keep that from undermining reproducibility:
 *
 *   - the **configuration version id is pinned into the decision**, next to the policy version id,
 *     so a historic answer stays explicable even after the value changes;
 *   - a key K-05 cannot resolve **refuses the evaluation**. There is no default and no cached last
 *     value: an unresolvable input to a financial decision is a decision that should not be made.
 *
 * The shape is deliberately the shape of `ConfigurationService.resolve`, so K-05 satisfies it
 * **structurally** — no import of K-05 anywhere in this component, and no coupling to its record
 * types. If K-05's resolution model changes, this port is what has to be re-satisfied, and the
 * compiler says so.
 */
export interface ConfigurationLookup {
  resolve(request: {
    readonly key: string;
    readonly scope: { readonly level: string; readonly id: string };
    readonly at: string;
  }): Promise<{ readonly value: unknown; readonly versionId: string }>;
}

/**
 * A configuration port that resolves nothing.
 *
 * The default. A policy declaring a `configured` output cannot be evaluated at all until a real
 * K-05 is injected — which is the fail-closed direction: better a refusal than a commission
 * computed from a value nobody supplied.
 */
export const NO_CONFIGURATION: ConfigurationLookup = Object.freeze({
  resolve(request: { readonly key: string }): Promise<never> {
    return Promise.reject(
      new PolicyError(
        'malformed-record',
        `no configuration port was injected, so the policy output reading "${request.key}" cannot ` +
          'be resolved. K-06 refuses rather than defaulting: an unresolvable input to a financial ' +
          'decision is a decision that should not be made',
      ),
    );
  },
});

/**
 * Who may author policy, and under what identity.
 *
 * K-04 shipped its administration taking the author as a **request field**, so any caller could
 * sign a change in somebody else's name (CURRENT_IMPLEMENTATION_STATUS §11.28). This component
 * does not repeat that: no mutation request carries an author, and the identity written into every
 * row comes from this injected port.
 *
 * It is deliberately *not* K-02 plus K-04. Wiring authentication and an explicit administration
 * grant is the right end state and is recorded as deferred in CONTRACT.md §9; what this port does
 * is make the deferral honest — the author is injected rather than asserted, and the default
 * refuses, so nothing here can be changed by a caller who merely reached the service.
 */
export interface PolicyAuthority {
  /** The opaque handle written as the author of everything this authority does. */
  readonly authorityId: string;
  permitsAuthoring(): boolean;
}

/** The default: nobody authors policy. */
export const NO_AUTHORITY: PolicyAuthority = Object.freeze({
  authorityId: 'k06-no-authoring-authority',
  permitsAuthoring(): boolean {
    return false;
  },
});
