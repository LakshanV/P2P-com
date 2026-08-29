/**
 * K-09 outbox-to-audit adapter (FND-003d).
 *
 * The platform outbox relay is intentionally pure: it moves rows from module outbox tables to
 * downstream consumers without interpreting them. This adapter is the K-09 side of that boundary:
 * it accepts the payload the relay hands off and forwards it to K-09's own recording service.
 *
 * By living inside K-09 rather than inside the relay, the adapter preserves the platform/kernel
 * layering: platform code knows nothing about audit actions, evidence classifications, or
 * fingerprinting.
 *
 * Owned by: K-09 Audit Foundation.
 */

import type { AuditRecorder } from '../../platform/outbox/relay.ts';
import type { AuditService, RecordRequest } from './service.ts';

export class AuditServiceRecorder implements AuditRecorder {
  readonly #service: AuditService;

  constructor(service: AuditService) {
    this.#service = service;
  }

  async record(request: unknown): Promise<unknown> {
    // The relay does not validate payloads; it only moves them. Validation happens inside K-09,
    // where the action registry can refuse malformed requests.
    return this.#service.record(request as RecordRequest);
  }
}
