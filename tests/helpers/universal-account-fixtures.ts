/**
 * Shared fixtures for the M-01 Universal Account suites.
 *
 * Every identifier and every instant is supplied here rather than read from a clock, so a replayed
 * request produces a byte-identical record and the suites need no fake timers.
 */

import {
  InMemoryUniversalAccountRepository,
  UniversalAccountService,
  type AccountCapability,
  type ActivateCapabilityRequest,
  type CapabilityState,
  type DeactivateCapabilityRequest,
} from '../../modules/universal-account/index.ts';

export interface Harness {
  readonly service: UniversalAccountService;
  readonly repository: InMemoryUniversalAccountRepository;
}

export function build(): Harness {
  const repository = new InMemoryUniversalAccountRepository();
  return { service: new UniversalAccountService(repository), repository };
}

let sequence = 0;

function seq(): string {
  sequence += 1;
  return String(sequence).padStart(4, '0');
}

/** A stable account id, so several capabilities can be activated against one account. */
export const ACCOUNT = 'acct_01HQZUA0001';

export function activateRequest(
  overrides: Partial<ActivateCapabilityRequest> = {},
): ActivateCapabilityRequest {
  const n = seq();
  return {
    capabilityId: `cap_01HQZUA${n}`,
    accountId: ACCOUNT,
    capability: 'seller',
    attributes: {},
    activatedAt: '2026-04-01T12:00:00Z',
    createdAt: '2026-04-01T12:00:00Z',
    updatedAt: '2026-04-01T12:00:00Z',
    correlationId: `corr_01HQZUA${n}`,
    idempotencyKey: `idem_act_${n}`,
    stateId: `state_01HQZUA${n}`,
    reason: 'the account completed seller onboarding',
    ...overrides,
  };
}

export function deactivateRequest(
  capabilityId: string,
  overrides: Partial<DeactivateCapabilityRequest> = {},
): DeactivateCapabilityRequest {
  const n = seq();
  return {
    capabilityId,
    deactivatedAt: '2026-04-02T12:00:00Z',
    occurredAt: '2026-04-02T12:00:00Z',
    updatedAt: '2026-04-02T12:00:00Z',
    correlationId: `corr_01HQZUD${n}`,
    idempotencyKey: `idem_deact_${n}`,
    stateId: `state_01HQZUD${n}`,
    reason: 'the seller closed their storefront',
    ...overrides,
  };
}

export function capabilityRecord(overrides: Partial<AccountCapability> = {}): AccountCapability {
  const n = seq();
  return {
    capabilityId: `cap_01HQZUR${n}`,
    accountId: ACCOUNT,
    capability: 'buyer',
    status: 'active',
    activatedAt: '2026-04-01T12:00:00Z',
    deactivatedAt: null,
    attributes: {},
    createdAt: '2026-04-01T12:00:00Z',
    updatedAt: '2026-04-01T12:00:00Z',
    correlationId: `corr_01HQZUR${n}`,
    idempotencyKey: `idem_rec_${n}`,
    ...overrides,
  };
}

export function stateRecord(overrides: Partial<CapabilityState> = {}): CapabilityState {
  const n = seq();
  return {
    stateId: `state_01HQZUS${n}`,
    capabilityId: `cap_01HQZUS${n}`,
    accountId: ACCOUNT,
    fromStatus: null,
    toStatus: 'active',
    reason: 'activated for the first time',
    occurredAt: '2026-04-01T12:00:00Z',
    correlationId: `corr_01HQZUS${n}`,
    idempotencyKey: `idem_state_${n}`,
    ...overrides,
  };
}

/** The outbox entries of one kind, oldest first, as the relay would read them. */
export function entriesOfKind(
  repository: InMemoryUniversalAccountRepository,
  kind: 'event' | 'audit',
): readonly { readonly payload: unknown }[] {
  return repository
    .outbox()
    .entries()
    .filter((entry) => entry.kind === kind);
}
