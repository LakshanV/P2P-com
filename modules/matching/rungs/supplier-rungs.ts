/**
 * The two supplier rungs: who has probably got this, and who else might.
 *
 * When the catalogue holds no answer, the next question is not "who is on this platform" — it is
 * **"who plausibly supplies this"**. The difference is the whole of Phases 2 and 3: a rung that
 * returned every supplier would be a broadcast wearing a lookup's clothes, and a platform that
 * broadcasts teaches its suppliers to ignore it.
 *
 * So a supplier qualifies only on evidence, and the evidence is different at each rung:
 *
 * **`known`** — suppliers this buyer has actually bought this kind of thing from. The strongest
 * signal on the platform, because it is a fact rather than a claim: somebody paid them and the order
 * completed. Nothing a supplier says about themselves outranks it.
 *
 * **`verified`** — suppliers who have been verified for the category but have not traded with this
 * buyer. A wider net, and deliberately a later one: a supplier who served this buyer well last month
 * should be asked before a stranger, however good the stranger's profile looks.
 *
 * Both share one scorer, because the dimensions genuinely are the same — category, capability,
 * geography, standing — and two implementations of "does this supplier match" would drift apart and
 * disagree about the same supplier at two rungs.
 *
 * **Category overlap is a gate, not a weight.** A supplier with no category in common does not score
 * poorly; they are excluded. Asking a cement supplier about laptops is the behaviour that trains
 * people to ignore the platform, and no amount of geographic convenience makes it less wrong.
 *
 * **Finding nobody and failing to look are different returns.** An empty array means the directory
 * was searched and nobody qualifies. A throw means the directory could not be searched, and the
 * ladder records `lookup-failed` — because a broken directory that looks like an absence of
 * suppliers escalates every Need to RFQ and nobody is paged.
 *
 * Owned by: M-07 Matching.
 */

import type { RungCandidate, SourcingQuery, SourcingRungPort } from '../ports.ts';

/**
 * What a supplier looks like to the matcher.
 *
 * Deliberately a **projection** rather than a supplier record. M-07 has no business knowing a
 * supplier's contact details, bank account or verification evidence; it needs to know what they
 * supply, where, and how well it has gone before. The application builds this from whichever modules
 * own those facts.
 */
export interface SupplierProfile {
  readonly supplierAccountId: string;
  /**
   * What they supply, as opaque category codes.
   *
   * The gate. A supplier with no category in common with the Need is not asked, however convenient
   * they otherwise look.
   */
  readonly categories: readonly string[];
  /**
   * What they can do beyond simply having it: bulk break, next-day, cold chain, installation.
   *
   * Scored rather than gated, because a Need that mentions no capability should not exclude a
   * supplier who happens to list several.
   */
  readonly capabilities: readonly string[];
  /** Where they serve, as opaque district codes. Empty means they have not said, not "nowhere". */
  readonly districts: readonly string[];
  /** Brands they carry, where that is meaningful. */
  readonly brands: readonly string[];
  /**
   * Whether M-02 has verified them for this kind of trade.
   *
   * Read rather than assumed: the `verified` rung asks the directory for verified suppliers, and
   * this field is what lets the rung refuse one that came back anyway.
   */
  readonly verified: boolean;
  /** `active`, `suspended`, `closed`. Only an active supplier is ever a candidate. */
  readonly status: string;
  /**
   * How reliably they have delivered, 0..1000, or null when there is not enough history to say.
   *
   * Null is not zero. A new supplier who has never failed is not the same as one who fails half the
   * time, and scoring them identically would make the platform impossible to join.
   */
  readonly reliabilityPerMille: number | null;
  /** Orders this buyer has completed with them for a category in this Need. Zero for a stranger. */
  readonly priorOrdersForBuyer: number;
  /** How recently, as a UTC instant, or null. Recency matters: a supplier from 2019 is a stranger. */
  readonly lastSuppliedAt: string | null;
}

/**
 * Where supplier profiles come from.
 *
 * Two methods rather than one with a flag, because the two rungs ask genuinely different questions
 * and an implementation can answer them with different queries — one over trading history, one over
 * the verified directory.
 */
export interface SupplierDirectory {
  /** Suppliers this buyer has bought this kind of thing from. */
  findKnownSuppliers(query: SourcingQuery): Promise<readonly SupplierProfile[]>;
  /** Verified suppliers for the category, whether or not this buyer knows them. */
  findVerifiedSuppliers(query: SourcingQuery): Promise<readonly SupplierProfile[]>;
}

export interface SupplierRungOptions {
  readonly directory: SupplierDirectory;
  /**
   * How far afield to look, as district codes. Empty means anywhere.
   *
   * Configurable because it is a business decision, not a technical one: a platform serving one
   * province and one serving an island want different answers, and neither is "wrong".
   */
  readonly districtScope?: readonly string[];
}

/**
 * What each signal is worth, per rung.
 *
 * The two differ on purpose. At the `known` rung, prior trade dominates — it is a fact about what
 * actually happened, and no profile claim outranks it. At the `verified` rung there is no prior
 * trade to weigh, so verification and reliability carry what history cannot.
 */
const KNOWN_WEIGHTS = Object.freeze({
  category: 250,
  priorTrade: 350,
  recency: 150,
  capability: 100,
  geography: 100,
  reliability: 50,
});

const VERIFIED_WEIGHTS = Object.freeze({
  category: 350,
  verification: 200,
  capability: 150,
  geography: 150,
  reliability: 150,
});

/** Suppliers this buyer has actually bought this kind of thing from. */
export function knownSupplierRung(options: SupplierRungOptions): SourcingRungPort {
  return {
    async find(query: SourcingQuery): Promise<readonly RungCandidate[]> {
      // A throw propagates. The ladder records `lookup-failed`, which is the honest answer when the
      // directory could not be read — as distinct from reading it and finding nobody.
      const profiles = await options.directory.findKnownSuppliers(query);
      return profiles
        .map((profile) => scoreKnown(profile, query, options))
        .filter((candidate): candidate is RungCandidate => candidate !== null);
    },
  };
}

/** Verified suppliers for the category who have not traded with this buyer. */
export function verifiedSupplierRung(options: SupplierRungOptions): SourcingRungPort {
  return {
    async find(query: SourcingQuery): Promise<readonly RungCandidate[]> {
      const profiles = await options.directory.findVerifiedSuppliers(query);
      return profiles
        .map((profile) => scoreVerified(profile, query, options))
        .filter((candidate): candidate is RungCandidate => candidate !== null);
    },
  };
}

/** What a Need asks of a supplier, as much of it as these rungs understand. */
export interface Wanted {
  readonly categories: readonly string[];
  readonly capabilities: readonly string[];
  readonly district: string | null;
  readonly brand: string | null;
}

/**
 * Read a Need the way these rungs read it.
 *
 * **Exported because the directory adapter has to gate its query on the same categories the rung
 * scores against.** A second implementation of "which categories is this Need about" would drift —
 * the adapter would ask the directory for `cement` while the rung scored against `commodity` — and
 * the symptom would be a rung that returned suppliers and then excluded all of them, which reads
 * from outside as an empty market rather than as a bug.
 */
export function readNeed(structured: Readonly<Record<string, unknown>>): Wanted {
  return {
    categories: readList(structured.category ?? structured.categories ?? structured.commodity),
    capabilities: readList(structured.capability ?? structured.capabilities),
    district: readText(structured.district),
    brand: readText(structured.brand),
  };
}

function readList(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim().toLowerCase()];
  if (Array.isArray(value)) {
    return value
      .filter((one): one is string => typeof one === 'string' && one.trim() !== '')
      .map((one) => one.trim().toLowerCase());
  }
  return [];
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;
}

function lower(values: readonly string[]): readonly string[] {
  return values.map((one) => one.toLowerCase());
}

/**
 * The gate every candidate must pass, at either rung.
 *
 * Returns the categories in common, or null to exclude. A supplier who is suspended, or who supplies
 * nothing the Need is about, is not a weak candidate — they are the wrong supplier, and asking them
 * is the behaviour that makes people stop reading requests from this platform.
 */
function qualify(
  profile: SupplierProfile,
  wanted: Wanted,
  options: SupplierRungOptions,
): readonly string[] | null {
  if (profile.status !== 'active') return null;

  const scope = options.districtScope ?? [];
  if (scope.length > 0 && profile.districts.length > 0) {
    const inScope = lower(profile.districts).some((one) => lower(scope).includes(one));
    // Out of the configured scope entirely. A supplier who serves only the north is not a poor
    // candidate for a delivery in the south; they are not a candidate.
    if (!inScope) return null;
  }

  // A Need whose reading found no category cannot gate on one. Every active supplier the directory
  // returned is then a candidate, on the grounds that the directory already filtered — the reading
  // is what failed here, and excluding everybody would escalate for a reason that is ours.
  if (wanted.categories.length === 0) return [];

  const overlap = lower(profile.categories).filter((one) =>
    wanted.categories.some((asked) => one === asked || one.includes(asked) || asked.includes(one)),
  );
  return overlap.length > 0 ? overlap : null;
}

function scoreCapabilities(profile: SupplierProfile, wanted: Wanted): number {
  if (wanted.capabilities.length === 0) return 1000;
  const held = lower(profile.capabilities);
  const met = wanted.capabilities.filter((one) => held.includes(one)).length;
  return Math.round((1000 * met) / wanted.capabilities.length);
}

function scoreGeography(profile: SupplierProfile, wanted: Wanted): number {
  if (wanted.district === null) return 1000;
  // Not having said where they serve is not the same as not serving there. A supplier with no
  // districts listed is scored neutrally rather than penalised for an empty profile field.
  if (profile.districts.length === 0) return 500;
  return lower(profile.districts).includes(wanted.district) ? 1000 : 0;
}

/**
 * Reliability, where there is enough history to have any.
 *
 * Null scores 600 rather than 0. A new supplier who has never failed is not the same as one who
 * fails half the time, and scoring them identically would make the platform impossible to join —
 * which is a way of quietly closing a marketplace to new entrants.
 */
function scoreReliability(profile: SupplierProfile): number {
  return profile.reliabilityPerMille ?? 600;
}

function scoreKnown(
  profile: SupplierProfile,
  query: SourcingQuery,
  options: SupplierRungOptions,
): RungCandidate | null {
  const wanted = readNeed(query.structured);
  const overlap = qualify(profile, wanted, options);
  if (overlap === null) return null;

  // The `known` rung is about prior trade. A supplier the directory returned who has in fact never
  // supplied this buyer belongs at the `verified` rung, not here — and letting them through would
  // make "known" mean nothing.
  if (profile.priorOrdersForBuyer <= 0) return null;

  // Diminishing returns: the difference between zero orders and three is enormous, and between
  // twelve and fifteen is noise.
  const tradeScore = Math.min(1000, 400 + profile.priorOrdersForBuyer * 150);
  const recencyScore = scoreRecency(profile.lastSuppliedAt, query.now);
  const capabilityScore = scoreCapabilities(profile, wanted);
  const geographyScore = scoreGeography(profile, wanted);
  const reliabilityScore = scoreReliability(profile);

  const score = weigh(KNOWN_WEIGHTS, {
    category: 1000,
    priorTrade: tradeScore,
    recency: recencyScore,
    capability: capabilityScore,
    geography: geographyScore,
    reliability: reliabilityScore,
  });

  return {
    kind: 'supplier',
    listingId: null,
    versionId: null,
    supplierAccountId: profile.supplierAccountId,
    scorePerMille: score,
    explanation: explainKnown(profile, wanted, overlap, geographyScore),
    evidence: {
      rung: 'known',
      categoriesInCommon: [...overlap],
      priorOrdersForBuyer: profile.priorOrdersForBuyer,
      lastSuppliedAt: profile.lastSuppliedAt,
      recencyScore,
      capabilityScore,
      geographyScore,
      reliabilityPerMille: profile.reliabilityPerMille,
    },
  };
}

function scoreVerified(
  profile: SupplierProfile,
  query: SourcingQuery,
  options: SupplierRungOptions,
): RungCandidate | null {
  const wanted = readNeed(query.structured);
  const overlap = qualify(profile, wanted, options);
  if (overlap === null) return null;

  // The directory was asked for verified suppliers. One that came back unverified is refused here
  // rather than trusted: this rung is the platform vouching for somebody it has checked, and
  // vouching for an unchecked supplier is the one thing it must not do.
  if (!profile.verified) return null;

  const capabilityScore = scoreCapabilities(profile, wanted);
  const geographyScore = scoreGeography(profile, wanted);
  const reliabilityScore = scoreReliability(profile);

  const score = weigh(VERIFIED_WEIGHTS, {
    category: 1000,
    verification: 1000,
    capability: capabilityScore,
    geography: geographyScore,
    reliability: reliabilityScore,
  });

  return {
    kind: 'supplier',
    listingId: null,
    versionId: null,
    supplierAccountId: profile.supplierAccountId,
    scorePerMille: score,
    explanation: explainVerified(profile, wanted, overlap, geographyScore),
    evidence: {
      rung: 'verified',
      categoriesInCommon: [...overlap],
      verified: true,
      capabilityScore,
      geographyScore,
      reliabilityPerMille: profile.reliabilityPerMille,
      brandsCarried: [...profile.brands],
    },
  };
}

/**
 * How recently they last supplied.
 *
 * A supplier who served this buyer last month is a live relationship. One who served them in 2019 is
 * a stranger with a record, and treating the two the same would keep recommending somebody who may
 * no longer trade at all.
 */
function scoreRecency(lastSuppliedAt: string | null, now: string): number {
  if (lastSuppliedAt === null) return 0;
  const then = Date.parse(lastSuppliedAt);
  const at = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(at)) return 0;

  const days = (at - then) / 86_400_000;
  if (days < 0) return 1000;
  if (days <= 90) return 1000;
  if (days <= 365) return 700;
  if (days <= 730) return 400;
  return 100;
}

/** Combine weighted signals into a 0..1000 score. */
function weigh(
  weights: Readonly<Record<string, number>>,
  signals: Readonly<Record<string, number>>,
): number {
  let total = 0;
  for (const [name, weight] of Object.entries(weights)) {
    total += (weight * (signals[name] ?? 0)) / 1000;
  }
  return Math.max(0, Math.min(1000, Math.round(total)));
}

function explainKnown(
  profile: SupplierProfile,
  wanted: Wanted,
  overlap: readonly string[],
  geographyScore: number,
): string {
  const parts: string[] = [];
  parts.push(
    `has supplied you ${String(profile.priorOrdersForBuyer)} time(s) for ` +
      `${overlap.length > 0 ? overlap.join(', ') : 'this kind of thing'}`,
  );
  if (profile.lastSuppliedAt !== null) {
    parts.push(`most recently on ${profile.lastSuppliedAt.slice(0, 10)}`);
  }
  if (wanted.district !== null) {
    parts.push(
      geographyScore >= 1000 ? `serves ${wanted.district}` : `not listed for ${wanted.district}`,
    );
  }
  if (profile.reliabilityPerMille !== null) {
    parts.push(`delivery record ${String(profile.reliabilityPerMille)} of 1000`);
  }
  return parts.join('; ');
}

function explainVerified(
  profile: SupplierProfile,
  wanted: Wanted,
  overlap: readonly string[],
  geographyScore: number,
): string {
  const parts: string[] = [];
  parts.push(
    `verified for ${overlap.length > 0 ? overlap.join(', ') : 'this category'}, and new to you`,
  );
  if (wanted.district !== null) {
    parts.push(
      geographyScore >= 1000
        ? `serves ${wanted.district}`
        : geographyScore > 0
          ? `has not said whether they serve ${wanted.district}`
          : `not listed for ${wanted.district}`,
    );
  }
  if (profile.brands.length > 0) parts.push(`carries ${profile.brands.join(', ')}`);
  parts.push(
    profile.reliabilityPerMille === null
      ? 'no delivery record with JAYA yet'
      : `delivery record ${String(profile.reliabilityPerMille)} of 1000`,
  );
  return parts.join('; ');
}
