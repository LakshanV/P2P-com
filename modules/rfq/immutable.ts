/**
 * M-09 RFQ — the immutability boundary.
 *
 * A specification's `attributes` is an open map and `qualityRequirements` an array, so a shallow
 * freeze would hand a caller a frozen wrapper around a mutable requirement. What a supplier was
 * asked to meet is the thing a dispute is judged against, so it is frozen all the way down.
 *
 * Owned by: M-09 RFQ.
 */

import type { Rfq, RfqEvent, RfqInvitation, RfqSpecification } from './types.ts';

function sealDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(sealDeep));
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = sealDeep(entry);
  return Object.freeze(copy);
}

export function sealSpecification(specification: RfqSpecification): RfqSpecification {
  return Object.freeze({
    ...specification,
    attributes: sealDeep(specification.attributes) as Readonly<Record<string, string>>,
    qualityRequirements: Object.freeze([...specification.qualityRequirements]),
    attachmentReferences: Object.freeze([...specification.attachmentReferences]),
  });
}

export function sealRfq(rfq: Rfq): Rfq {
  return Object.freeze({ ...rfq, specification: sealSpecification(rfq.specification) });
}

export function sealRfqs(rfqs: readonly Rfq[]): readonly Rfq[] {
  return Object.freeze(rfqs.map(sealRfq));
}

export function sealInvitation(invitation: RfqInvitation): RfqInvitation {
  return Object.freeze({ ...invitation });
}

export function sealInvitations(invitations: readonly RfqInvitation[]): readonly RfqInvitation[] {
  return Object.freeze(invitations.map(sealInvitation));
}

export function sealRfqEvent(event: RfqEvent): RfqEvent {
  return Object.freeze({ ...event });
}

export function sealRfqEvents(events: readonly RfqEvent[]): readonly RfqEvent[] {
  return Object.freeze(events.map(sealRfqEvent));
}
