/**
 * M-07, M-09 and M-10, wired the way the application wires them.
 *
 * `ApiServices` requires all three, because the sourcing routes and the consumer that turns an
 * accepted offer into an order need them — and a suite that left them out would be building a
 * different application from the one that ships.
 *
 * The joins are the same ones `apps/api` makes, over in-memory repositories: M-10 reaches M-09
 * through its two-method port (same layer, neither may import the other), and M-07's catalogue rung
 * reaches M-04 through `CatalogueSource`.
 *
 * **A rung with no port is `unavailable`, never `empty`.** A suite that passes no listings service
 * gets a ladder whose catalogue rung is not wired, and the ladder says so rather than reporting
 * that it looked and found nothing. That is the distinction M-07 exists to keep, so the helper
 * keeps it too.
 *
 * Owned by: tests.
 */

import {
  catalogueRung,
  InMemoryMatchingRepository,
  MatchingService,
} from '../../modules/matching/index.ts';
import { InMemoryQuoteRepository, QuoteService } from '../../modules/quotes/index.ts';
import { InMemoryRfqRepository, RfqService } from '../../modules/rfq/index.ts';
import type { UniversalListingService } from '../../modules/universal-listing/index.ts';
import { catalogueSourceFor } from '../../apps/api/catalogue-source.ts';
import { tenderSourceFor } from '../../apps/api/tender-source.ts';

export interface TenderingServices {
  readonly tenders: RfqService;
  readonly quotes: QuoteService;
  readonly matching: MatchingService;
}

export function inMemoryTendering(listings?: UniversalListingService): TenderingServices {
  const tenders = new RfqService(new InMemoryRfqRepository());

  return {
    tenders,
    quotes: new QuoteService(new InMemoryQuoteRepository(), tenderSourceFor(tenders)),
    matching: new MatchingService(
      new InMemoryMatchingRepository(),
      listings === undefined
        ? {}
        : { catalogue: catalogueRung({ source: catalogueSourceFor({ listings }), listings }) },
    ),
  };
}
