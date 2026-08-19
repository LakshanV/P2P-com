/**
 * Shared fixtures for the K-01 suites (FND-004a).
 *
 * The subject ids here are deliberately opaque strings that no refusal in the registry matches —
 * which is itself part of what is being tested, because a fixture that quietly tripped one of the
 * PII checks would make every happy-path test a refusal test in disguise.
 */

import {
  IdentityService,
  InMemoryIdentityRepository,
  type CreateSubjectRequest,
  type IdentityOrigin,
  type IdentitySubject,
} from '../../kernel/identity/index.ts';

export const OPERATOR: IdentityOrigin = { kind: 'human', id: 'ops-alice-console' };
export const SYSTEM: IdentityOrigin = { kind: 'system', id: 'K-03-account-service' };
export const AI: IdentityOrigin = { kind: 'ai', id: 'jaya-assistant-v1' };

export interface Harness {
  readonly service: IdentityService;
  readonly repository: InMemoryIdentityRepository;
}

export function build(): Harness {
  const repository = new InMemoryIdentityRepository();
  return { service: new IdentityService(repository), repository };
}

let sequence = 0;

/** A well-formed create request. Every override is deliberate in the test that makes it. */
export function createRequest(overrides: Partial<CreateSubjectRequest> = {}): CreateSubjectRequest {
  sequence += 1;
  return {
    subjectId: `sub_01HQZX${String(sequence).padStart(4, '0')}`,
    kind: 'person',
    createdAt: '2026-04-01T12:00:00Z',
    origin: SYSTEM,
    idempotencyKey: `idem_01HQZX${String(sequence).padStart(4, '0')}`,
    ...overrides,
  };
}

/** A subject as it would come back from the service, for tests that seed a repository directly. */
export function subject(overrides: Partial<IdentitySubject> = {}): IdentitySubject {
  sequence += 1;
  return {
    subjectId: `sub_01HQZY${String(sequence).padStart(4, '0')}`,
    kind: 'person',
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
    subject_id: 'sub_01HQZXTESTROW',
    kind: 'person',
    created_at: '2026-04-01T12:00:00.000000Z',
    origin_kind: 'system',
    origin_id: 'K-03-account-service',
    idempotency_key: 'idem_01HQZXTESTROW',
    ...overrides,
  };
}
