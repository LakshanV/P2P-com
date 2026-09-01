/**
 * K-04 Permissions — the vocabularies, and the fields a request may not carry (FND-004d).
 *
 * **Identifier rules are K-01's**, re-raised in this component's vocabulary, exactly as K-02 and
 * K-03 do them. A subject id reaching this component is the same subject id K-01 issued, and a
 * fifth copy of the rule would be a fifth thing to keep in step.
 *
 * **Actions and resource types are registered, not free text.** An authorisation system whose
 * action names are strings from the caller cannot be reviewed: nobody can enumerate what it
 * decides, and a typo becomes a silent permanent denial — or, worse, a grant that matches nothing
 * while everybody believes access was given. Registration also makes the permission matrix (v3
 * §47 Level 4) a thing that can be printed from the code.
 *
 * **The forbidden-field table is what makes "the caller does not decide" executable.** Its first
 * half is the security half: fields by which a caller would assert the *outcome*, the *identity*,
 * the *role* or the *purpose satisfaction*. A request carrying one is not making a typo — it is
 * trying to be the authoriser, and accepting it would make every other guarantee here decorative.
 *
 * Owned by: K-04 Permissions.
 */

import { IdentityError, assertOpaqueIdentifier } from '../identity/index.ts';

import {
  ASSURANCE_LEVELS,
  PREDICATE_KINDS,
  PURPOSES,
  PermissionError,
  ROLES,
  type Predicate,
  type PermissionErrorCode,
  type Purpose,
  type Role,
} from './types.ts';

/** K-01's identifier refusals, in this component's vocabulary. The mapping is total and tested. */
export const IDENTITY_REFUSALS: Readonly<Record<string, PermissionErrorCode>> = Object.freeze({
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
export function assertPermissionIdentifier(value: unknown, field: string): string {
  try {
    return assertOpaqueIdentifier(value, field);
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    const code = IDENTITY_REFUSALS[error.code];
    if (code === undefined) throw error;
    throw new PermissionError(code, error.message);
  }
}

/**
 * Every action this platform can authorise, and what it is for.
 *
 * Deliberately small and deliberately generic: these are the verbs a kernel can name without
 * knowing what a listing or a payout is. Business modules will register their own when they exist,
 * through a mechanism that does not exist yet — which is stated in the contract rather than
 * pretended around.
 */
export const ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  read: 'observe a resource without changing it',
  create: 'bring a resource into existence',
  update: 'change a resource that already exists',
  delete: 'remove a resource, where the owning component permits removal at all',
  approve: 'accept something for which a human decision is required',
  // Separate verbs rather than "update a payment", because the parties differ. A buyer creates and
  // authorises; taking the money and giving it back are the seller's, and collapsing all four into
  // one action would mean any grant that let a buyer pay also let them refund themselves.
  capture: 'take money that was authorised, which is the moment a payment becomes real',
  refund: 'return money that was captured, in whole or in part',
  export: 'take a copy of data out of the platform',
  impersonate: 'act as another party, which nothing currently grants',
  'grant-permission': 'change who may do what — the authority over authority itself',
  'invoke-tool': 'run a named tool capability, which is the only verb AI_AGENT may hold',
});

/**
 * Every resource type authority can be scoped to.
 *
 * `permission` and `ledger-entry` are listed because they are the two an escalation would aim at,
 * and naming them is what lets the AI and financial-authority rules refer to something concrete.
 */
export const RESOURCE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  account: 'a K-03 universal account and the data hanging off it',
  conversation: 'a conversation between parties, or between a party and the platform',
  'commerce-request':
    'a Need: what somebody asked for, in their own words, before it is anything else',
  order: 'a commerce transaction record',
  listing: 'an offer of something for sale or hire',
  payment: 'a movement of money, owned by the payments module when it exists',
  wallet: 'a balance in one asset, held by one account. M-13 owns it; K-10 holds the journal',
  'value-plan':
    'how one amount is to be settled across several kinds of value at once, owned by M-13',
  'ledger-entry': 'a financial record. AI is never authoritative over one (v3 §38)',
  permission: 'authority itself: roles, grants and policy',
  'audit-record': 'a K-09 audit record',
  configuration: 'a K-05 configuration value',
  tool: 'a named capability an agent may invoke',
});

/**
 * Context attributes an ABAC predicate may read.
 *
 * An allowlist, because a predicate over arbitrary caller-supplied context is a predicate the
 * caller controls — and because context is exactly where personal data would arrive if nobody
 * stopped it. Every value is checked by the identifier rules, so an email address cannot be a
 * region and a bearer token cannot be a channel.
 */
export const CONTEXT_KEYS: Readonly<Record<string, string>> = Object.freeze({
  region: 'where the request is being served from, as an opaque code',
  channel: 'which surface the request arrived on, as an opaque code',
  'resource-owner-account': 'the account that owns the resource being reached',
  'risk-tier': 'the risk classification the calling surface has already computed',
  'delegation-chain': 'an opaque handle for a delegation, when one exists',
});

/** Actions AI may never hold, however explicitly somebody tries to grant them. */
export const AI_FORBIDDEN_ACTIONS: readonly string[] = Object.freeze([
  'grant-permission',
  'approve',
  'impersonate',
  'delete',
  'export',
]);

/** Resource types AI may never be authoritative over, whatever the action (v3 §38). */
export const AI_FORBIDDEN_RESOURCES: readonly string[] = Object.freeze([
  'permission',
  'ledger-entry',
  'payment',
  // A wallet and a value plan are financial records in every sense that matters — a balance and an
  // instruction to move value. Listing `ledger-entry` while leaving these out would have made the
  // rule a rule about a table name rather than about money.
  'wallet',
  'value-plan',
]);

/**
 * AI may hold explicitly granted tool capabilities, and nothing else.
 *
 * Three refusals rather than one, because they fail for three different reasons: an action that is
 * authority over authority, a resource type where AI must never be the authority (v3 §38), and the
 * positive rule that `invoke-tool` on a `tool` is the only shape an AI grant may take. Stated
 * positively *and* negatively on purpose — a future action added to the registry is denied to AI by
 * the positive rule even if nobody remembers to add it to the negative list.
 *
 * Lives here rather than in the service because it applies to **stored rows too**. A grant row
 * written around the service is exactly the case this must catch, and a check only the service runs
 * is a check a row can walk past.
 */
export function assertAiMayHold(role: string, action: string, resourceType: string): void {
  if (role !== 'AI_AGENT') return;

  if (AI_FORBIDDEN_ACTIONS.includes(action)) {
    throw new PermissionError(
      'ai-not-permitted',
      `AI_AGENT may not hold "${action}". Authority over authority, approval, impersonation, ` +
        'deletion and export are human or deterministic-system decisions (v3 §38)',
    );
  }
  if (AI_FORBIDDEN_RESOURCES.includes(resourceType)) {
    throw new PermissionError(
      'ai-not-permitted',
      `AI_AGENT may not be granted anything on ${resourceType}: AI is never the financial ` +
        'authority and never the authority over permissions (v3 §38)',
    );
  }
  if (action !== 'invoke-tool' || resourceType !== 'tool') {
    throw new PermissionError(
      'ai-not-permitted',
      `AI_AGENT may hold only explicitly granted tool capabilities — "invoke-tool" on "tool" — ` +
        `and this grant is "${action}" on "${resourceType}". Anything wider would make an agent ` +
        'an actor with standing authority rather than a caller with a named capability',
    );
  }
}

/**
 * Fields by which a caller would decide the answer itself.
 *
 * The half of the table that matters. Each names something only this component may determine, and
 * a request carrying one is trying to skip the evaluation entirely.
 */
export const ASSERTED_AUTHORIZATION_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  allowed: 'whether access is allowed is this component’s answer, not the caller’s',
  permitted: 'whether access is permitted is this component’s answer, not the caller’s',
  authorized: 'whether the request is authorised is exactly what this component is being asked',
  authorised: 'whether the request is authorised is exactly what this component is being asked',
  effect: 'allow or deny is the decision, and the decision is what this component computes',
  decision: 'the decision is computed here from grants, never supplied',
  subjectId:
    'the subject comes from a validated session, never from the caller — a caller that ' +
    'could name the subject could authorise itself as anybody',
  subject: 'the subject comes from a validated session, never from the caller',
  role: 'a role is held through a grant recorded here, not claimed in a request',
  roles: 'roles are held through grants recorded here, not claimed in a request',
  permissions: 'permissions are evaluated here from the active policy and the subject’s grants',
  grants: 'grants are read from storage, not presented by the party being authorised',
  purposeSatisfied: 'whether the declared purpose is satisfied is computed here from the grant',
  isStaff: 'whether the subject holds a staff role is read from its grants',
  bypass: 'there is no such thing here, and naming it is how it would get one',
  superAdmin: 'SUPER_ADMIN confers nothing implicitly; there is no bypass to ask for',
  override: 'there is no override path around an explicit policy',
  aiAuthority: 'AI is never authoritative for a financial or permission decision (v3 §38)',
  policyVersionId:
    'the active policy version is resolved here, so a caller cannot pick an ' +
    'older one under which it had more authority',
  publishedBy:
    'who published a policy is derived from the validated session that published it. A caller ' +
    'that could name the author could sign somebody else’s name to a change of authority',
  grantedBy:
    'who granted authority is derived from the validated session that granted it, never ' +
    'supplied — an unauthenticated grantor is an authority nobody actually decided to give',
  revokedBy:
    'who revoked authority is derived from the validated session that revoked it, never supplied',
  actor:
    'the actor is the authenticated subject behind the presented session, never a name in a ' +
    'request',
  administrator:
    'the administrator is the authenticated subject behind the presented session, and their ' +
    'authority to administer is evaluated here rather than claimed',
  bootstrap:
    'bootstrap is an injected deployment decision (ports.ts), not something a request may ask ' +
    'for. A caller that could request it could install its own first policy',
});

/**
 * Fields owned by another component, or that would put a secret in this component's tables.
 *
 * `presentedToken` is **not** here: it is the one credential-shaped input K-04 accepts, because
 * validating it is how the subject is resolved. It is passed straight to the session port, never
 * stored, never logged and never echoed in a refusal.
 */
export const FOREIGN_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  password: 'a raw credential; K-04 never receives, holds or stores one',
  passwordHash: 'K-04 stores no credential representation of any kind',
  secret: 'a raw credential; K-04 never receives, holds or stores one',
  sessionToken: 'the session secret is `presentedToken`, and it is handed to K-02’s port unread',
  tokenHash: 'K-02 owns session material; K-04 never sees a hash of one',
  subjectKind: 'K-01 Identity owns what kind of party a subject is',
  capabilities: 'the Capability & Verification module owns capability activation',
  verificationLevel: 'the Capability & Verification module owns verification',
  email: 'a profile field, and personal data. Use an opaque identifier',
  phone: 'a profile field, and personal data. Use an opaque identifier',
  name: 'a profile field, and personal data',
  ipAddress: 'personal data, and device telemetry this component does not collect',
  userAgent: 'device telemetry this component does not collect',
  balance: 'K-10 Ledger foundation owns every monetary amount',
});

/** The action must be one this platform has registered. */
export function assertAction(value: unknown): string {
  if (typeof value !== 'string' || !(value in ACTIONS)) {
    throw new PermissionError(
      'unsupported-action',
      `"${String(value)}" is not a registered action. Registered: ${Object.keys(ACTIONS).join(', ')}. ` +
        'An unregistered action would be a permission nobody can enumerate or review',
    );
  }
  return value;
}

/** The resource type must be one this platform has registered. */
export function assertResourceType(value: unknown): string {
  if (typeof value !== 'string' || !(value in RESOURCE_TYPES)) {
    throw new PermissionError(
      'unsupported-resource',
      `"${String(value)}" is not a registered resource type. Registered: ` +
        Object.keys(RESOURCE_TYPES).join(', '),
    );
  }
  return value;
}

/** The role must be in the closed vocabulary. */
export function assertRole(value: unknown): Role {
  if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) {
    throw new PermissionError(
      'unsupported-role',
      `"${String(value)}" is not a role. The vocabulary is ${ROLES.join(', ')}`,
    );
  }
  return value as Role;
}

/** The purpose must be in the closed vocabulary. Free text is not a purpose. */
export function assertPurpose(value: unknown): Purpose {
  if (typeof value !== 'string' || !(PURPOSES as readonly string[]).includes(value)) {
    throw new PermissionError(
      'mismatched-purpose',
      `"${String(value)}" is not a declared purpose. Declared: ${PURPOSES.join(', ')}. ` +
        'A free-text purpose is one nobody can audit',
    );
  }
  return value as Purpose;
}

/**
 * Refuse a predicate that is not one of the six kinds, or that reads an attribute nobody declared.
 *
 * The attribute check matters more than it looks: a predicate over an unknown attribute would
 * evaluate to "not equal" for ever, so the grant carrying it would silently never apply. Somebody
 * would believe access had been granted and it never would have been.
 */
export function assertPredicate(value: unknown, path = 'condition'): Predicate {
  if (value === null || typeof value !== 'object') {
    throw new PermissionError(
      'unsupported-predicate',
      `${path} is ${value === null ? 'null' : typeof value}; expected a predicate object`,
    );
  }
  const candidate = value as { kind?: unknown };
  if (
    typeof candidate.kind !== 'string' ||
    !(PREDICATE_KINDS as readonly string[]).includes(candidate.kind)
  ) {
    throw new PermissionError(
      'unsupported-predicate',
      `${path}.kind is "${String(candidate.kind)}"; expected one of ${PREDICATE_KINDS.join(', ')}`,
    );
  }

  const predicate = value as Predicate;
  switch (predicate.kind) {
    case 'always':
      return Object.freeze({ kind: 'always' });

    case 'attribute-equals':
      return Object.freeze({
        kind: 'attribute-equals',
        attribute: assertContextKey(predicate.attribute, `${path}.attribute`),
        value: assertPermissionIdentifier(predicate.value, `${path}.value`),
      });

    case 'attribute-in': {
      if (!Array.isArray(predicate.values) || predicate.values.length === 0) {
        throw new PermissionError(
          'unsupported-predicate',
          `${path}.values must be a non-empty array; a predicate that can match nothing is a ` +
            'grant that never applies',
        );
      }
      return Object.freeze({
        kind: 'attribute-in',
        attribute: assertContextKey(predicate.attribute, `${path}.attribute`),
        values: Object.freeze(
          predicate.values.map((entry, index) =>
            assertPermissionIdentifier(entry, `${path}.values[${index}]`),
          ),
        ),
      });
    }

    case 'assurance-at-least': {
      if (!(ASSURANCE_LEVELS as readonly string[]).includes(predicate.assurance)) {
        throw new PermissionError(
          'unsupported-predicate',
          `${path}.assurance is "${String(predicate.assurance)}"; expected one of ` +
            ASSURANCE_LEVELS.join(', '),
        );
      }
      return Object.freeze({ kind: 'assurance-at-least', assurance: predicate.assurance });
    }

    case 'all':
    case 'any': {
      if (!Array.isArray(predicate.of) || predicate.of.length === 0) {
        throw new PermissionError(
          'unsupported-predicate',
          `${path}.of must be a non-empty array of predicates`,
        );
      }
      if (predicate.of.length > 8) {
        // A bound rather than a limit anybody will hit: an unbounded tree is an unbounded
        // evaluation, and a policy nobody can read in one screen is a policy nobody reviews.
        throw new PermissionError(
          'unsupported-predicate',
          `${path}.of holds ${predicate.of.length} predicates; at most 8 are permitted`,
        );
      }
      return Object.freeze({
        kind: predicate.kind,
        of: Object.freeze(
          predicate.of.map((entry, index) => assertPredicate(entry, `${path}.of[${index}]`)),
        ),
      });
    }
  }
}

/** The attribute must be one the context allowlist declares. */
export function assertContextKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !(value in CONTEXT_KEYS)) {
    throw new PermissionError(
      'unsupported-predicate',
      `${field} is "${String(value)}", which is not a declared context attribute. Declared: ` +
        `${Object.keys(CONTEXT_KEYS).join(', ')}. A predicate over an undeclared attribute would ` +
        'never match, so the grant carrying it would silently never apply',
    );
  }
  return value;
}

/**
 * Refuse the context a caller presents, unless every key is declared and every value is opaque.
 *
 * The values go through the K-01 identifier rules for the same reason the identifiers do: context
 * is where an email address or a bearer token would arrive if nobody looked.
 */
export function assertContext(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PermissionError(
      'malformed-record',
      `context must be an object of declared attributes, got ${value === null ? 'null' : typeof value}`,
    );
  }

  const context: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    assertContextKey(key, `context.${key}`);
    context[key] = assertPermissionIdentifier(entry, `context.${key}`);
  }
  return Object.freeze(context);
}
