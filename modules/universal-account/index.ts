/**
 * M-01 Universal Account — public surface.
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and may
 * change without notice.
 *
 * M-01 owns which capabilities an account holds. It depends on the platform substrate and K-03
 * Accounts (for identifier rules and the account reference). It does not import any other business
 * module.
 *
 * Owned by: M-01 Universal Account.
 */

export {
  CAPABILITIES,
  CAPABILITY_STATUSES,
  UniversalAccountError,
  type AccountCapability,
  type Capability,
  type CapabilityState,
  type CapabilityStatus,
  type UniversalAccountErrorCode,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  assertCapability,
  assertStatus,
  assertUniversalAccountIdentifier,
} from './registry.ts';

export {
  isAccountCapabilitySealed,
  isCapabilityStateSealed,
  sealAccountCapabilities,
  sealAccountCapability,
  sealCapabilityState,
  sealCapabilityStates,
} from './immutable.ts';

export { validateAccountCapability, validateCapabilityState } from './validate.ts';
export type { RecordSource } from './validate.ts';

export { UniversalAccountService } from './service.ts';
export type {
  ActivateCapabilityRequest,
  ActivateCapabilityResult,
  DeactivateCapabilityRequest,
  DeactivateCapabilityResult,
} from './service.ts';

export { InMemoryUniversalAccountRepository } from './repository.ts';
export type { UniversalAccountRepository, UniversalAccountTransaction } from './repository.ts';

export {
  ACCOUNT_CAPABILITY_TABLE,
  CAPABILITY_STATE_TABLE,
  EnlistedUniversalAccountRepository,
  OUTBOX_TABLE,
  PostgresUniversalAccountRepository,
  TIMESTAMP_COLUMNS,
  UNIVERSAL_ACCOUNT_SCHEMA,
  enlistedClient,
  toAccountCapability,
  toCapabilityState,
} from './postgres-repository.ts';

export {
  CAPABILITY_ACTIVATED_ACTION,
  CAPABILITY_ACTIVATED_EVENT,
  CAPABILITY_DEACTIVATED_ACTION,
  CAPABILITY_DEACTIVATED_EVENT,
  makeCapabilityActivatedAction,
  makeCapabilityActivatedEvent,
  makeCapabilityDeactivatedAction,
  makeCapabilityDeactivatedEvent,
} from './outbox.ts';
