/**
 * M-03 Commerce Request — the immutability boundary.
 *
 * Every record crossing a service or repository boundary is deep-frozen and copied, so a caller
 * cannot edit what was stored by holding on to what it was handed.
 *
 * It matters more here than in most modules. `rawText` is the evidence of what a customer actually
 * asked for, and `structured` is an open object a caller could otherwise reach into and change
 * without anything recording that it had. A Need whose raw text could be edited in place is a Need
 * with no evidential value at all, which removes the reason the record exists.
 *
 * Owned by: M-03 Commerce Request.
 */

import type {
  CommerceRequest,
  RequestEvent,
  RequestInterpretation,
  RequestMedia,
} from './types.ts';

/** Deep-freeze, copying as it goes, so the frozen thing shares no mutable structure with its source. */
function sealDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(sealDeep));
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = sealDeep(entry);
  return Object.freeze(copy);
}

export function sealCommerceRequest(request: CommerceRequest): CommerceRequest {
  return Object.freeze({ ...request });
}

export function sealCommerceRequests(
  requests: readonly CommerceRequest[],
): readonly CommerceRequest[] {
  return Object.freeze(requests.map(sealCommerceRequest));
}

/**
 * Freeze an interpretation, `structured` included.
 *
 * The nested freeze is the whole reason this is not a shallow copy: `structured` is an open object,
 * so a shallow freeze would hand a caller a frozen wrapper around a mutable understanding.
 */
export function sealInterpretation(interpretation: RequestInterpretation): RequestInterpretation {
  return Object.freeze({
    ...interpretation,
    structured: sealDeep(interpretation.structured) as Readonly<Record<string, unknown>>,
  });
}

export function sealInterpretations(
  interpretations: readonly RequestInterpretation[],
): readonly RequestInterpretation[] {
  return Object.freeze(interpretations.map(sealInterpretation));
}

export function sealRequestMedia(media: RequestMedia): RequestMedia {
  return Object.freeze({ ...media });
}

export function sealRequestMedias(media: readonly RequestMedia[]): readonly RequestMedia[] {
  return Object.freeze(media.map(sealRequestMedia));
}

export function sealRequestEvent(event: RequestEvent): RequestEvent {
  return Object.freeze({ ...event });
}

export function sealRequestEvents(events: readonly RequestEvent[]): readonly RequestEvent[] {
  return Object.freeze(events.map(sealRequestEvent));
}
