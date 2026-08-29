/**
 * K-08 Event Infrastructure — public surface (FND-003b).
 *
 * Everything another unit may depend on is re-exported here. Anything not listed is internal and
 * may change without notice; see kernel/event-infrastructure/CONTRACT.md for the contract this
 * fixes.
 *
 * There is deliberately no broker SDK, no API and no UI. A broker binding before there is a single
 * real producer would be a guess dressed as infrastructure, and an endpoint that publishes events
 * before K-02 Authentication and K-04 Permissions exist is a hole rather than a feature.
 */

export {
  ACTOR_KINDS,
  DELIVERY_STATUSES,
  EVENT_ORIGINS,
  EventError,
  PERMITTED_EVENT_ORIGINS,
  TERMINAL_DELIVERY_STATUSES,
} from './types.ts';

export type {
  Actor,
  ActorKind,
  ConsumerReceipt,
  Delivery,
  DeliveryStatus,
  EventEnvelope,
  EventErrorCode,
  EventOrigin,
  EventPayload,
  JsonScalar,
} from './types.ts';

export {
  EventTypeRegistry,
  SECRET_FIELD_FRAGMENTS,
  SECRET_VALUE_PATTERNS,
  SubscriptionRegistry,
  assertRegistrableSubscription,
  assertRegistrableType,
  assertValidPayload,
} from './registry.ts';

export type {
  EventTypeDefinition,
  PayloadField,
  PayloadFieldKind,
  SubscriptionDefinition,
} from './registry.ts';

export {
  DEFAULT_RETRY_POLICY,
  EventService,
  backoffSeconds,
  fingerprintPayload,
} from './service.ts';

export type {
  DeliverRequest,
  DeliveryOutcome,
  DeliveryOutcomeKind,
  EventHandler,
  HandlerContext,
  PublishRequest,
  PublishResult,
  ReplayRequest,
  ReplayResult,
  RetryPolicy,
} from './service.ts';

export { InMemoryEventRepository } from './repository.ts';
export type { ClaimRequest, EventRepository, EventTransaction } from './repository.ts';

export { EventServicePublisher } from './outbox-publisher.ts';

export {
  DELIVERY_TABLE,
  EnlistedEventRepository,
  EVENT_SCHEMA,
  EVENT_TABLE,
  PostgresEventRepository,
  enlistedClient,
  RECEIPT_TABLE,
  TIMESTAMP_COLUMNS,
  decodePayload,
  toDelivery,
  toEnvelope,
  toReceipt,
} from './postgres-repository.ts';
