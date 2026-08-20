/**
 * K-04 Permissions — the service (FND-004d).
 *
 * Four operations: publish a policy version, grant, revoke, authorise. The security of the whole
 * component rests on one rule that runs through all four:
 *
 * > **The caller never states the answer, and never states who is asking.**
 *
 * `authorize` takes a session secret, an account, an action and a resource. It does **not** take a
 * subject id, a role, a permission, a purpose satisfaction or an outcome — a request carrying any
 * of those is refused by name, because a caller that could name the subject could authorise itself
 * as anybody, and a caller that could state the effect is not being authorised at all.
 *
 * The resolution order is load-bearing:
 *
 *   1. **Shape and forbidden fields**, so a request that asserts an outcome never reaches anything.
 *   2. **The session**, through K-02's port, and then re-checked here: revoked, past its absolute
 *      expiry, past its idle expiry, or carrying an assurance this component does not recognise —
 *      all refused. Deny-by-default means not assuming somebody else's check ran.
 *   3. **The account**, through K-03's public contract. The account in the request must be the one
 *      the session's subject actually holds; anything else is `cross-account-access` **before** any
 *      grant is read, because reading another account's grants is already the wrong shape.
 *   4. **The active policy version**, resolved here so a caller cannot pick an older one under
 *      which it had more authority.
 *   5. **The evaluation** (decide.ts), which is pure and deny-by-default.
 *   6. **The record**, appended. A decision that is not written down is a decision nobody can audit.
 *
 * AI has no authority here, in three separate places: it may not author policy or grants
 * (`origin.kind: 'ai'` is refused), it may never hold a forbidden action or a forbidden resource
 * type however explicitly somebody grants it, and it is never the authority for a financial or a
 * permission decision. §6 of the contract sets out why each is a separate check rather than one.
 *
 * Owned by: K-04 Permissions. No API, no UI, no policy studio — see CONTRACT.md §9.
 */

import { compareInstants } from '../../platform/time/instant.ts';

import { evaluate, type EvaluationInput } from './decide.ts';
import { sealDecision, sealGrant, sealPolicyVersion, sealRevocation } from './immutable.ts';
import type { AccountLookup, Clock, SessionAssertion, SessionValidator } from './ports.ts';
import {
  ASSERTED_AUTHORIZATION_FIELDS,
  FOREIGN_FIELDS,
  assertAction,
  assertAiMayHold,
  assertContext,
  assertPermissionIdentifier,
  assertPurpose,
  assertResourceType,
} from './registry.ts';
import type { PermissionRepository } from './repository.ts';
import {
  ASSURANCE_LEVELS,
  PermissionError,
  isStaffRole,
  type AssuranceLevel,
  type Decision,
  type Grant,
  type Origin,
  type PolicyVersion,
  type Purpose,
  type Revocation,
  type Role,
} from './types.ts';
import { validateDecision, validateGrant, validatePolicyVersion, validateRevocation } from './validate.ts';

export interface PublishPolicyRequest {
  readonly policyVersionId: string;
  readonly version: number;
  readonly roles: readonly { readonly role: string; readonly capabilities: readonly { readonly action: string; readonly resourceType: string }[] }[];
  readonly publishedBy: Origin;
  readonly idempotencyKey: string;
}

export interface GrantRequest {
  readonly grantId: string;
  readonly subjectId: string;
  readonly accountId: string;
  readonly role: string;
  readonly effect: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly purpose?: string | null;
  readonly condition?: unknown;
  readonly notBefore?: string | null;
  readonly expiresAt?: string | null;
  readonly grantedBy: Origin;
  readonly idempotencyKey: string;
}

export interface RevokeRequest {
  readonly revocationId: string;
  readonly grantId: string;
  readonly reason: string;
  readonly revokedBy: Origin;
  readonly idempotencyKey: string;
}

/**
 * What a caller may ask. Note what is not here: who is asking, and what the answer should be.
 */
export interface AuthorizeRequest {
  readonly decisionId: string;
  /** The session secret. Handed to K-02's port unread, never stored, never echoed. */
  readonly presentedToken: string;
  readonly accountId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  /** Mandatory for a staff role. Refused if it is not a declared purpose. */
  readonly purpose?: string | null;
  /** Attributes for ABAC predicates. Every key is allowlisted and every value is opaque. */
  readonly context?: Record<string, string>;
  readonly idempotencyKey: string;
}

export interface AuthorizeResult {
  readonly decision: Decision;
  readonly deduplicated: boolean;
}

const PUBLISH_KEYS: readonly string[] = [
  'policyVersionId',
  'version',
  'roles',
  'publishedBy',
  'idempotencyKey',
];

const GRANT_KEYS: readonly string[] = [
  'grantId',
  'subjectId',
  'accountId',
  'role',
  'effect',
  'action',
  'resourceType',
  'resourceId',
  'purpose',
  'condition',
  'notBefore',
  'expiresAt',
  'grantedBy',
  'idempotencyKey',
];

const REVOKE_KEYS: readonly string[] = [
  'revocationId',
  'grantId',
  'reason',
  'revokedBy',
  'idempotencyKey',
];

const AUTHORIZE_KEYS: readonly string[] = [
  'decisionId',
  'presentedToken',
  'accountId',
  'action',
  'resourceType',
  'resourceId',
  'purpose',
  'context',
  'idempotencyKey',
];

export class PermissionService {
  readonly #repository: PermissionRepository;
  readonly #sessions: SessionValidator;
  readonly #accounts: AccountLookup;
  readonly #clock: Clock;

  constructor(options: {
    readonly repository: PermissionRepository;
    /** K-02's session validation, injected. Its answer is checked, not believed. */
    readonly sessions: SessionValidator;
    /** K-03's account lookup, injected. */
    readonly accounts: AccountLookup;
    readonly clock: Clock;
  }) {
    this.#repository = options.repository;
    this.#sessions = options.sessions;
    this.#accounts = options.accounts;
    this.#clock = options.clock;
  }

  /**
   * Publish an immutable, numbered policy version.
   *
   * Never an edit. A change to what a role may do is a new version with a higher number, and every
   * grant records the version it was made under, so authority can be replayed as it stood.
   */
  async publishPolicy(
    request: PublishPolicyRequest,
  ): Promise<{ policy: PolicyVersion; deduplicated: boolean }> {
    assertPermittedKeys(request, PUBLISH_KEYS, 'a publish-policy request');

    const policy = sealPolicyVersion(
      validatePolicyVersion(
        {
          policyVersionId: request.policyVersionId,
          version: request.version,
          roles: request.roles,
          publishedAt: this.#now(),
          publishedBy: request.publishedBy,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );
    assertAiHoldsNoForbiddenCapability(policy);

    try {
      return await this.#repository.withTransaction(async (tx) => {
        const existing = await tx.findPolicyByIdempotencyKey(policy.idempotencyKey);
        if (existing !== null) {
          assertSamePolicy(existing, policy);
          return { policy: sealPolicyVersion(existing), deduplicated: true };
        }
        await tx.insertPolicyVersion(policy);
        return { policy, deduplicated: false };
      });
    } catch (error) {
      const converged = await this.#converge(
        error,
        ['duplicate-policy-version', 'idempotency-key-reuse', 'malformed-record'],
        () =>
          this.#repository.withTransaction((tx) =>
            tx.findPolicyByIdempotencyKey(policy.idempotencyKey),
          ),
      );
      if (converged === null) throw error;
      if (differencesBetweenPolicies(converged, policy).length > 0) throw error;
      return { policy: sealPolicyVersion(converged), deduplicated: true };
    }
  }

  /**
   * Record one explicit statement of authority.
   *
   * The grant is checked against the **active** policy version, so a grant can never exceed the
   * policy it was made under, and it carries that version's id for ever.
   */
  async grant(request: GrantRequest): Promise<{ grant: Grant; deduplicated: boolean }> {
    assertPermittedKeys(request, GRANT_KEYS, 'a grant request');

    const policy = await this.#requireActivePolicy();
    const grant = sealGrant(
      validateGrant(
        {
          grantId: request.grantId,
          subjectId: request.subjectId,
          accountId: request.accountId,
          role: request.role,
          effect: request.effect,
          action: request.action,
          resourceType: request.resourceType,
          resourceId: request.resourceId ?? null,
          purpose: request.purpose ?? null,
          condition: request.condition ?? null,
          policyVersionId: policy.policyVersionId,
          grantedAt: this.#now(),
          notBefore: request.notBefore ?? null,
          expiresAt: request.expiresAt ?? null,
          grantedBy: request.grantedBy,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    assertAiMayHold(grant.role, grant.action, grant.resourceType);
    assertPolicyPermits(policy, grant);

    try {
      return await this.#repository.withTransaction(async (tx) => {
        const existing = await tx.findGrantByIdempotencyKey(grant.idempotencyKey);
        if (existing !== null) {
          assertSameGrant(existing, grant);
          return { grant: sealGrant(existing), deduplicated: true };
        }
        await tx.insertGrant(grant);
        return { grant, deduplicated: false };
      });
    } catch (error) {
      const converged = await this.#converge(
        error,
        ['duplicate-grant', 'idempotency-key-reuse'],
        () => this.#repository.withTransaction((tx) => tx.findGrantByIdempotencyKey(grant.idempotencyKey)),
      );
      if (converged === null) throw error;
      if (differencesBetweenGrants(converged, grant).length > 0) throw error;
      return { grant: sealGrant(converged), deduplicated: true };
    }
  }

  /**
   * Withdraw a grant by appending a revocation.
   *
   * The grant row is not touched. A second revocation of the same grant is refused rather than
   * converged on: it would rewrite when authority actually ended, and the first one is the fact.
   */
  async revoke(request: RevokeRequest): Promise<Revocation> {
    assertPermittedKeys(request, REVOKE_KEYS, 'a revoke request');

    const revocation = sealRevocation(
      validateRevocation(
        {
          revocationId: request.revocationId,
          grantId: request.grantId,
          revokedAt: this.#now(),
          reason: request.reason,
          revokedBy: request.revokedBy,
          idempotencyKey: request.idempotencyKey,
        },
        'request',
      ),
    );

    try {
      return await this.#repository.withTransaction(async (tx) => {
        const already = await tx.findRevocationByIdempotencyKey(revocation.idempotencyKey);
        if (already !== null) {
          assertSameRevocation(already, revocation);
          return sealRevocation(already);
        }
        const grant = await tx.findGrantById(revocation.grantId);
        if (grant === null) {
          throw new PermissionError(
            'no-such-grant',
            `no grant ${revocation.grantId}. Revoking authority that was never recorded would ` +
              'leave a revocation nobody can attach to anything',
          );
        }
        await tx.insertRevocation(revocation);
        return revocation;
      });
    } catch (error) {
      const converged = await this.#converge(
        error,
        ['stale-revocation', 'idempotency-key-reuse'],
        () =>
          this.#repository.withTransaction((tx) =>
            tx.findRevocationByIdempotencyKey(revocation.idempotencyKey),
          ),
      );
      if (converged === null) throw error;
      if (differencesBetweenRevocations(converged, revocation).length > 0) throw error;
      return sealRevocation(converged);
    }
  }

  /**
   * Decide, record and return.
   *
   * The answer is `deny` unless a grant this component stored says otherwise. Every refusal below
   * happens *before* the evaluation, because a request that cannot be resolved to a subject and an
   * account is not a denial — it is a request nobody can even ask.
   */
  async authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    assertPermittedKeys(request, AUTHORIZE_KEYS, 'an authorize request');

    const decisionId = assertPermissionIdentifier(request.decisionId, 'decisionId');
    const idempotencyKey = assertPermissionIdentifier(request.idempotencyKey, 'idempotencyKey');
    const accountId = assertPermissionIdentifier(request.accountId, 'accountId');
    const action = assertAction(request.action);
    const resourceType = assertResourceType(request.resourceType);
    const resourceId =
      request.resourceId === undefined || request.resourceId === null
        ? null
        : assertPermissionIdentifier(request.resourceId, 'resourceId');
    const purpose: Purpose | null =
      request.purpose === undefined || request.purpose === null ? null : assertPurpose(request.purpose);
    const context = assertContext(request.context);

    // A retry of a decision that has already been recorded returns the decision that was taken,
    // not a fresh one: re-deciding would let a caller retry until the answer changed.
    const already = await this.#repository.withTransaction((tx) =>
      tx.findDecisionByIdempotencyKey(idempotencyKey),
    );
    if (already !== null) {
      assertSameDecisionRequest(already, { decisionId, accountId, action, resourceType, resourceId, purpose });
      return { decision: sealDecision(already), deduplicated: true };
    }

    const session = await this.#validateSession(request.presentedToken);
    const account = await this.#accounts.findAccountForSubject(session.subjectId);
    if (account === null) {
      throw new PermissionError(
        'unknown-account',
        `subject ${session.subjectId} holds no universal account, so there is nothing to scope ` +
          'authority to. K-03 owns the account; K-04 does not create one',
      );
    }
    if (account.subjectId !== session.subjectId) {
      throw new PermissionError(
        'unknown-account',
        'the account lookup returned an account belonging to another subject',
      );
    }
    if (account.accountId !== accountId) {
      // Before any grant is read. Reading another account's grants is already the wrong shape,
      // whatever the answer would have been.
      throw new PermissionError(
        'cross-account-access',
        `the session's subject holds account ${account.accountId}, and the request names ` +
          `${accountId}. Authority never spans accounts, so this is refused rather than evaluated`,
      );
    }

    const now = this.#now();
    const { policy, grants, revokedGrantIds } = await this.#repository.withTransaction(async (tx) => {
      const active = await tx.findActivePolicy();
      if (active === null) {
        throw new PermissionError(
          'no-such-policy',
          'no policy version has been published, so no role permits anything and nothing can be ' +
            'authorised. That is the correct answer, not a configuration error to work around',
        );
      }
      const held = await tx.listGrantsForSubject(session.subjectId, accountId);
      const revocations = await tx.listRevocationsForGrants(held.map((grant) => grant.grantId));
      return {
        policy: active,
        grants: held,
        revokedGrantIds: new Set(revocations.map((revocation) => revocation.grantId)),
      };
    });

    const input: EvaluationInput = {
      subjectId: session.subjectId,
      accountId,
      action,
      resourceType,
      resourceId,
      purpose,
      context,
      assurance: session.assurance,
      now,
      policy,
      grants,
      revokedGrantIds,
    };
    const evaluation = evaluate(input);

    const decision = sealDecision(
      validateDecision(
        {
          decisionId,
          subjectId: session.subjectId,
          accountId,
          sessionId: session.sessionId,
          action,
          resourceType,
          resourceId,
          effect: evaluation.effect,
          reason: evaluation.reason,
          explanation: evaluation.explanation,
          decidingGrantId: evaluation.decidingGrantId,
          policyVersionId: policy.policyVersionId,
          purpose,
          decidedAt: now,
          idempotencyKey,
        },
        'request',
      ),
    );

    try {
      await this.#repository.withTransaction((tx) => tx.insertDecision(decision));
    } catch (error) {
      // Another copy of this same call recorded its decision first. Converge on what was written
      // rather than failing: two identical requests must not produce two answers.
      const converged = await this.#converge(
        error,
        ['idempotency-key-reuse', 'malformed-record'],
        () => this.#repository.withTransaction((tx) => tx.findDecisionByIdempotencyKey(idempotencyKey)),
      );
      if (converged === null) throw error;
      assertSameDecisionRequest(converged, { decisionId, accountId, action, resourceType, resourceId, purpose });
      return { decision: sealDecision(converged), deduplicated: true };
    }

    return { decision, deduplicated: false };
  }

  /** One decision, by id, or null. */
  async findDecision(decisionId: string): Promise<Decision | null> {
    assertPermissionIdentifier(decisionId, 'decisionId');
    const decision = await this.#repository.withTransaction((tx) => tx.findDecisionById(decisionId));
    return decision === null ? null : sealDecision(decision);
  }

  /** One grant, by id, or null. */
  async findGrant(grantId: string): Promise<Grant | null> {
    assertPermissionIdentifier(grantId, 'grantId');
    const grant = await this.#repository.withTransaction((tx) => tx.findGrantById(grantId));
    return grant === null ? null : sealGrant(grant);
  }

  /** The active policy version, or a refusal when none has been published. */
  async activePolicy(): Promise<PolicyVersion> {
    return this.#requireActivePolicy();
  }

  // -------------------------------------------------------------------------

  async #requireActivePolicy(): Promise<PolicyVersion> {
    const policy = await this.#repository.withTransaction((tx) => tx.findActivePolicy());
    if (policy === null) {
      throw new PermissionError(
        'no-such-policy',
        'no policy version has been published. A grant cannot exceed the policy it was made ' +
          'under, so there is no policy to make one under',
      );
    }
    return sealPolicyVersion(policy);
  }

  /**
   * Turn a presented secret into a subject, and then check the answer.
   *
   * The port's refusal is normalised without being inspected — a session error can carry a
   * fragment of the secret in its message. What the port *returns* is then re-checked here, because
   * deny-by-default means not assuming somebody else's expiry check ran.
   */
  async #validateSession(presentedToken: unknown): Promise<{
    sessionId: string;
    subjectId: string;
    assurance: AssuranceLevel;
  }> {
    if (typeof presentedToken !== 'string' || presentedToken === '') {
      // Note what is *not* in this message: the value.
      throw new PermissionError(
        'invalid-session',
        'no session secret was presented, or it was not a string',
      );
    }

    let asserted: SessionAssertion;
    try {
      asserted = await this.#sessions.validate(presentedToken);
    } catch {
      throw new PermissionError(
        'invalid-session',
        'the session validator refused the presented secret. Its reason is deliberately not ' +
          'repeated here: a session error can carry proof material, and this component has no ' +
          'business echoing one',
      );
    }

    const sessionId = assertPermissionIdentifier(asserted.sessionId, 'session.sessionId');
    const subjectId = assertPermissionIdentifier(asserted.subjectId, 'session.subjectId');

    if (asserted.revokedAt !== null) {
      throw new PermissionError(
        'invalid-session',
        `session ${sessionId} was revoked at ${asserted.revokedAt}. A validator that returns a ` +
          'revoked session is not believed',
      );
    }

    const now = this.#now();
    for (const [field, instant] of [
      ['absolute expiry', asserted.absoluteExpiresAt],
      ['idle expiry', asserted.idleExpiresAt],
    ] as const) {
      if (typeof instant !== 'string' || compareInstants(now, instant) >= 0) {
        throw new PermissionError(
          'invalid-session',
          `session ${sessionId} is past its ${field} (${String(instant)}) at ${now}. K-04 re-checks ` +
            'expiry itself rather than assuming the validator did',
        );
      }
    }

    if (!(ASSURANCE_LEVELS as readonly string[]).includes(asserted.assurance)) {
      throw new PermissionError(
        'invalid-session',
        `session ${sessionId} asserts assurance "${asserted.assurance}", which this component does ` +
          'not recognise. An unknown assurance is refused rather than ranked lowest, because a ' +
          'predicate comparing against it would otherwise silently pass or silently fail',
      );
    }

    return { sessionId, subjectId, assurance: asserted.assurance as AssuranceLevel };
  }

  #now(): string {
    const now = this.#clock.now();
    if (typeof now !== 'string') {
      throw new PermissionError(
        'malformed-instant',
        `the injected clock returned ${typeof now} rather than a UTC instant string`,
      );
    }
    return now;
  }

  /** Re-read after a uniqueness conflict, or `null` when the conflict was not a race. */
  async #converge<T>(
    error: unknown,
    codes: readonly PermissionError['code'][],
    reread: () => Promise<T | null>,
  ): Promise<T | null> {
    if (!(error instanceof PermissionError) || !codes.includes(error.code)) return null;
    return reread();
  }
}

// ---------------------------------------------------------------------------

/**
 * Refuse a request that decides the answer, names the asker, or carries another component's field.
 *
 * The first half is the security check. The second is the tidiness one. Both refuse rather than
 * ignore, because a silently dropped `role` would leave the caller believing it had claimed one.
 */
function assertPermittedKeys(request: unknown, permitted: readonly string[], what: string): void {
  if (request === null || typeof request !== 'object') {
    throw new PermissionError(
      'malformed-record',
      `${what} must be an object, got ${request === null ? 'null' : typeof request}`,
    );
  }

  for (const key of Object.keys(request)) {
    if (permitted.includes(key)) continue;

    const asserted = ASSERTED_AUTHORIZATION_FIELDS[key];
    if (asserted !== undefined) {
      throw new PermissionError(
        'caller-asserted-authorization',
        `${what} carried "${key}", but ${asserted}. This component decides from grants it stored ` +
          'itself; a caller that could state the outcome would make every other guarantee here ' +
          'decorative',
      );
    }

    const foreign = FOREIGN_FIELDS[key];
    if (foreign !== undefined) {
      throw new PermissionError('foreign-concern', `${what} carried "${key}", but ${foreign}`);
    }

    throw new PermissionError(
      'foreign-concern',
      `${what} carried the unrecognised field "${key}". The permitted fields are ` +
        `${permitted.join(', ')}; anything else would be accepted and silently dropped`,
    );
  }
}

/** The same rule, applied to a policy version: no published role definition may widen AI. */
function assertAiHoldsNoForbiddenCapability(policy: PolicyVersion): void {
  const agent = policy.roles.find((definition) => definition.role === 'AI_AGENT');
  if (agent === undefined) return;
  for (const capability of agent.capabilities) {
    assertAiMayHold('AI_AGENT', capability.action, capability.resourceType);
  }
}

/** A grant may not exceed the policy version it is made under. */
function assertPolicyPermits(policy: PolicyVersion, grant: Grant): void {
  // A deny may be recorded for anything: denying more than the policy permits is not an
  // escalation, and refusing it would make a policy change able to *widen* effective access.
  if (grant.effect === 'deny') return;

  const definition = policy.roles.find((entry) => entry.role === grant.role);
  const permitted =
    definition !== undefined &&
    definition.capabilities.some(
      (capability) =>
        capability.action === grant.action && capability.resourceType === grant.resourceType,
    );
  if (!permitted) {
    throw new PermissionError(
      'unsupported-action',
      `policy version ${policy.version} does not permit ${grant.role} to ${grant.action} a ` +
        `${grant.resourceType}, so an allow granting it would exceed the policy it is made under. ` +
        'Publish a policy version that permits it first',
    );
  }
}

/** Staff purpose is a property of the role, restated here so a reader of the service sees it. */
export function requiresPurpose(role: Role): boolean {
  return isStaffRole(role);
}

function differencesBetweenPolicies(existing: PolicyVersion, incoming: PolicyVersion): string[] {
  const differences: string[] = [];
  if (existing.policyVersionId !== incoming.policyVersionId) differences.push('policyVersionId');
  if (existing.version !== incoming.version) differences.push('version');
  if (JSON.stringify(existing.roles) !== JSON.stringify(incoming.roles)) differences.push('roles');
  return differences;
}

function assertSamePolicy(existing: PolicyVersion, incoming: PolicyVersion): void {
  const differences = differencesBetweenPolicies(existing, incoming);
  if (differences.length === 0) return;
  throw new PermissionError(
    'idempotency-key-reuse',
    `idempotency key "${incoming.idempotencyKey}" was already used for a different policy version ` +
      `(${differences.join(', ')}). Returning the earlier one would tell the caller it had ` +
      'published a policy it never wrote',
  );
}

function differencesBetweenGrants(existing: Grant, incoming: Grant): string[] {
  const differences: string[] = [];
  for (const field of [
    'grantId',
    'subjectId',
    'accountId',
    'role',
    'effect',
    'action',
    'resourceType',
    'resourceId',
    'purpose',
    'policyVersionId',
    'notBefore',
    'expiresAt',
  ] as const) {
    if (existing[field] !== incoming[field]) differences.push(field);
  }
  if (JSON.stringify(existing.condition) !== JSON.stringify(incoming.condition)) {
    differences.push('condition');
  }
  return differences;
}

function assertSameGrant(existing: Grant, incoming: Grant): void {
  const differences = differencesBetweenGrants(existing, incoming);
  if (differences.length === 0) return;
  throw new PermissionError(
    'idempotency-key-reuse',
    `idempotency key "${incoming.idempotencyKey}" was already used for a different grant ` +
      `(${differences.join(', ')}). Returning the earlier one would tell the caller it had granted ` +
      'an authority it never granted',
  );
}

function differencesBetweenRevocations(existing: Revocation, incoming: Revocation): string[] {
  const differences: string[] = [];
  for (const field of ['revocationId', 'grantId', 'reason'] as const) {
    if (existing[field] !== incoming[field]) differences.push(field);
  }
  return differences;
}

function assertSameRevocation(existing: Revocation, incoming: Revocation): void {
  const differences = differencesBetweenRevocations(existing, incoming);
  if (differences.length === 0) return;
  throw new PermissionError(
    'idempotency-key-reuse',
    `idempotency key "${incoming.idempotencyKey}" was already used for a different revocation ` +
      `(${differences.join(', ')})`,
  );
}

/**
 * A recorded decision may only be returned to a request that asked the same question.
 *
 * Without this, an idempotency key reused for a different resource would hand back an `allow` that
 * was computed for something else — the exact shape of a confused-deputy escalation.
 */
function assertSameDecisionRequest(
  existing: Decision,
  incoming: {
    decisionId: string;
    accountId: string;
    action: string;
    resourceType: string;
    resourceId: string | null;
    purpose: Purpose | null;
  },
): void {
  const differences: string[] = [];
  if (existing.decisionId !== incoming.decisionId) differences.push('decisionId');
  if (existing.accountId !== incoming.accountId) differences.push('accountId');
  if (existing.action !== incoming.action) differences.push('action');
  if (existing.resourceType !== incoming.resourceType) differences.push('resourceType');
  if (existing.resourceId !== incoming.resourceId) differences.push('resourceId');
  if (existing.purpose !== incoming.purpose) differences.push('purpose');
  if (differences.length === 0) return;

  throw new PermissionError(
    'idempotency-key-reuse',
    `idempotency key "${existing.idempotencyKey}" already recorded a decision about a different ` +
      `question (${differences.join(', ')}). Returning it would hand back an answer computed for ` +
      'something else, which is how a confused deputy is built',
  );
}
