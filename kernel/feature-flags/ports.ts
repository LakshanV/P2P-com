/**
 * K-07 Feature Flags — the injected ports (FND-004e).
 *
 * Three things this component refuses to determine for itself, each behind an interface it does
 * not import an implementation of. Every default fails closed, so a service constructed without
 * thinking about one of them is a service that refuses rather than one that quietly guesses.
 *
 * Owned by: K-07 Feature Flags.
 */

import type { DeploymentStage } from './decide.ts';
import type { Scope } from './types.ts';

/** Time. Supplied so every behaviour in this component is reproducible in a test. */
export interface Clock {
  now(): string;
}

/**
 * K-05 Configuration, through its public contract and nothing else.
 *
 * This is the one place the guide requires configuration input: v3 §36's "internal only" stage is
 * a statement about *the deployment*, not about the flag, and a flag definition that hardcoded
 * which deployment is internal would have to be republished to move between environments.
 *
 * The shape is deliberately the shape of `ConfigurationService.resolve` — one method, taking a key
 * and a scope, returning a value — so K-05 satisfies it **structurally**, with no import of K-05
 * anywhere in this component and no coupling to its record types. If K-05's resolution model
 * changes, this port is what has to be re-satisfied, and the compiler says so.
 */
export interface ConfigurationLookup {
  resolve(request: {
    readonly key: string;
    readonly scope: Scope;
  }): Promise<{ readonly value: unknown } | null>;
}

/** The registered key this component reads, and the only one it ever asks for. */
export const DEPLOYMENT_STAGE_KEY = 'platform.deployment.stage';

/**
 * A configuration port that resolves nothing.
 *
 * The default, and it fails closed in the direction that matters: with no stage resolvable, an
 * `internal-only` flag is **off**, so an internal pilot cannot leak into production merely because
 * nobody wired configuration up.
 */
export const NO_CONFIGURATION: ConfigurationLookup = Object.freeze({
  resolve(): Promise<null> {
    return Promise.resolve(null);
  },
});

/**
 * Who is permitted to change flags, and under what identity.
 *
 * K-04 shipped `publishPolicy`, `grant` and `revoke` taking their author as a **request field**,
 * so any caller could sign a change in somebody else's name (CURRENT_IMPLEMENTATION_STATUS
 * §11.28). This component does not repeat that: no mutation request carries an author, and the
 * identity written into every row comes from this injected port.
 *
 * It is deliberately *not* K-02 plus K-04. Wiring authentication and an explicit administration
 * grant is the right end state and is recorded as deferred in CONTRACT.md §9; what this port does
 * is make the deferral honest — the author is injected rather than asserted, and the default
 * refuses, so nothing here can be changed by a caller who simply reached the service.
 */
export interface FlagAdministrator {
  /** The opaque handle written as the author of everything this authority does. */
  readonly authorityId: string;
  permitsAdministration(): boolean;
}

/** The default: nobody administers flags. */
export const NO_ADMINISTRATION: FlagAdministrator = Object.freeze({
  authorityId: 'k07-no-administration-authority',
  permitsAdministration(): boolean {
    return false;
  },
});

/** Recognise a resolved configuration value as a deployment stage, or refuse to guess. */
export function asDeploymentStage(value: unknown): DeploymentStage | null {
  return value === 'internal' || value === 'production' ? value : null;
}
