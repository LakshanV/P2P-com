/**
 * The adapters that let M-10 and the order consumer ask M-09 what they need, and nothing more.
 *
 * Both modules are the same layer, so neither may import the other. M-10 declares a two-method
 * `TenderSource` — is this tender open, and was this supplier invited — and the quote-order consumer
 * declares a one-method `TenderBuyerSource`. This file is where those ports meet the real M-09,
 * which is above both and therefore allowed to know about both.
 *
 * The ports stay deliberately narrow. M-10 has no business closing a tender or reading somebody
 * else's invitations, and the consumer has no business doing anything but finding out who is buying.
 * A wide port is an import with extra steps.
 *
 * Owned by: apps/api.
 */

import type { RfqService } from '../../modules/rfq/index.ts';
import type { TenderFacts, TenderSource } from '../../modules/quotes/index.ts';

import type { TenderBuyerSource } from './consumers/quote-order.ts';

/**
 * M-09 as the three facts M-10 needs about a tender.
 *
 * `isInvited` is answered from the invitation records rather than from anything the supplier sends.
 * A supplier who could assert their own invitation would be a supplier who needs no invitation, and
 * a private tender that any supplier can quote for is not private.
 */
export function tenderSourceFor(rfq: RfqService): TenderSource {
  return {
    async findTender(rfqId: string): Promise<TenderFacts | null> {
      const tender = await rfq.getRfq(rfqId);
      if (tender === null) return null;
      return {
        rfqId: tender.rfqId,
        status: tender.status,
        quantity: tender.specification.quantity,
        substitutionPolicy: tender.specification.substitutionPolicy,
        requiredBy: tender.specification.requiredBy,
        qualityRequirements: tender.specification.qualityRequirements,
      };
    },

    async isInvited(rfqId: string, supplierAccountId: string): Promise<boolean> {
      const invitations = await rfq.listInvitations(rfqId);
      return invitations.some((one) => one.supplierAccountId === supplierAccountId);
    },
  };
}

/**
 * M-09 as the one fact the order consumer needs: who is buying.
 *
 * An accepted offer names the supplier; the buyer is a fact M-09 holds. Reading it from anywhere a
 * caller could influence would let somebody open an order in another person's name.
 */
export function tenderBuyerSourceFor(rfq: RfqService): TenderBuyerSource {
  return {
    async findBuyer(rfqId: string): Promise<string | null> {
      const tender = await rfq.getRfq(rfqId);
      return tender === null ? null : tender.accountId;
    },
  };
}
