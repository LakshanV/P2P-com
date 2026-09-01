/**
 * The external discovery rung: looking beyond the platform.
 *
 * The fourth rung, and the only one that leaves JAYA. When the catalogue holds nothing, no known
 * supplier serves the category, and no verified supplier qualifies, the remaining option before
 * troubling the market with an RFQ is to find somebody who is not on the platform yet.
 *
 * **No web crawling lives here, and none ever should.** This file defines a boundary and scores what
 * comes back through it. Whether the thing on the other side is a trade directory, a search API, a
 * scraper or a person with a spreadsheet is a deployment decision, and hardcoding any one of them
 * into the matching module would make the module unusable in a deployment that chose differently —
 * and untestable in every deployment, because the test would need the internet.
 *
 * Three properties the boundary has to have, and they are all about honesty.
 *
 * **A lead is not a supplier.** What comes back is somebody who *might* be able to supply this, found
 * somewhere the platform does not control. They have not agreed to anything, may not know JAYA
 * exists, and may not exist themselves. So a lead carries its **source** and the provider's own
 * **confidence**, and the ceiling below keeps it from outranking a verified supplier however
 * confident the provider claims to be.
 *
 * **A provider that fails is not a world with no suppliers in it.** Throwing is the contract for "I
 * could not look", and the ladder records `lookup-failed` — because a discovery provider whose
 * credentials expired should page somebody rather than quietly convert every Need into an RFQ.
 *
 * **A missing provider stops nothing.** No adapter wired means the rung is `unavailable` and the
 * ladder climbs past it. `mockExternalDiscovery` exists so the whole path can be proven without a
 * credential, which is the difference between a blocked feature and a feature waiting for a key.
 *
 * Owned by: M-07 Matching.
 */

import type { RungCandidate, SourcingQuery, SourcingRungPort } from '../ports.ts';

/**
 * Somebody who might be able to supply this, found outside the platform.
 *
 * Deliberately **not** a `SupplierProfile`: that describes an account JAYA knows, and this describes
 * a possibility. Reusing the profile type would let a lead be treated as a supplier by anything that
 * accepted one, which is the mistake this separation exists to prevent.
 */
export interface SupplierLead {
  /**
   * An opaque handle for the lead, stable for this provider.
   *
   * Not an account id, because there is no account. If the lead becomes a supplier, onboarding mints
   * a real one and this handle is what ties the two together.
   */
  readonly leadId: string;
  /** What the provider believes they supply, as opaque category codes. */
  readonly categories: readonly string[];
  /** Where they are, as opaque district codes. Empty means the provider did not say. */
  readonly districts: readonly string[];
  /**
   * How sure the provider is, 0..1000.
   *
   * The provider's own claim, recorded rather than trusted: it is scaled by the ceiling below, so a
   * provider that returns 1000 for everything cannot outrank a verified supplier by asserting.
   */
  readonly confidencePerMille: number;
  /**
   * Where this came from, in words.
   *
   * Required. A lead nobody can trace is a lead nobody can check, and the first question anybody
   * asks about an unfamiliar supplier is "where did we get this".
   */
  readonly source: string;
  /** Whatever else the provider returned, for review. Open, because providers differ. */
  readonly evidence: Readonly<Record<string, unknown>>;
}

/**
 * The boundary.
 *
 * One method, and a throw means "I could not look" rather than "there is nobody". Every provider —
 * mock, live, or the one somebody writes in 2027 — implements exactly this.
 */
export interface ExternalSupplierDiscoveryProvider {
  /** A stable name for the provider, carried into the evidence so a lead is traceable to it. */
  readonly name: string;
  discover(query: SourcingQuery): Promise<readonly SupplierLead[]>;
}

export interface ExternalDiscoveryOptions {
  readonly provider: ExternalSupplierDiscoveryProvider;
  /**
   * The most a lead may score.
   *
   * 600 by default, which is deliberately **below** the ladder's 700 sufficiency default. A lead
   * alone therefore never satisfies the ladder: the best it can do is be recorded as the strongest
   * thing found before the Need escalates, so an operator opening the RFQ can see who to invite.
   *
   * That is the honest position for somebody who has not agreed to anything and may not know the
   * platform exists. A deployment that has onboarded its leads and wants them to satisfy can raise
   * it — but raising it is a decision somebody makes, not a default they inherit.
   */
  readonly ceilingPerMille?: number;
}

const DEFAULT_LEAD_CEILING = 600;

export function externalDiscoveryRung(options: ExternalDiscoveryOptions): SourcingRungPort {
  const ceiling = options.ceilingPerMille ?? DEFAULT_LEAD_CEILING;

  return {
    async find(query: SourcingQuery): Promise<readonly RungCandidate[]> {
      // Propagates. A provider whose credentials expired should page somebody, not quietly convert
      // every Need into an RFQ.
      const leads = await options.provider.discover(query);

      return leads
        .map((lead) => scoreLead(lead, options.provider.name, ceiling))
        .filter((candidate): candidate is RungCandidate => candidate !== null);
    },
  };
}

function scoreLead(
  lead: SupplierLead,
  providerName: string,
  ceiling: number,
): RungCandidate | null {
  // A provider that cannot say where a lead came from has given us something unverifiable, and the
  // first question anybody asks about an unfamiliar supplier is where we got them.
  if (lead.source.trim() === '') return null;

  const confidence = Math.max(0, Math.min(1000, Math.round(lead.confidencePerMille)));
  const score = Math.round((confidence * ceiling) / 1000);

  return {
    kind: 'supplier',
    listingId: null,
    versionId: null,
    // A lead has no account, so the lead id stands in its place. The candidate is explicitly a
    // possibility rather than a supplier, and the evidence says which provider produced it.
    supplierAccountId: lead.leadId,
    scorePerMille: score,
    explanation:
      `found outside JAYA via ${providerName} (${lead.source}); ` +
      `not yet a JAYA supplier, so this is a lead to follow up rather than an offer` +
      (lead.categories.length > 0 ? `; listed for ${lead.categories.join(', ')}` : ''),
    evidence: {
      rung: 'external',
      provider: providerName,
      leadId: lead.leadId,
      source: lead.source,
      providerConfidencePerMille: confidence,
      ceilingApplied: ceiling,
      categories: [...lead.categories],
      districts: [...lead.districts],
      ...lead.evidence,
    },
  };
}

/**
 * A provider that returns what it is given.
 *
 * Not a placeholder for a real one — a **test double with a contract**, so the whole external path
 * can be proven without a credential. BL-04 records that no discovery provider credentials exist,
 * and a missing key must never be the reason a path goes unbuilt: the boundary is what matters, and
 * a live adapter later implements the same two members.
 */
export function mockExternalDiscovery(
  leads: readonly SupplierLead[],
  name = 'mock-discovery',
): ExternalSupplierDiscoveryProvider {
  return {
    name,
    discover: () => Promise.resolve(leads),
  };
}

/**
 * A provider that always fails.
 *
 * For proving the `lookup-failed` path, which is the one that stops a broken provider from looking
 * like an empty world.
 */
export function failingExternalDiscovery(
  reason = 'the discovery provider returned 503',
  name = 'mock-discovery',
): ExternalSupplierDiscoveryProvider {
  return {
    name,
    discover: () => Promise.reject(new Error(reason)),
  };
}
