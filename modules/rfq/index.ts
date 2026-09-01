/**
 * M-09 RFQ — the public surface.
 *
 * Owned by: M-09 RFQ.
 */

export {
  RFQ_STATUSES,
  RFQ_TRANSITIONS,
  RFQ_VISIBILITIES,
  RfqError,
  SUBSTITUTION_POLICIES,
} from './types.ts';
export type {
  Rfq,
  RfqErrorCode,
  RfqEvent,
  RfqInvitation,
  RfqSpecification,
  RfqStatus,
  RfqVisibility,
  SubstitutionPolicy,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  MAXIMUM_ITEM_DESCRIPTION_LENGTH,
  MINIMUM_REASON_LENGTH,
  assertNoPrivateText,
  assertReason,
  assertRfqIdentifier,
  assertRfqStatus,
  assertSubstitutionPolicy,
  assertVisibility,
} from './registry.ts';

export {
  STORED_ROW_NOTE,
  validateInvitation,
  validateRfq,
  validateRfqEvent,
  validateSpecification,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export {
  sealInvitation,
  sealInvitations,
  sealRfq,
  sealRfqEvent,
  sealRfqEvents,
  sealRfqs,
  sealSpecification,
} from './immutable.ts';

export { buildSpecification, carriedKeys } from './specification-builder.ts';
export type { BuildSpecificationOptions } from './specification-builder.ts';

export { RfqService } from './service.ts';
export type {
  AwardRfqRequest,
  CloseRfqRequest,
  InviteSupplierRequest,
  InviteSupplierResult,
  OpenRfqRequest,
  OpenRfqResult,
  RfqTransitionResult,
} from './service.ts';

export { InMemoryRfqRepository } from './repository.ts';
export type { RfqRepository, RfqTransaction } from './repository.ts';

export {
  INVITATION_ACTION,
  RFQ_ACTION,
  RFQ_AWARDED_EVENT,
  RFQ_CANCELLED_EVENT,
  RFQ_CLOSED_EVENT,
  RFQ_CREATED_EVENT,
  SUPPLIER_INVITED_EVENT,
} from './outbox.ts';
