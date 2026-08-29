/**
 * K-08 outbox-to-event adapter (FND-003d).
 *
 * The platform outbox relay is intentionally pure: it moves rows from module outbox tables to
 * downstream consumers without interpreting them. This adapter is the K-08 side of that boundary:
 * it accepts the payload the relay hands off and forwards it to K-08's own publication service.
 *
 * By living inside K-08 rather than inside the relay, the adapter preserves the platform/kernel
 * layering: platform code knows nothing about event types, subscriptions, or delivery policy.
 *
 * Owned by: K-08 Event Infrastructure.
 */

import type { EventPublisher } from '../../platform/outbox/relay.ts';
import type { PublishRequest } from './service.ts';
import type { EventService } from './service.ts';

export class EventServicePublisher implements EventPublisher {
  readonly #service: EventService;

  constructor(service: EventService) {
    this.#service = service;
  }

  async publish(request: unknown): Promise<unknown> {
    // The relay does not validate payloads; it only moves them. Validation happens inside K-08,
    // where the event type registry and subscription registry can refuse malformed requests.
    return this.#service.publish(request as PublishRequest);
  }
}
