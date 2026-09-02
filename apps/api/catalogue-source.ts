/**
 * M-04 as something the catalogue rung can search.
 *
 * M-07 declares what it needs — "current published versions plausibly relevant to a structured
 * Need" — and does not say how to find them. This is the deployment's answer for V1, and it is
 * deliberately the simplest one that is honest: read a bounded page of every published version and
 * let the rung score it.
 *
 * **That is recall by enumeration, and it is a placeholder.** It is correct — the rung's own
 * documentation asks for a loose recall step and puts the precision in the scoring — and it stops
 * being adequate the moment supply outgrows a page. The replacement is M-06 Search & Discovery over
 * K-15, and swapping it means writing a different `CatalogueSource` and changing one line of
 * wiring, which is the whole reason the rung takes a port.
 *
 * **A failure here must propagate.** M-07 distinguishes "I looked and there is nothing" from "I
 * could not look", and gets that distinction from whether this throws. Catching a database error and
 * returning an empty page would report an absence of supply that nobody established — and would
 * quietly escalate every Need to a tender the week the database was slow.
 *
 * Owned by: apps/api.
 */

import type { CatalogueEntry, CatalogueSource } from '../../modules/matching/index.ts';
import type { UniversalListingService } from '../../modules/universal-listing/index.ts';

export interface CatalogueSourceOptions {
  readonly listings: UniversalListingService;
  /** How many published versions one recall step reads. M-04 bounds and validates it. */
  readonly limit?: number;
}

export function catalogueSourceFor(options: CatalogueSourceOptions): CatalogueSource {
  return {
    async searchVersions(): Promise<readonly CatalogueEntry[]> {
      // The query is ignored on purpose: this is the recall step, and filtering here would hide the
      // near misses the rung exists to explain. When a real index replaces it, the query is what it
      // will search with.
      const published = await options.listings.listPublishedVersions(options.limit);
      return published.map((entry) => ({
        version: entry.version,
        supplierAccountId: entry.supplierAccountId,
      }));
    },
  };
}
