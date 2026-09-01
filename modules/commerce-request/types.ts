/**
 * M-03 Commerce Request — the Need, and what the platform made of it.
 *
 * The entry point of the whole product. Everything downstream — search, matching, the sourcing
 * ladder, RFQ, an order — begins with somebody saying what they want, in their own words, and JAYA
 * working out what that means.
 *
 * **The original is never overwritten.** A Need holds exactly what the person said, byte for byte,
 * and an *interpretation* is a separate record pointing at it. That separation is the single most
 * important decision in this module and it is worth being explicit about why: an interpretation is a
 * guess. It is made by a model, or by a rule, or by a person correcting one of those, and it will be
 * wrong sometimes. A design that wrote the structured result back over the raw text would destroy
 * the only evidence of what was actually asked for — so a customer disputing "I ordered the 6mm
 * one" could be shown nothing but the platform's own opinion. Append-only interpretations mean the
 * original survives every correction, every model upgrade and every re-interpretation.
 *
 * **Interpretations are versioned, and the latest wins without deleting the others.** Re-interpreting
 * a Need appends; correcting one appends. The history is what lets somebody ask "when did we start
 * thinking they meant cement rather than concrete, and what changed our mind".
 *
 * **Confidence is recorded and is never a boolean.** A Need interpreted at 0.35 and one interpreted
 * at 0.98 must not look the same to the sourcing ladder, and the only way to keep that true is to
 * carry the number rather than a threshold somebody applied once.
 *
 * Deterministic by construction: the caller supplies every identifier and every instant. Nothing
 * here reads a clock or generates randomness.
 *
 * Owned by: M-03 Commerce Request.
 */

/**
 * How a Need arrived.
 *
 * Recorded because the same words mean different things depending on how they got here: text a
 * person typed is a considered request, a voice transcript carries transcription error, and an
 * image caption is the platform's own description of a photograph. An interpreter that could not
 * tell them apart would apply the same confidence to all three.
 */
export const CAPTURE_CHANNELS = [
  'text',
  'voice',
  'image',
  'document',
  'barcode',
  'link',
  'conversation',
] as const;
export type CaptureChannel = (typeof CAPTURE_CHANNELS)[number];

/**
 * Where a Need is in its life.
 *
 * `captured` — said, and not yet understood. A Need is usable at this point: a human can read it.
 * `interpreted` — at least one interpretation exists. Still not necessarily actionable.
 * `ready` — somebody or something has accepted an interpretation as good enough to source against.
 * `sourcing` — the ladder is running: matching, RFQ, offers.
 * `fulfilled` — an order was placed against it. Terminal.
 * `cancelled` — the person no longer wants it. Terminal.
 * `expired` — nobody acted in time. Terminal, and distinct from cancelled, because "they changed
 * their mind" and "we were too slow" are different failures and only one of them is ours.
 */
export const REQUEST_STATUSES = [
  'captured',
  'interpreted',
  'ready',
  'sourcing',
  'fulfilled',
  'cancelled',
  'expired',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * The legal moves.
 *
 * A Need may be cancelled from any live state, because a person may always change their mind. It
 * may not move backwards out of a terminal state: an order placed against it is a fact, and so is a
 * cancellation.
 */
export const REQUEST_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> =
  Object.freeze<Record<RequestStatus, readonly RequestStatus[]>>({
    captured: Object.freeze(['interpreted', 'ready', 'cancelled', 'expired']),
    // Straight to `ready` is legitimate: a Need clear enough to source against needs no
    // interpretation, and requiring one would make the platform slower for the easiest cases.
    interpreted: Object.freeze(['interpreted', 'ready', 'cancelled', 'expired']),
    ready: Object.freeze(['interpreted', 'sourcing', 'cancelled', 'expired']),
    sourcing: Object.freeze(['ready', 'fulfilled', 'cancelled', 'expired']),
    fulfilled: Object.freeze([]),
    cancelled: Object.freeze([]),
    expired: Object.freeze([]),
  });

/**
 * Who or what produced an interpretation.
 *
 * `model` — an AI, through K-13. Never authoritative on its own.
 * `rule` — deterministic parsing. A catalogue code, a barcode, a structured form.
 * `human` — a person, which in practice means the customer correcting a guess. Outranks both.
 *
 * The distinction is load-bearing rather than decorative: v3 §38 says AI may propose and never
 * assert, and an interpretation whose origin nobody recorded is an interpretation nobody can hold
 * to that rule.
 */
export const INTERPRETATION_ORIGINS = ['model', 'rule', 'human'] as const;
export type InterpretationOrigin = (typeof INTERPRETATION_ORIGINS)[number];

/** Kinds of attachment a Need may carry. Mirrors M-04's media vocabulary deliberately. */
export const MEDIA_KINDS = ['image', 'video', 'audio', 'document'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * What somebody asked for, as they asked for it.
 *
 * The `rawText` field is the point of this record. Everything else is bookkeeping around it.
 */
export interface CommerceRequest {
  /** Caller-supplied opaque and stable identifier. */
  readonly requestId: string;
  /** The K-03 account that asked. Not a foreign key. */
  readonly accountId: string;
  /** How it arrived. */
  readonly channel: CaptureChannel;
  /**
   * **Exactly what the person said, byte for byte.**
   *
   * Not normalised, not trimmed of meaning, not corrected for spelling, and never rewritten by an
   * interpretation. This is the evidence of what was actually asked for, and a dispute six months
   * from now is judged against it rather than against what the platform decided it meant.
   *
   * Deliberately **not** subject to the opaque-identifier rule that governs every id in this
   * repository. That rule exists to stop a person's telephone number becoming a primary key; this
   * is a sentence a person wrote, and a Need that reads "call me on 0771234567 about the cement" is
   * a Need, not a leak. The consequence is real and is accepted: raw text may contain personal
   * data, so it is classified accordingly in the outbox and is not published in events.
   */
  readonly rawText: string;
  /** The K-12 conversation this arrived in, when it did. Opaque; never joined to. */
  readonly conversationId: string | null;
  readonly status: RequestStatus;
  /** The interpretation currently taken as the working understanding, or null. */
  readonly currentInterpretationId: string | null;
  readonly capturedAt: string;
  readonly updatedAt: string;
  /** When the asker wants it by, if they said. Opaque to this module; the ladder reads it. */
  readonly neededBy: string | null;
  readonly closedAt: string | null;
  /** Why it ended, for a terminal status. Null while live. */
  readonly closureReason: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * One reading of what a Need means.
 *
 * Append-only, and never edited. A better reading is a **new** interpretation, so the sequence of
 * them is a record of how the platform's understanding changed and who changed it.
 */
export interface RequestInterpretation {
  /** Caller-supplied opaque and stable identifier. */
  readonly interpretationId: string;
  readonly requestId: string;
  /** 1 for the first, incrementing. Unique per request. */
  readonly version: number;
  readonly origin: InterpretationOrigin;
  /**
   * How sure this reading is, from 0 to 1, as a **per-mille integer** (0..1000).
   *
   * An integer because this repository holds no floating-point value anywhere: a confidence stored
   * as a double is a confidence that compares unequal to itself across a round trip, and thresholds
   * built on it drift. Per-mille is finer than anybody can justify and coarse enough to be exact.
   */
  readonly confidencePerMille: number;
  /**
   * What was understood: quantities, units, attributes, a place, a deadline.
   *
   * Deliberately an open object rather than a fixed shape. A Need can be for cement, a haircut, a
   * lorry or a legal opinion, and a schema that could express all four would express none of them
   * well. The sourcing ladder reads the keys it knows and ignores the rest.
   */
  readonly structured: Readonly<Record<string, unknown>>;
  /**
   * The K-13 run that produced it, for a `model` interpretation. Null otherwise.
   *
   * Opaque, and not a foreign key: K-13 is a kernel component and this is the handle it gave back.
   * It is what makes a wrong interpretation traceable to the model and prompt that produced it.
   */
  readonly aiRunId: string | null;
  /**
   * Why this interpretation exists, in one line.
   *
   * Required, including for a model. "The customer said 6mm, not 6cm" and "re-interpreted after the
   * catalogue was extended" are the difference between a history somebody can read and a list of
   * timestamps.
   */
  readonly rationale: string;
  /** The interpretation this one corrects, when it corrects one. Null for a first reading. */
  readonly supersedesInterpretationId: string | null;
  readonly interpretedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * One attachment.
 *
 * M-03 stores an **opaque reference** and never the artefact, exactly as M-04 does for listing
 * media and M-02 does for evidence. A photograph of a broken part is personal data and a URL is a
 * natural key; neither belongs in a business module's table.
 */
export interface RequestMedia {
  readonly mediaId: string;
  readonly requestId: string;
  readonly kind: MediaKind;
  /** Opaque handle to the artefact held by another system. */
  readonly reference: string;
  readonly position: number;
  /** What the person said about it, or what the platform saw in it. May be empty. */
  readonly caption: string;
  readonly addedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/** One recorded status change, so how a Need reached its state is readable. */
export interface RequestEvent {
  readonly eventId: string;
  readonly requestId: string;
  readonly fromStatus: RequestStatus | null;
  readonly toStatus: RequestStatus;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export type CommerceRequestErrorCode =
  /** An identifier is not well formed. */
  | 'malformed-identifier'
  /** An identifier looks like a natural key. */
  | 'natural-identifier'
  /** An identifier names or looks like a credential. */
  | 'secret-bearing-input'
  /** The instant is not a real UTC instant. */
  | 'malformed-instant'
  /** A request carried a field belonging to another component. */
  | 'foreign-concern'
  /** A stored row, or a candidate record, is not what this component writes. */
  | 'malformed-record'
  /** The idempotency key was already used for a different record. */
  | 'idempotency-key-reuse'
  /** A request id already exists with different content. */
  | 'duplicate-request-id'
  /** An interpretation id already exists with different content. */
  | 'duplicate-interpretation-id'
  /** A media id already exists with different content. */
  | 'duplicate-media-id'
  /** No such Need. */
  | 'request-not-found'
  /** No such interpretation. */
  | 'interpretation-not-found'
  /** The capture channel is not one M-03 recognises. */
  | 'unknown-channel'
  /** The status is not one M-03 recognises. */
  | 'unknown-status'
  /** The interpretation origin is not one M-03 recognises. */
  | 'unknown-origin'
  /** The media kind is not one M-03 recognises. */
  | 'unknown-media-kind'
  /** The move is not permitted from where the Need is. */
  | 'illegal-transition'
  /** The Need has ended and refuses further change. */
  | 'request-closed'
  /** The raw text is empty, or longer than M-03 will store. */
  | 'malformed-raw-text'
  /** The confidence is outside 0..1000, or is not an integer. */
  | 'malformed-confidence'
  /** A required explanation is missing or too short to be one. */
  | 'malformed-rationale'
  /** The structured interpretation is not a JSON object. */
  | 'malformed-structured'
  /** The caption or reference is malformed. */
  | 'malformed-media';

export class CommerceRequestError extends Error {
  readonly code: CommerceRequestErrorCode;

  constructor(code: CommerceRequestErrorCode, message: string) {
    super(message);
    this.name = 'CommerceRequestError';
    this.code = code;
  }
}
