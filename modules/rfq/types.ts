/**
 * M-09 RFQ — asking the market, once every other way has been tried.
 *
 * An RFQ is what JAYA does when it could not solve a Need itself. That ordering is the product: by
 * the time a tender exists, the catalogue has been searched, the buyer's own suppliers have been
 * asked, the verified network has been checked and any external discovery has run. A platform that
 * starts here is a notice board.
 *
 * **The customer's words never reach a supplier.** This is the single most important rule in the
 * module. A Need is a sentence somebody wrote — deliberately exempt from the identifier rules,
 * possibly holding a telephone number, an address, a grievance about a competitor, or a hint about
 * what they are willing to pay. What a supplier receives is a **specification**: the structured
 * facts they need to quote, and nothing else. M-03 keeps the words; M-09 carries the requirement.
 *
 * **An invitation is to a named supplier, and only a qualified one.** The whole ladder exists to
 * decide who should be asked, so an RFQ that broadcast would throw that work away. Every invitation
 * records **why** that supplier was invited, because a supplier receiving an irrelevant tender is
 * how a platform trains people to ignore it.
 *
 * **A tender that closes is closed.** An offer cannot arrive after the closing instant, an award
 * cannot be made twice, and a cancelled RFQ cannot be reopened. Each of those is somebody's money or
 * somebody's afternoon.
 *
 * Deterministic: the caller supplies every identifier and every instant.
 *
 * Owned by: M-09 RFQ.
 */

/**
 * Where a tender is in its life.
 *
 * `open` — suppliers may quote.
 * `closed` — the window has passed. Offers already made stand; no new one is accepted.
 * `awarded` — one offer was chosen and the rest were not. Terminal.
 * `cancelled` — the buyer withdrew it. Terminal.
 *
 * `closed` is deliberately distinct from `awarded`: a tender that attracted three offers and was
 * never decided is a different failure from one that was decided, and only the first is the
 * platform's fault.
 */
export const RFQ_STATUSES = ['open', 'closed', 'awarded', 'cancelled'] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

export const RFQ_TRANSITIONS: Readonly<Record<RfqStatus, readonly RfqStatus[]>> = Object.freeze<
  Record<RfqStatus, readonly RfqStatus[]>
>({
  open: Object.freeze(['closed', 'awarded', 'cancelled']),
  // A closed tender may still be awarded: the window is for *quoting*, and a buyer deciding the
  // morning after should not have to reopen anything.
  closed: Object.freeze(['awarded', 'cancelled']),
  awarded: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/**
 * How visible an RFQ is.
 *
 * `private` — only invited suppliers see it. The default, and the one the ladder produces: the
 *   ladder has already decided who should be asked, and widening that silently would waste the work.
 * `network` — any verified supplier in the category may quote. A buyer's explicit choice to cast
 *   wider, made by them rather than inferred by us.
 */
export const RFQ_VISIBILITIES = ['private', 'network'] as const;
export type RfqVisibility = (typeof RFQ_VISIBILITIES)[number];

/** Whether a supplier may offer something other than exactly what was asked for. */
export const SUBSTITUTION_POLICIES = [
  /** Exactly this. A substitute is not an answer. */
  'none',
  /** Something equivalent is acceptable, and the supplier must say what differs. */
  'equivalent-with-disclosure',
  /** The buyer will consider anything close, and will judge for themselves. */
  'open',
] as const;
export type SubstitutionPolicy = (typeof SUBSTITUTION_POLICIES)[number];

/**
 * What a supplier is being asked to quote for.
 *
 * Every field here is a **requirement**, derived from M-03's structured reading. None of it is the
 * customer's prose, and there is deliberately no field in which prose could hide: `notes` is absent
 * on purpose, because a free-text box is where a Need's raw sentence ends up being pasted the first
 * time somebody is in a hurry.
 */
export interface RfqSpecification {
  /** What is wanted, as an opaque category code. */
  readonly category: string;
  /** A short, supplier-facing description of the item. Written for a supplier, not copied. */
  readonly itemDescription: string;
  readonly quantity: bigint;
  /** The unit the quantity is in: tonne, box, hour, licence. */
  readonly unit: string;
  /**
   * The specification a supplier must meet: grade, size, voltage, standard.
   *
   * Structured rather than prose, so a supplier can filter on it and a comparison can be made
   * between two offers that answered the same question.
   */
  readonly attributes: Readonly<Record<string, string>>;
  /** Where it must go, as an opaque district code. */
  readonly deliveryDistrict: string | null;
  /** When it is needed by, as a UTC instant. */
  readonly requiredBy: string | null;
  /** `new`, `refurbished`, `used`, or whatever the category means by condition. */
  readonly condition: string | null;
  /** Quality requirements a supplier must meet: a certification, a standard, an inspection. */
  readonly qualityRequirements: readonly string[];
  readonly substitutionPolicy: SubstitutionPolicy;
  /**
   * Opaque references to artefacts a supplier may need: a drawing, a photograph, a datasheet.
   *
   * References only. M-09 stores no artefact, and a supplier fetches one through a route that can
   * check whether they were invited.
   */
  readonly attachmentReferences: readonly string[];
}

/** One tender. */
export interface Rfq {
  readonly rfqId: string;
  /** The M-03 Need this came from. Opaque; the words stay there. */
  readonly requestId: string;
  /** The buyer. */
  readonly accountId: string;
  /**
   * The M-07 run that decided this Need could not be solved without asking.
   *
   * Recorded because it is the justification: it names every rung that was tried and why each one
   * did not answer. An RFQ nobody can justify is one a supplier is entitled to resent.
   */
  readonly matchRunId: string | null;
  readonly status: RfqStatus;
  readonly visibility: RfqVisibility;
  readonly specification: RfqSpecification;
  /** After this instant no new offer is accepted. */
  readonly closesAt: string;
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  /** The offer that won, once one has. Opaque: M-10 owns the quote. */
  readonly awardedQuoteId: string | null;
  readonly closureReason: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/**
 * One supplier asked to quote.
 *
 * Append-only. Uninviting somebody is not a thing: they have already seen it, and pretending
 * otherwise would make the record disagree with what happened.
 */
export interface RfqInvitation {
  readonly invitationId: string;
  readonly rfqId: string;
  readonly supplierAccountId: string;
  /**
   * Which rung of the ladder found them, when one did.
   *
   * Null for a supplier the buyer named themselves, which is a legitimate case and a different one.
   */
  readonly sourceRung: string | null;
  /**
   * Why this supplier was invited, in words.
   *
   * Required. A supplier receiving an irrelevant tender is how a platform trains people to ignore
   * it, so every invitation has to be able to answer "why me".
   */
  readonly reason: string;
  /** The M-07 candidate score behind the invitation, where there was one. */
  readonly scorePerMille: number | null;
  readonly invitedAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

/** One recorded status change. */
export interface RfqEvent {
  readonly eventId: string;
  readonly rfqId: string;
  readonly fromStatus: RfqStatus | null;
  readonly toStatus: RfqStatus;
  readonly reason: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
}

export type RfqErrorCode =
  | 'malformed-identifier'
  | 'natural-identifier'
  | 'secret-bearing-input'
  | 'malformed-instant'
  | 'foreign-concern'
  | 'malformed-record'
  | 'idempotency-key-reuse'
  | 'duplicate-rfq-id'
  | 'duplicate-invitation'
  | 'rfq-not-found'
  | 'unknown-status'
  | 'unknown-visibility'
  | 'unknown-substitution-policy'
  | 'illegal-transition'
  | 'rfq-closed'
  | 'malformed-specification'
  | 'malformed-reason'
  /** The RFQ would carry the customer's own words to a supplier. */
  | 'private-text-in-specification';

export class RfqError extends Error {
  readonly code: RfqErrorCode;

  constructor(code: RfqErrorCode, message: string) {
    super(message);
    this.name = 'RfqError';
    this.code = code;
  }
}
