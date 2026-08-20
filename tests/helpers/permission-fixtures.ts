/**
 * Shared fixtures for the K-04 suites (FND-004d).
 *
 * The three fakes here stand in for the three things K-04 refuses to determine itself, and each is
 * written so a test can make it misbehave — a session validator that asserts a revoked session, an
 * account lookup that returns somebody else's account, a clock that jumps forward a year. Those
 * are the interesting cases: K-04 re-checks what its ports assert, and a fixture that could only
 * behave well would prove none of it.
 */

import {
  InMemoryPermissionRepository,
  PermissionService,
  type AccountAssertion,
  type AccountLookup,
  type Clock,
  type Origin,
  type PublishPolicyRequest,
  type SessionAssertion,
  type SessionValidator,
} from '../../kernel/permissions/index.ts';

export const SUBJECT = 'sub_01HQZXPERM0001';
export const ACCOUNT = 'acct_01HQZXPERM0001';
export const SESSION = 'sess_01HQZXPERM0001';
export const TOKEN = `tok${'A'.repeat(39)}0001`;
export const NOW = '2026-04-01T12:00:00Z';

export const SYSTEM: Origin = Object.freeze({ kind: 'system', id: 'K-04-permission-service' });
export const HUMAN: Origin = Object.freeze({ kind: 'human', id: 'ops-alice-console' });

/** A clock a test moves by hand. */
export class FixedClock implements Clock {
  #now: string;

  constructor(now = NOW) {
    this.#now = now;
  }

  now(): string {
    return this.#now;
  }

  set(instant: string): void {
    this.#now = instant;
  }
}

export interface StubSessionOptions {
  readonly sessionId?: string;
  readonly subjectId?: string;
  readonly assurance?: string;
  readonly factors?: readonly string[];
  readonly issuedAt?: string;
  readonly absoluteExpiresAt?: string;
  readonly idleExpiresAt?: string;
  readonly revokedAt?: string | null;
  /** When set, `validate` rejects with this instead of asserting. */
  readonly refuseWith?: Error;
}

/**
 * A session validator whose answer a test controls completely, including the wrong answers.
 *
 * Structurally the same shape K-02's `AuthenticationService.validate` returns — and
 * `tests/permissions.test.ts` wires the real K-02 service to the port to prove that is still true.
 */
export class StubSessionValidator implements SessionValidator {
  readonly presented: string[] = [];
  #options: StubSessionOptions;

  constructor(options: StubSessionOptions = {}) {
    this.#options = options;
  }

  /** Change what the validator will say next. */
  answerWith(options: StubSessionOptions): void {
    this.#options = { ...this.#options, ...options };
  }

  /** Stop refusing, for a test that makes the validator misbehave and then behave. */
  clearRefusal(): void {
    const rest = { ...this.#options };
    delete (rest as { refuseWith?: Error }).refuseWith;
    this.#options = rest;
  }

  validate(presentedToken: string): Promise<SessionAssertion> {
    this.presented.push(presentedToken);
    if (this.#options.refuseWith !== undefined) return Promise.reject(this.#options.refuseWith);

    return Promise.resolve({
      sessionId: this.#options.sessionId ?? SESSION,
      subjectId: this.#options.subjectId ?? SUBJECT,
      assurance: this.#options.assurance ?? 'single-factor',
      factors: this.#options.factors ?? ['possession'],
      issuedAt: this.#options.issuedAt ?? NOW,
      absoluteExpiresAt: this.#options.absoluteExpiresAt ?? '2026-04-02T00:00:00Z',
      idleExpiresAt: this.#options.idleExpiresAt ?? '2026-04-01T12:30:00Z',
      revokedAt: this.#options.revokedAt ?? null,
    });
  }
}

/** An account lookup that knows exactly the pairs it was given, and counts what it was asked. */
export class StubAccountLookup implements AccountLookup {
  readonly asked: string[] = [];
  #accounts: Map<string, AccountAssertion>;

  constructor(
    accounts: readonly AccountAssertion[] = [{ accountId: ACCOUNT, subjectId: SUBJECT }],
  ) {
    this.#accounts = new Map(accounts.map((account) => [account.subjectId, account]));
  }

  answerWith(accounts: readonly AccountAssertion[]): void {
    this.#accounts = new Map(accounts.map((account) => [account.subjectId, account]));
  }

  findAccountForSubject(subjectId: string): Promise<AccountAssertion | null> {
    this.asked.push(subjectId);
    return Promise.resolve(this.#accounts.get(subjectId) ?? null);
  }
}

export interface Harness {
  readonly service: PermissionService;
  readonly repository: InMemoryPermissionRepository;
  readonly sessions: StubSessionValidator;
  readonly accounts: StubAccountLookup;
  readonly clock: FixedClock;
}

export function build(
  options: {
    readonly sessions?: StubSessionValidator;
    readonly accounts?: StubAccountLookup;
    readonly clock?: FixedClock;
    readonly repository?: InMemoryPermissionRepository;
  } = {},
): Harness {
  const repository = options.repository ?? new InMemoryPermissionRepository();
  const sessions = options.sessions ?? new StubSessionValidator();
  const accounts = options.accounts ?? new StubAccountLookup();
  const clock = options.clock ?? new FixedClock();

  const service = new PermissionService({ repository, sessions, accounts, clock });
  return { service, repository, sessions, accounts, clock };
}

let sequence = 0;

const nextId = (prefix: string): string => {
  sequence += 1;
  return `${prefix}_01HQZX${String(sequence).padStart(4, '0')}`;
};

/**
 * A policy version permitting the capabilities the suites actually exercise.
 *
 * Deliberately narrow: a fixture policy that permitted everything would make the
 * "a grant cannot exceed its policy" cases pass for the wrong reason.
 */
export function policyRequest(overrides: Partial<PublishPolicyRequest> = {}): PublishPolicyRequest {
  return {
    policyVersionId: nextId('pol'),
    version: 1,
    roles: [
      {
        role: 'CUSTOMER',
        capabilities: [
          { action: 'read', resourceType: 'order' },
          { action: 'create', resourceType: 'order' },
          { action: 'read', resourceType: 'account' },
        ],
      },
      {
        role: 'SUPPORT',
        capabilities: [
          { action: 'read', resourceType: 'conversation' },
          { action: 'read', resourceType: 'order' },
        ],
      },
      {
        role: 'FINANCE',
        capabilities: [
          { action: 'read', resourceType: 'ledger-entry' },
          { action: 'approve', resourceType: 'payment' },
        ],
      },
      {
        role: 'ADMIN',
        capabilities: [{ action: 'grant-permission', resourceType: 'permission' }],
      },
      {
        role: 'SUPER_ADMIN',
        capabilities: [{ action: 'read', resourceType: 'account' }],
      },
      {
        role: 'AI_AGENT',
        capabilities: [{ action: 'invoke-tool', resourceType: 'tool' }],
      },
    ],
    publishedBy: HUMAN,
    idempotencyKey: nextId('idem'),
    ...overrides,
  };
}

export function grantRequest(
  overrides: Partial<Parameters<PermissionService['grant']>[0]> = {},
): Parameters<PermissionService['grant']>[0] {
  return {
    grantId: nextId('grant'),
    subjectId: SUBJECT,
    accountId: ACCOUNT,
    role: 'CUSTOMER',
    effect: 'allow',
    action: 'read',
    resourceType: 'order',
    grantedBy: HUMAN,
    idempotencyKey: nextId('idem'),
    ...overrides,
  };
}

export function authorizeRequest(
  overrides: Partial<Parameters<PermissionService['authorize']>[0]> = {},
): Parameters<PermissionService['authorize']>[0] {
  return {
    decisionId: nextId('dec'),
    presentedToken: TOKEN,
    accountId: ACCOUNT,
    action: 'read',
    resourceType: 'order',
    idempotencyKey: nextId('idem'),
    ...overrides,
  };
}

export function revokeRequest(
  grantId: string,
  overrides: Partial<Parameters<PermissionService['revoke']>[0]> = {},
): Parameters<PermissionService['revoke']>[0] {
  return {
    revocationId: nextId('rev'),
    grantId,
    reason: 'access-no-longer-needed',
    revokedBy: HUMAN,
    idempotencyKey: nextId('idem'),
    ...overrides,
  };
}

/** Publish the fixture policy and return the harness, for the many tests that need both. */
export async function withPolicy(harness: Harness = build()): Promise<Harness> {
  await harness.service.publishPolicy(policyRequest());
  return harness;
}

/** A stored policy row as the adapter's projection returns it. */
export function policyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policy_version_id: 'pol_01HQZXTESTROW',
    version: 1,
    roles: [{ role: 'CUSTOMER', capabilities: [{ action: 'read', resourceType: 'order' }] }],
    published_at: '2026-04-01T12:00:00.000000Z',
    published_by_kind: 'human',
    published_by_id: 'ops-alice-console',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}

export function grantRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    grant_id: 'grant_01HQZXTESTROW',
    subject_id: 'sub_01HQZXTESTROW',
    account_id: 'acct_01HQZXTESTROW',
    role: 'CUSTOMER',
    effect: 'allow',
    action: 'read',
    resource_type: 'order',
    resource_id: null,
    purpose: null,
    condition: null,
    policy_version_id: 'pol_01HQZXTESTROW',
    granted_at: '2026-04-01T12:00:00.000000Z',
    not_before: null,
    expires_at: null,
    granted_by_kind: 'human',
    granted_by_id: 'ops-alice-console',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}

export function revocationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revocation_id: 'rev_01HQZXTESTROW',
    grant_id: 'grant_01HQZXTESTROW',
    revoked_at: '2026-04-01T12:05:00.000000Z',
    reason: 'access-no-longer-needed',
    revoked_by_kind: 'human',
    revoked_by_id: 'ops-alice-console',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}

export function decisionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision_id: 'dec_01HQZXTESTROW',
    subject_id: 'sub_01HQZXTESTROW',
    account_id: 'acct_01HQZXTESTROW',
    session_id: 'sess_01HQZXTESTROW',
    action: 'read',
    resource_type: 'order',
    resource_id: null,
    effect: 'deny',
    reason: 'no-matching-grant',
    explanation: 'denied: nothing grants read on order to this subject',
    deciding_grant_id: null,
    policy_version_id: 'pol_01HQZXTESTROW',
    purpose: null,
    decided_at: '2026-04-01T12:00:00.000000Z',
    idempotency_key: 'idem_01HQZXTESTROW',
    // The fingerprint over the decision request's authoritative inputs — subject, session and
    // context included — so a retry cannot be answered from somebody else's stored decision.
    request_fingerprint: 'a'.repeat(64),
    ...overrides,
  };
}
