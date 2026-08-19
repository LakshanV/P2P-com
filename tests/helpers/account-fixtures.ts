/**
 * Shared fixtures for the K-03 suites (FND-004b).
 *
 * The lookup here is a **stub of K-01's contract, not of K-01**. `tests/accounts.test.ts` wires the
 * real `IdentityService` to the real `AccountService` and proves the two compose; everything else
 * uses this, because a suite about account concurrency should not fail when K-01 changes something
 * unrelated.
 */

import {
  AccountService,
  InMemoryAccountRepository,
  type OpenAccountRequest,
  type AccountOrigin,
  type SubjectLookup,
  type UniversalAccount,
} from '../../kernel/accounts/index.ts';

export const OPERATOR: AccountOrigin = { kind: 'human', id: 'ops-alice-console' };
export const SYSTEM: AccountOrigin = { kind: 'system', id: 'K-03-account-service' };
export const AI: AccountOrigin = { kind: 'ai', id: 'jaya-assistant-v1' };

/** The subject every fixture request names, and which `knownSubjects` reports as existing. */
export const KNOWN_SUBJECT = 'sub_01HQZXKNOWN0001';

/** A lookup that knows exactly the subjects it was given, and counts what it was asked. */
export class StubSubjectLookup implements SubjectLookup {
  readonly asked: string[] = [];
  readonly #known: Set<string>;

  constructor(known: readonly string[] = [KNOWN_SUBJECT]) {
    this.#known = new Set(known);
  }

  exists(subjectId: string): Promise<boolean> {
    this.asked.push(subjectId);
    return Promise.resolve(this.#known.has(subjectId));
  }
}

export interface Harness {
  readonly service: AccountService;
  readonly repository: InMemoryAccountRepository;
  readonly subjects: StubSubjectLookup;
}

export function build(known: readonly string[] = [KNOWN_SUBJECT]): Harness {
  const repository = new InMemoryAccountRepository();
  const subjects = new StubSubjectLookup(known);
  return { service: new AccountService(repository, subjects), repository, subjects };
}

let sequence = 0;

/** A well-formed open request. Every override is deliberate in the test that makes it. */
export function openRequest(overrides: Partial<OpenAccountRequest> = {}): OpenAccountRequest {
  sequence += 1;
  return {
    accountId: `acct_01HQZX${String(sequence).padStart(4, '0')}`,
    subjectId: KNOWN_SUBJECT,
    createdAt: '2026-04-01T12:00:00Z',
    origin: SYSTEM,
    idempotencyKey: `idem_01HQZX${String(sequence).padStart(4, '0')}`,
    ...overrides,
  };
}

/** An account as the service would return it, for tests that seed a repository directly. */
export function account(overrides: Partial<UniversalAccount> = {}): UniversalAccount {
  sequence += 1;
  return {
    accountId: `acct_01HQZY${String(sequence).padStart(4, '0')}`,
    subjectId: `sub_01HQZY${String(sequence).padStart(4, '0')}`,
    createdAt: '2026-04-01T12:00:00Z',
    origin: { ...SYSTEM },
    idempotencyKey: `idem_01HQZY${String(sequence).padStart(4, '0')}`,
    ...overrides,
  };
}

/**
 * A stored row as the adapter's SELECT projection actually returns it.
 *
 * The timestamp carries six fractional digits and a literal `Z`, because that is what
 * `to_char(… AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` produces. A fixture in any other
 * shape would be testing a projection the adapter does not issue.
 */
export function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    account_id: 'acct_01HQZXTESTROW',
    subject_id: 'sub_01HQZXTESTROW',
    created_at: '2026-04-01T12:00:00.000000Z',
    origin_kind: 'system',
    origin_id: 'K-03-account-service',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}
