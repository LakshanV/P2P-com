/**
 * K-09 Audit Foundation — public surface (FND-003c).
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and
 * may change without notice; see kernel/audit-foundation/CONTRACT.md for the contract this fixes.
 *
 * There is deliberately no API, no UI, no authentication implementation and no registered business
 * action. An endpoint that exposes an audit log before **K-04 Permissions** can decide who may read
 * which classification is a disclosure waiting to happen, and an action registered here on behalf
 * of a unit that does not record it would be a claim that the unit is audited when it is not.
 */

export {
  ACTOR_KINDS,
  AUDIT_OUTCOMES,
  AUTHENTICATION_METHODS,
  AuditError,
  EVIDENCE_CLASSIFICATIONS,
  REDACTED,
} from './types.ts';

export type {
  ActorKind,
  AuditActor,
  AuditErrorCode,
  AuditEvidence,
  AuditOutcome,
  AuditRecord,
  AuthenticationMethod,
  EvidenceClassification,
  EvidenceValue,
  ResourceReference,
} from './types.ts';

export {
  ACTION_AUTHORITIES,
  AuditActionRegistry,
  SECRET_FIELD_FRAGMENTS,
  SECRET_VALUE_PATTERNS,
  assertRegistrableAction,
  assertValidEvidence,
} from './registry.ts';

export type {
  ActionAuthority,
  AuditActionDefinition,
  EvidenceField,
  EvidenceFieldKind,
} from './registry.ts';

export { AuditService, fingerprintRecord } from './service.ts';
export type { RecordRequest, RecordResult } from './service.ts';

export { InMemoryAuditRepository } from './repository.ts';
export type {
  AuditCursor,
  AuditPage,
  AuditQuery,
  AuditRepository,
  AuditTransaction,
} from './repository.ts';

export {
  AUDIT_SCHEMA,
  AUDIT_TABLE,
  EnlistedAuditRepository,
  PostgresAuditRepository,
  TIMESTAMP_COLUMNS,
  decodeEvidence,
  enlistedClient,
  toRecord,
} from './postgres-repository.ts';
