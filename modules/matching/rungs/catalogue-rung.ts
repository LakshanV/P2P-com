/**
 * The catalogue rung: what JAYA can already sell you.
 *
 * The first and cheapest answer to "I need X", and the one that decides whether the platform feels
 * like a shop or a request board. If the cement is on a shelf forty kilometres away, this rung finds
 * it and the customer never learns that an RFQ was possible.
 *
 * **It searches the interpretation, not the words.** M-03's structured reading — commodity, grade,
 * quantity, district — is what a rung is given. The raw text is a sentence a customer wrote and may
 * hold their telephone number; it is deliberately exempt from the identifier rules, and it does not
 * leave M-03.
 *
 * **Availability is checked, not assumed, and only where it means something.** A `tracked` listing
 * with nothing on the shelf is not a match, however well its title scores — offering it produces an
 * order that cannot be fulfilled, which is worse than offering nothing. But a `made-to-order` part
 * or a `digital` entitlement holds no stock **by design**, and demanding availability from those
 * would make the platform unable to sell most of what it exists to sell. So the check follows
 * `requiresReservation`, which is M-04's answer to the only question this rung has.
 *
 * **An `external` listing is scored but capped.** Supplier-direct stock is real, and JAYA does not
 * hold its ledger — so the platform cannot promise it the way it can promise its own shelf. Capping
 * rather than excluding is the honest middle: it can still win when nothing else comes close, and it
 * loses to an equally good listing the platform can actually see.
 *
 * **Finding nothing and failing to look are different returns.** An empty array means the catalogue
 * was searched and holds no answer. A throw means the catalogue could not be searched, and the
 * ladder records that separately — because a broken index that looks like an absence of supply turns
 * every Need into an RFQ and nobody finds out.
 *
 * Owned by: M-07 Matching.
 */

import {
  requiresReservation,
  type InventoryMode,
  type ListingVersion,
  type UniversalListingService,
} from '../../universal-listing/index.ts';
import type { RungCandidate, SourcingQuery, SourcingRungPort } from '../ports.ts';

/**
 * What the rung can read.
 *
 * A narrow port onto M-04 rather than the whole service, so this file cannot quietly start
 * publishing listings or moving stock. `searchVersions` is the one thing it needs that M-04 does not
 * yet offer as a single call, and it is supplied by the application from what M-04 does offer.
 */
export interface CatalogueSource {
  /**
   * Current, published versions plausibly relevant to a structured Need.
   *
   * Deliberately loose: this is a **recall** step, and the scoring below is the precision step.
   * A source that pre-filtered aggressively would hide near misses from the explanation, and the
   * near miss is exactly what a customer wants to see when nothing matched exactly.
   */
  searchVersions(query: SourcingQuery): Promise<readonly CatalogueEntry[]>;
}

/** One published version, with the account that owns it. */
export interface CatalogueEntry {
  readonly version: ListingVersion;
  /** The K-03 account that supplies it. M-04 holds this on the listing, not the version. */
  readonly supplierAccountId: string;
}

export interface CatalogueRungOptions {
  readonly source: CatalogueSource;
  /** M-04, for the availability check on a tracked listing. */
  readonly listings: Pick<UniversalListingService, 'getAvailability'>;
  /**
   * The most an `external` listing may score.
   *
   * 850 by default: high enough to win when the platform's own shelf holds nothing close, low enough
   * to lose to an equally good listing whose stock JAYA can actually see.
   */
  readonly externalCeilingPerMille?: number;
}

const DEFAULT_EXTERNAL_CEILING = 850;

/**
 * How much of the score each part of a match is worth.
 *
 * Weights rather than a single opaque number, so an explanation can name what actually drove the
 * score — "same commodity and grade, right district, in stock" is a sentence a customer can argue
 * with, and "0.86" is not.
 *
 * They sum to 1000. Commodity dominates because getting the *thing* wrong is not a near miss; it is
 * a different order.
 */
const WEIGHTS = Object.freeze({
  commodity: 500,
  attributes: 200,
  quantity: 150,
  place: 100,
  freshness: 50,
});

export function catalogueRung(options: CatalogueRungOptions): SourcingRungPort {
  const ceiling = options.externalCeilingPerMille ?? DEFAULT_EXTERNAL_CEILING;

  return {
    async find(query: SourcingQuery): Promise<readonly RungCandidate[]> {
      // A throw here propagates: the ladder records `lookup-failed`, which is the honest answer when
      // the catalogue could not be searched. Catching it and returning `[]` would report an absence
      // of supply that nobody established.
      const entries = await options.source.searchVersions(query);

      const candidates: RungCandidate[] = [];
      for (const entry of entries) {
        const scored = await scoreEntry(entry, query, options, ceiling);
        if (scored !== null) candidates.push(scored);
      }
      return candidates;
    },
  };
}

async function scoreEntry(
  entry: CatalogueEntry,
  query: SourcingQuery,
  options: CatalogueRungOptions,
  ceiling: number,
): Promise<RungCandidate | null> {
  const version = entry.version;
  const wanted = readNeed(query.structured);

  const commodity = scoreCommodity(version, wanted);
  // A different commodity is not a near miss; it is a different order. Nothing else can rescue it,
  // so the rest of the scoring is not even computed.
  if (commodity === 0) return null;

  const attributes = scoreAttributes(version, wanted);
  const place = scorePlace(version, wanted);
  const freshness = WEIGHTS.freshness;

  // Availability is a fact about the world, so it is established before the score is finished
  // rather than assumed from the listing's own `quantityAvailable`, which is what the seller said
  // when they published.
  const availability = await establishAvailability(entry, wanted, options);
  if (availability === null) return null;

  const raw = commodity + attributes + availability.quantityScore + place + freshness;
  const capped = version.inventoryMode === 'external' ? Math.min(raw, ceiling) : raw;
  const score = Math.max(0, Math.min(1000, capped));

  return {
    kind: 'listing',
    listingId: version.listingId,
    versionId: version.versionId,
    supplierAccountId: entry.supplierAccountId,
    scorePerMille: score,
    explanation: explain(version, wanted, availability, commodity, place, capped !== raw),
    evidence: {
      inventoryMode: version.inventoryMode,
      commodityScore: commodity,
      attributeScore: attributes,
      quantityScore: availability.quantityScore,
      placeScore: place,
      availableQuantity: availability.available === null ? null : String(availability.available),
      quantityWanted: wanted.quantity === null ? null : String(wanted.quantity),
      externalCeilingApplied: capped !== raw,
      unitPriceMinor: String(version.unitPriceMinor),
      currency: version.currency,
    },
  };
}

/** What a Need asked for, as much of it as this rung understands. */
interface WantedFrom {
  readonly commodity: string | null;
  readonly quantity: bigint | null;
  readonly district: string | null;
  readonly attributes: Readonly<Record<string, string>>;
}

function readNeed(structured: Readonly<Record<string, unknown>>): WantedFrom {
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(structured)) {
    // The four keys below are read explicitly. Everything else that is a scalar becomes an attribute
    // to match against the listing, so a Need naming a grade, a colour or a voltage is not ignored
    // merely because this rung has never heard of it.
    if (['commodity', 'quantity', 'district', 'unit'].includes(key)) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attributes[key] = String(value).toLowerCase();
    }
  }

  return {
    commodity: readText(structured.commodity),
    quantity: readQuantity(structured.quantity),
    district: readText(structured.district),
    attributes: Object.freeze(attributes),
  };
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;
}

function readQuantity(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

/**
 * Does this listing sell the thing that was asked for?
 *
 * A Need with no commodity in its reading scores the full weight rather than zero: the reading is
 * poor, not the listing, and penalising every listing equally would only mean the rung finds nothing
 * and the Need escalates for the wrong reason.
 */
function scoreCommodity(version: ListingVersion, wanted: WantedFrom): number {
  if (wanted.commodity === null) return WEIGHTS.commodity;

  const haystack = `${version.title} ${version.description}`.toLowerCase();
  if (haystack.includes(wanted.commodity)) return WEIGHTS.commodity;

  // Every word of a multi-word commodity present somewhere, in any order. "portland cement" matches
  // "cement, ordinary portland", which a substring test would miss for no good reason.
  const words = wanted.commodity.split(/\s+/).filter((word) => word.length > 2);
  if (words.length > 1 && words.every((word) => haystack.includes(word))) {
    return Math.round(WEIGHTS.commodity * 0.9);
  }
  return 0;
}

function scoreAttributes(version: ListingVersion, wanted: WantedFrom): number {
  const asked = Object.entries(wanted.attributes);
  // Nothing specific was asked for, so nothing specific can be wrong.
  if (asked.length === 0) return WEIGHTS.attributes;

  const listing = version.attributes;
  const haystack = `${version.title} ${version.description}`.toLowerCase();

  let met = 0;
  for (const [key, value] of asked) {
    // Compared only when the listing holds a scalar there. An object-valued attribute is not
    // comparable to a string, and stringifying one produces "[object Object]" — which matches
    // nothing and looks exactly like an honest mismatch, so the near miss would be a lie.
    const held = listing[key];
    if (
      (typeof held === 'string' || typeof held === 'number' || typeof held === 'boolean') &&
      String(held).toLowerCase() === value
    ) {
      met += 1;
      continue;
    }
    // A listing that does not carry the attribute as data may still say so in its description. A
    // seller writing "OPC 43 grade" in the title has answered the question.
    if (haystack.includes(value)) met += 1;
  }
  return Math.round((WEIGHTS.attributes * met) / asked.length);
}

function scorePlace(version: ListingVersion, wanted: WantedFrom): number {
  if (wanted.district === null) return WEIGHTS.place;
  const held = version.attributes.district;
  if (typeof held === 'string' && held.toLowerCase() === wanted.district) return WEIGHTS.place;
  if (`${version.title} ${version.description}`.toLowerCase().includes(wanted.district)) {
    return WEIGHTS.place;
  }
  // Wrong district is a real cost and not a disqualification: somebody may deliver.
  return 0;
}

interface Availability {
  /** What M-04 says is available, or null when this mode holds no JAYA stock. */
  readonly available: bigint | null;
  readonly quantityScore: number;
  readonly note: string;
}

/**
 * Establish whether this listing can actually supply what was asked for.
 *
 * Returns null to **exclude** the candidate entirely. That happens only for a tracked listing with
 * insufficient stock, because offering one produces an order nobody can fulfil — which costs the
 * customer more than seeing nothing would.
 */
async function establishAvailability(
  entry: CatalogueEntry,
  wanted: WantedFrom,
  options: CatalogueRungOptions,
): Promise<Availability | null> {
  const mode: InventoryMode = entry.version.inventoryMode;

  if (!requiresReservation(mode)) {
    // No JAYA stock by design. A service, a made-to-order part, a supplier-direct machine or a
    // digital entitlement. Demanding availability here would make the platform unable to sell most
    // of what it exists to sell.
    return {
      available: null,
      quantityScore: WEIGHTS.quantity,
      note: noteForMode(mode),
    };
  }

  const availability = await options.listings.getAvailability(
    entry.version.listingId,
    entry.version.versionId,
  );

  if (wanted.quantity === null) {
    // No quantity was asked for, so any stock at all is enough to be worth offering.
    return availability.available > 0n
      ? { available: availability.available, quantityScore: WEIGHTS.quantity, note: 'in stock' }
      : null;
  }

  if (availability.available >= wanted.quantity) {
    return {
      available: availability.available,
      quantityScore: WEIGHTS.quantity,
      note: `${String(availability.available)} available, ${String(wanted.quantity)} wanted`,
    };
  }

  // Not enough. Excluded rather than scored down: a tracked listing that cannot supply the quantity
  // produces an order that cannot be fulfilled, and an unfulfillable order is worse for the customer
  // than an honest escalation.
  return null;
}

function noteForMode(mode: InventoryMode): string {
  switch (mode) {
    case 'untracked':
      return 'a service, so there is no stock to hold';
    case 'made-to-order':
      return 'made after the order, so nothing is held now';
    case 'digital':
      return 'a digital entitlement, so there is no physical stock';
    case 'external':
      return 'supplier-direct stock, which JAYA does not hold the ledger for';
    default:
      return 'no stock is held for this kind of offer';
  }
}

/**
 * Why this candidate scored what it did, in words a customer could read.
 *
 * "score: 0.86" tells the person deciding whether to spend money nothing at all. This says what
 * matched, what did not, and — for an external listing — that the platform cannot see the stock
 * itself.
 */
function explain(
  version: ListingVersion,
  wanted: WantedFrom,
  availability: Availability,
  commodityScore: number,
  placeScore: number,
  capped: boolean,
): string {
  const parts: string[] = [];

  parts.push(
    commodityScore === WEIGHTS.commodity
      ? `"${version.title}" matches what you asked for`
      : `"${version.title}" is a close match for what you asked for`,
  );

  const askedAttributes = Object.keys(wanted.attributes);
  if (askedAttributes.length > 0) {
    parts.push(`checked against ${askedAttributes.join(', ')}`);
  }

  if (wanted.district !== null) {
    parts.push(
      placeScore > 0 ? `listed in ${wanted.district}` : `not listed in ${wanted.district}`,
    );
  }

  parts.push(availability.note);

  if (capped) {
    parts.push(
      'scored below an equivalent listing JAYA stocks itself, because this supplier holds the stock',
    );
  }

  return parts.join('; ');
}
