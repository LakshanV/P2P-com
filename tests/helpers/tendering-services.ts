/**
 * M-09 and M-10, wired the way the application wires them.
 *
 * `ApiServices` requires both, because the consumer that turns an accepted offer into an order needs
 * them and a suite that left them out would be building a different application from the one that
 * ships. The join between the two goes through M-10's two-method port — they are the same layer and
 * neither may import the other — so this helper builds the same adapter `apps/api` builds, over
 * in-memory repositories.
 *
 * Owned by: tests.
 */

import { InMemoryQuoteRepository, QuoteService } from '../../modules/quotes/index.ts';
import { InMemoryRfqRepository, RfqService } from '../../modules/rfq/index.ts';
import { tenderSourceFor } from '../../apps/api/tender-source.ts';

export interface TenderingServices {
  readonly tenders: RfqService;
  readonly quotes: QuoteService;
}

export function inMemoryTendering(): TenderingServices {
  const tenders = new RfqService(new InMemoryRfqRepository());
  return {
    tenders,
    quotes: new QuoteService(new InMemoryQuoteRepository(), tenderSourceFor(tenders)),
  };
}
