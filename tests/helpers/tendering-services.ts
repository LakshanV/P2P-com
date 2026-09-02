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
import {
  DirectoryService,
  InMemoryDirectoryRepository,
} from '../../modules/supplier-directory/index.ts';
import {
  InMemoryOrganisationRepository,
  OrganisationService,
} from '../../modules/organisations/index.ts';
import type { UniversalListingService } from '../../modules/universal-listing/index.ts';
import { catalogueSourceFor } from '../../apps/api/catalogue-source.ts';
import { tenderSourceFor } from '../../apps/api/tender-source.ts';

export interface TenderingServices {
  readonly tenders: RfqService;
  readonly quotes: QuoteService;
  readonly matching: MatchingService;
  readonly directory: DirectoryService;
  readonly organisations: OrganisationService;
}

/**
 * The ladder here keeps only the catalogue rung, and that is deliberate.
 *
 * `apps/api/main.ts` and `tests/e2e/harness.ts` wire the two supplier rungs as well, against the
 * real adapter over three modules. These suites exist to test **routes** — that a request is
 * guarded, read and answered — and a ladder that reached into a directory, a verification service
 * and an order history would make every route test depend on three more modules' behaviour. The
 * rungs are proved where they belong, in `tests/integration/sourcing-rungs.integration.ts` and
 * `tests/supplier-source.test.ts`.
 *
 * The directory service is still returned, because the API serves M-48's own routes.
 */
export function inMemoryTendering(listings?: UniversalListingService): TenderingServices {
  const tenders = new RfqService(new InMemoryRfqRepository());

  return {
    tenders,
    directory: new DirectoryService(new InMemoryDirectoryRepository()),
    organisations: new OrganisationService(new InMemoryOrganisationRepository()),
    quotes: new QuoteService(new InMemoryQuoteRepository(), tenderSourceFor(tenders)),
    matching: new MatchingService(
      new InMemoryMatchingRepository(),
      listings === undefined
        ? {}
        : { catalogue: catalogueRung({ source: catalogueSourceFor({ listings }), listings }) },
    ),
  };
}
