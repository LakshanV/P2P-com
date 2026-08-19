/**
 * K-03 Accounts — public surface (FND-004b).
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and
 * may change without notice; see kernel/accounts/CONTRACT.md for the contract this fixes.
 *
 * **One universal account per party, carrying no capability.** That is the whole component. There
 * is no login, no session, no role, no capability activation, no verification level, no profile
 * field and no balance — each belongs to a component named in `FOREIGN_FIELDS`, and a request
 * carrying one is refused by name rather than ignored.
 *
 * K-03 is the **first real consumer of K-01**: it asks, through K-01's public contract and nothing
 * else, whether the subject an account names actually exists. There is no foreign key into
 * `kernel_identity` and no SQL that reaches it — see subject-lookup.ts for why that is a decision
 * rather than an omission.
 *
 * **No unit opens an account yet.** This slice delivers the mechanism; registration — a K-01
 * subject and a K-03 account created in one transaction through both enlisted paths — is a deferred
 * integration, not a missing dependency.
 */

export {
  AccountError,
  ORIGIN_KINDS,
  type AccountErrorCode,
  type AccountOrigin,
  type OriginKind,
  type UniversalAccount,
} from './types.ts';

export { FOREIGN_FIELDS, IDENTITY_REFUSALS, assertAccountIdentifier } from './registry.ts';

export { isSealed, sealAccount, sealAccounts, sealOrigin } from './immutable.ts';

export { validateAccount } from './validate.ts';
export type { AccountSource } from './validate.ts';

export { NO_SUBJECTS } from './subject-lookup.ts';
export type { SubjectLookup } from './subject-lookup.ts';

export { AccountService } from './service.ts';
export type { OpenAccountRequest, OpenAccountResult } from './service.ts';

export { InMemoryAccountRepository } from './repository.ts';
export type { AccountRepository, AccountTransaction } from './repository.ts';

export {
  ACCOUNT_SCHEMA,
  ACCOUNT_TABLE,
  EnlistedAccountRepository,
  PostgresAccountRepository,
  TIMESTAMP_COLUMNS,
  enlistedClient,
  toAccount,
} from './postgres-repository.ts';
