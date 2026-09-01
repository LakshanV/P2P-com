/**
 * M-03 Commerce Request — the public surface.
 *
 * Everything another unit may depend on is re-exported here; see `CONTRACT.md`.
 *
 * Owned by: M-03 Commerce Request.
 */

export {
  CAPTURE_CHANNELS,
  CommerceRequestError,
  INTERPRETATION_ORIGINS,
  MEDIA_KINDS,
  REQUEST_STATUSES,
  REQUEST_TRANSITIONS,
} from './types.ts';
export type {
  CaptureChannel,
  CommerceRequest,
  CommerceRequestErrorCode,
  InterpretationOrigin,
  MediaKind,
  RequestEvent,
  RequestInterpretation,
  RequestMedia,
  RequestStatus,
} from './types.ts';

export {
  FOREIGN_FIELDS,
  IDENTIFIER_REFUSALS,
  MAXIMUM_RAW_TEXT_LENGTH,
  MINIMUM_RATIONALE_LENGTH,
  assertCaptureChannel,
  assertCommerceRequestIdentifier,
  assertConfidence,
  assertInterpretationOrigin,
  assertMediaKind,
  assertRationale,
  assertRawText,
  assertRequestStatus,
  assertStructured,
} from './registry.ts';

export {
  STORED_ROW_NOTE,
  validateCommerceRequest,
  validateInterpretation,
  validateRequestEvent,
  validateRequestMedia,
} from './validate.ts';
export type { RecordSource } from './validate.ts';

export {
  sealCommerceRequest,
  sealCommerceRequests,
  sealInterpretation,
  sealInterpretations,
  sealRequestEvent,
  sealRequestEvents,
  sealRequestMedia,
  sealRequestMedias,
} from './immutable.ts';

export { CommerceRequestService } from './service.ts';
export type {
  AttachMediaRequest,
  AttachMediaResult,
  CaptureNeedRequest,
  CaptureNeedResult,
  InterpretRequest,
  InterpretResult,
  TransitionRequest,
  TransitionResult,
} from './service.ts';

export { InMemoryCommerceRequestRepository } from './repository.ts';
export type { CommerceRequestRepository, CommerceRequestTransaction } from './repository.ts';

export {
  NEED_CAPTURED_ACTION,
  NEED_CAPTURED_EVENT,
  NEED_CLOSED_EVENT,
  NEED_INTERPRETED_ACTION,
  NEED_INTERPRETED_EVENT,
  NEED_READY_EVENT,
  NEED_STATUS_ACTION,
} from './outbox.ts';
