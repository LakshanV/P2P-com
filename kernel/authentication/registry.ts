/**
 * K-02 Authentication — providers, the MFA policy, and the fields a request may not carry
 * (FND-004c).
 *
 * **Identifier rules are K-01's**, re-raised in this component's vocabulary, exactly as K-03 does
 * them. A binding reference is written into every session and every piece of evidence that follows
 * from it, so the rule about what an identifier may be is the same rule — and a fifth copy would be
 * a fifth thing to keep in step.
 *
 * **The MFA policy can be raised per provider and never lowered.** A registry entry that could
 * weaken the platform floor would make the floor advisory, and the first provider integration under
 * deadline pressure is exactly where it would be weakened. `requireProvider` refuses such an entry
 * at construction rather than at authentication time.
 *
 * **The forbidden-field table is what makes "the caller does not decide" executable.** It is in two
 * halves, and the first is the important one: fields by which a caller would assert an
 * authentication outcome. A request carrying `authenticated`, `factors` or `assurance` is not
 * making a typo — it is trying to be the verifier, and accepting it would make every other guarantee
 * in this component decorative.
 *
 * Owned by: K-02 Authentication.
 */

import { IdentityError, assertOpaqueIdentifier } from '../identity/index.ts';

import {
  ASSURANCE_LEVELS,
  ASSURANCE_RANK,
  AuthenticationError,
  FACTOR_CATEGORIES,
  type AssuranceLevel,
  type AuthenticationErrorCode,
  type FactorCategory,
} from './types.ts';

/** K-01's identifier refusals, in this component's vocabulary. The mapping is total and tested. */
export const IDENTITY_REFUSALS: Readonly<Record<string, AuthenticationErrorCode>> = Object.freeze({
  'malformed-identifier': 'malformed-identifier',
  'natural-identifier': 'natural-identifier',
  'secret-bearing-input': 'secret-bearing-input',
});

/**
 * Refuse an identifier that is malformed, natural, or a credential.
 *
 * An `IdentityError` this cannot translate is rethrown unchanged rather than mislabelled — an error
 * that lies about its own cause is worse than one naming an unexpected component.
 */
export function assertAuthIdentifier(value: unknown, field: string): string {
  try {
    return assertOpaqueIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    const code = IDENTITY_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new AuthenticationError(code, error.message);
  }
}

/** How strong an authentication has to be before this component will issue a session for it. */
export interface MfaPolicy {
  /** Distinct factor *categories* the verifier must have checked. Two passwords are still one. */
  readonly minimumFactorCategories: number;
  readonly minimumAssurance: AssuranceLevel;
}

/**
 * The platform floor.
 *
 * One category and `single-factor`, which is deliberately weak: this slice ships no provider, so a
 * floor tuned for a provider that does not exist would be a guess. What matters is that the floor
 * is *configurable*, is enforced, and can only be raised.
 */
export const DEFAULT_MFA_POLICY: MfaPolicy = Object.freeze({
  minimumFactorCategories: 1,
  minimumAssurance: 'single-factor',
});

export interface ProviderDefinition {
  readonly provider: string;
  readonly description: string;
  /** Raises the platform floor for this provider. May never lower it. */
  readonly policy?: MfaPolicy;
}

const PROVIDER_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * The registered providers, and the policy each authenticates under.
 *
 * **No provider is registered by default.** A caller wires the ones it has verifiers for, and an
 * unregistered provider is refused — so the absence of a provider adapter cannot be mistaken for
 * permission to skip verification.
 */
export class ProviderRegistry {
  readonly #providers: Map<string, { definition: ProviderDefinition; policy: MfaPolicy }>;
  readonly #floor: MfaPolicy;

  constructor(
    definitions: readonly ProviderDefinition[] = [],
    floor: MfaPolicy = DEFAULT_MFA_POLICY,
  ) {
    assertPolicy(floor, 'the platform floor');
    this.#floor = Object.freeze({ ...floor });
    this.#providers = new Map();

    for (const definition of definitions) {
      if (!PROVIDER_NAME.test(definition.provider)) {
        throw new AuthenticationError(
          'unknown-provider',
          `"${definition.provider}" is not a valid provider name. Expected lower-case dashed, ` +
            'such as `passkey` or `totp-app`',
        );
      }
      if (this.#providers.has(definition.provider)) {
        throw new AuthenticationError(
          'unknown-provider',
          `provider "${definition.provider}" is registered twice; the second registration would ` +
            'silently decide which policy applies',
        );
      }
      if (definition.description.trim().length < 15) {
        throw new AuthenticationError(
          'unknown-provider',
          `provider "${definition.provider}" needs a description saying what it verifies`,
        );
      }

      const policy = definition.policy ?? this.#floor;
      assertPolicy(policy, `provider "${definition.provider}"`);
      assertNotWeaker(policy, this.#floor, definition.provider);
      this.#providers.set(definition.provider, {
        definition: Object.freeze({ ...definition }),
        policy: Object.freeze({ ...policy }),
      });
    }
  }

  get floor(): MfaPolicy {
    return this.#floor;
  }

  has(provider: unknown): boolean {
    return typeof provider === 'string' && this.#providers.has(provider);
  }

  /** The policy this provider authenticates under, or a refusal naming what is registered. */
  requireProvider(provider: unknown): { definition: ProviderDefinition; policy: MfaPolicy } {
    const found = typeof provider === 'string' ? this.#providers.get(provider) : undefined;
    if (found === undefined) {
      const known = [...this.#providers.keys()];
      throw new AuthenticationError(
        'unknown-provider',
        `"${String(provider)}" is not a registered authentication provider. ` +
          (known.length === 0
            ? 'None is registered, so nothing can authenticate — which is the honest state of a ' +
              'platform with no verifier wired, not a reason to skip verification'
            : `Registered: ${known.join(', ')}`),
      );
    }
    return found;
  }

  providers(): readonly string[] {
    return Object.freeze([...this.#providers.keys()]);
  }
}

function assertPolicy(policy: MfaPolicy, what: string): void {
  if (
    !Number.isSafeInteger(policy.minimumFactorCategories) ||
    policy.minimumFactorCategories < 1 ||
    policy.minimumFactorCategories > FACTOR_CATEGORIES.length
  ) {
    throw new AuthenticationError(
      'insufficient-factors',
      `${what} requires ${String(policy.minimumFactorCategories)} factor categories; expected a ` +
        `whole number between 1 and ${FACTOR_CATEGORIES.length}. Zero would mean no ` +
        'authentication at all, which is not a policy',
    );
  }
  if (!(ASSURANCE_LEVELS as readonly string[]).includes(policy.minimumAssurance)) {
    throw new AuthenticationError(
      'insufficient-factors',
      `${what} requires assurance "${policy.minimumAssurance}"; expected one of ` +
        ASSURANCE_LEVELS.join(', '),
    );
  }
}

function assertNotWeaker(policy: MfaPolicy, floor: MfaPolicy, provider: string): void {
  if (
    policy.minimumFactorCategories < floor.minimumFactorCategories ||
    ASSURANCE_RANK[policy.minimumAssurance] < ASSURANCE_RANK[floor.minimumAssurance]
  ) {
    throw new AuthenticationError(
      'insufficient-factors',
      `provider "${provider}" declares a policy weaker than the platform floor ` +
        `(${policy.minimumFactorCategories} categories / ${policy.minimumAssurance} against ` +
        `${floor.minimumFactorCategories} / ${floor.minimumAssurance}). A registry entry that ` +
        'could lower the floor would make the floor advisory, and the first integration under ' +
        'deadline pressure is where it would be lowered. Raise it here or raise the floor',
    );
  }
}

/** Does this set of confirmed factors satisfy the policy? Categories are counted, not factors. */
export function satisfiesPolicy(
  factors: readonly FactorCategory[],
  assurance: AssuranceLevel,
  policy: MfaPolicy,
): boolean {
  return (
    new Set(factors).size >= policy.minimumFactorCategories &&
    ASSURANCE_RANK[assurance] >= ASSURANCE_RANK[policy.minimumAssurance]
  );
}

/**
 * Fields by which a caller would assert an authentication outcome.
 *
 * The half of the table that matters. Each is something only the verifier may decide, and a request
 * carrying one is trying to skip the verifier entirely.
 */
export const ASSERTED_AUTHENTICATION_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  authenticated: 'whether authentication succeeded is the verifier’s answer, not the caller’s',
  isAuthenticated: 'whether authentication succeeded is the verifier’s answer, not the caller’s',
  verified: 'the verifier decides what was verified; a caller saying so proves nothing',
  factors: 'which factor categories were checked is what the verifier reports back',
  factorCategories: 'which factor categories were checked is what the verifier reports back',
  assurance: 'assurance is derived from what the verifier confirmed, never supplied',
  assuranceLevel: 'assurance is derived from what the verifier confirmed, never supplied',
  mfaSatisfied: 'whether the MFA policy is met is computed here from the verifier’s assertion',
  assertion: 'the assertion comes from the verifier, not through the caller — passing one would ' +
    'let a caller forge the answer it wants',
  assertionId: 'the assertion identifier comes from the verifier',
  verifiedAt: 'the verifier reports when it verified',
  subjectVerified: 'whether the subject was verified is the verifier’s answer',
  trustLevel: 'assurance is the only trust this component records, and the verifier sets it',
  skipVerification: 'there is no such thing here, and naming it is how it would get one',
  bypass: 'there is no such thing here, and naming it is how it would get one',
});

/**
 * Fields owned by another component, or that would put a secret in this component's tables.
 *
 * `password`, `tokenHash` and `sessionToken` are in here for three different reasons — this
 * component must never receive a raw credential, must never be told what to store as a hash, and
 * must never let a caller choose a session secret.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  // Raw credentials. K-02 exists so that nothing holds these, including K-02.
  password: 'a raw credential; K-02 never receives, holds or stores one — the verifier does',
  passwordHash: 'K-02 stores no credential representation of any kind, hashed or otherwise',
  secret: 'a raw credential; K-02 never receives, holds or stores one',
  privateKey: 'a raw credential; K-02 never receives, holds or stores one',
  recoveryCode: 'recovery is deferred and deliberately unimplemented',
  otp: 'a one-time code is proof material for the verifier, not a field on a request record',
  pin: 'a raw credential; K-02 never receives, holds or stores one',

  // Session material a caller must not choose.
  sessionToken: 'a caller that could choose a session secret could mint any session it wanted',
  token: 'a caller that could choose a session secret could mint any session it wanted',
  tokenHash: 'the stored hash is computed here from a secret this component generated',

  // Other components.
  accountId: 'K-03 Accounts owns the universal account; authentication is about the subject',
  account: 'K-03 Accounts owns the universal account',
  roles: 'K-04 Permissions owns roles and grants',
  permissions: 'K-04 Permissions owns permission evaluation, and authentication is not authorisation',
  capabilities: 'the Capability & Verification module owns capability activation',
  subjectKind: 'K-01 Identity owns what kind of party a subject is',
  email: 'a profile field, and personal data. Use an opaque provider reference',
  phone: 'a profile field, and personal data. Use an opaque provider reference',
  name: 'a profile field, and personal data',
  ipAddress: 'personal data, and device telemetry this component does not collect',
  userAgent: 'device telemetry this component does not collect',
});
