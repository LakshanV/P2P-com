/**
 * K-11 Commerce Unit Registry — the injected ports (FND-005c).
 *
 * Four things this component refuses to determine for itself, each behind an interface it does not
 * import an implementation of. Every default fails closed, so a service constructed without
 * thinking about one of them refuses rather than quietly guessing.
 *
 * Owned by: K-11 Commerce Unit Registry.
 */

import { CommerceUnitError, type UnitKind } from './types.ts';

/** Time. Supplied so every behaviour in this component is reproducible in a test. */
export interface Clock {
  now(): string;
}

/**
 * K-05 Configuration, through its public contract and nothing else.
 *
 * The one place K-11 reads configuration, and it exists because v3 §11 ends its list of kinds with
 * "other future permitted category". *Which* kinds a deployment actually permits is a deployment
 * decision, not a code decision — a marketplace that does not do accommodation should not be able
 * to have an accommodation type published into its registry by accident, and hardcoding the answer
 * would be the "commerce assumptions around one category" v3 §12 forbids.
 *
 * The shape is deliberately the shape of `ConfigurationService.resolve`, so K-05 satisfies it
 * **structurally** — no import of K-05 anywhere in this component. A key K-05 cannot resolve
 * refuses the publication: a vocabulary entry nobody permitted is worse than a refusal, because
 * every listing created under it inherits the mistake.
 */
export interface ConfigurationLookup {
  resolve(request: {
    readonly key: string;
    readonly scope: { readonly level: string; readonly id: string };
    readonly at: string;
  }): Promise<{ readonly value: unknown; readonly versionId: string }>;
}

/** The registered key this component reads, and the only one it ever asks for. */
export const PERMITTED_KINDS_KEY = 'commerce.unit-kinds.permitted';

/**
 * A configuration port that resolves nothing.
 *
 * The default. With no configuration wired, **no kind is permitted and nothing can be published** —
 * which is the fail-closed direction: an empty registry is recoverable, and a registry full of
 * categories nobody sanctioned is not.
 */
export const NO_CONFIGURATION: ConfigurationLookup = Object.freeze({
  resolve(request: { readonly key: string }): Promise<never> {
    return Promise.reject(
      new CommerceUnitError(
        'unsupported-kind',
        `no configuration port was injected, so "${request.key}" cannot be resolved and no kind ` +
          'is permitted. K-11 refuses rather than defaulting: a category nobody sanctioned is ' +
          'inherited by every listing created under it',
      ),
    );
  },
});

/**
 * K-06 Policy Engine, through its public contract and nothing else.
 *
 * Used for exactly one thing: **provenance**. A type may name the policy key carrying its category
 * risk pack (v3 §16), and activation records the version id K-06 has in force at that moment. K-11
 * stores the id and nothing else — it never reads a rule, never evaluates, and never decides
 * anything from what K-06 says.
 *
 * The shape is the shape of `PolicyService.evaluate`, so K-06 satisfies it structurally. What K-11
 * takes from the answer is `policyVersionId` and only that.
 */
export interface PolicyProvenance {
  evaluate(request: {
    readonly policyKey: string;
    readonly at?: string;
  }): Promise<{ readonly policyVersionId: string }>;
}

/**
 * A provenance port that resolves nothing.
 *
 * The default, and it fails closed only for types that ask for it: a type naming a risk policy
 * cannot be activated without a real K-06, while a type naming none activates normally. Pinning a
 * version that was never resolved would be worse than refusing — the id would look like evidence.
 */
export const NO_POLICY_PROVENANCE: PolicyProvenance = Object.freeze({
  evaluate(request: { readonly policyKey: string }): Promise<never> {
    return Promise.reject(
      new CommerceUnitError(
        'malformed-record',
        `no policy provenance port was injected, so the risk policy "${request.policyKey}" this ` +
          'type names cannot be pinned. A version id recorded without being resolved would look ' +
          'like evidence of a policy that was never consulted',
      ),
    );
  },
});

/**
 * Who may register commerce unit types, and under what identity.
 *
 * K-04 shipped its administration taking the author as a **request field**, so any caller could
 * sign a change in somebody else's name (CURRENT_IMPLEMENTATION_STATUS §11.28). This component
 * does not repeat that: no mutation request carries an author, and the identity written into every
 * row comes from this injected port.
 *
 * The authority also carries the **owner scope it may write for**, which is how tenant isolation
 * is enforced at the boundary rather than inside the request: a tenant's registrar cannot publish
 * a platform type, and cannot touch another tenant's, because it cannot say that it is them.
 */
export interface RegistrarAuthority {
  /** The opaque handle written as the author of everything this authority does. */
  readonly authorityId: string;
  /** The scope this authority writes for: the platform vocabulary, or one tenant's extension. */
  readonly owner: { readonly kind: 'platform' } | { readonly kind: 'tenant'; readonly tenantId: string };
  permitsRegistration(): boolean;
}

/** The default: nobody registers anything. */
export const NO_REGISTRAR: RegistrarAuthority = Object.freeze({
  authorityId: 'k11-no-registrar-authority',
  owner: Object.freeze({ kind: 'platform' as const }),
  permitsRegistration(): boolean {
    return false;
  },
});

/** Recognise a resolved configuration value as a list of permitted kinds, or refuse to guess. */
export function asPermittedKinds(value: unknown): readonly UnitKind[] | null {
  if (!Array.isArray(value)) return null;
  const kinds = value.filter((entry): entry is string => typeof entry === 'string');
  return kinds.length === value.length ? (kinds as readonly UnitKind[]) : null;
}
