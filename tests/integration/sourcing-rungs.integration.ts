/**
 * The two supplier rungs, wired to real data, against a live PostgreSQL server.
 *
 * Until M-48 existed these rungs had nothing to read, so M-07 recorded `unavailable` for both and
 * the ladder went catalogue → nothing → tender. **Every Need that no published listing answered
 * became an RFQ**, which is the behaviour the ladder exists to prevent, and no unit test could show
 * it because the rungs were never wired at all.
 *
 * This suite is the proof that they now are, and it is deliberately an integration suite rather
 * than a unit one: the join spans three modules and three schemas — what a party claims
 * (`module_supplier_directory`), whether anybody verified them (`module_capability_verification`),
 * and what they have actually delivered (`module_orders`) — and the whole point of the adapter is
 * that those three answers come from three different places. A stub for any of them would be a
 * test of the stub.
 *
 * What each test holds:
 *
 *   * **`known` reads history, not claims.** A supplier is known because this buyer completed an
 *     order with them, and the order is driven through M-11's real state machine to get there.
 *   * **`verified` reads M-02, not the directory.** A party the directory lists is not thereby
 *     verified; the level is read per call from the module that decides it.
 *   * **A Need that used to escalate now finds somebody.** The ladder runs end to end and records
 *     `matched` at a supplier rung rather than recommending a tender, and the run's own rung
 *     attempts say which rung answered — which is what makes the outcome explainable to the
 *     customer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CapabilityVerificationService,
  PostgresCapabilityVerificationRepository,
} from '../../modules/capability-verification/index.ts';
import {
  MatchingService,
  PostgresMatchingRepository,
  knownSupplierRung,
  verifiedSupplierRung,
} from '../../modules/matching/index.ts';
import type { RunLadderRequest } from '../../modules/matching/index.ts';
import { OrderService, PostgresOrderRepository } from '../../modules/orders/index.ts';
import {
  DirectoryService,
  PostgresDirectoryRepository,
} from '../../modules/supplier-directory/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import { supplierDirectoryFor } from '../../apps/api/supplier-source.ts';
import type { Database } from '../../platform/db/client.ts';

import { liveTestOptions, withTestDatabase } from './harness.ts';

const BUYER = 'acct_live_rungbuyer1';
/** Traded with the buyer before. The `known` rung's whole case. */
const OLD_HAND = 'acct_live_rungoldhnd';
/** Verified, in the category, and a stranger to this buyer. The `verified` rung's case. */
const STRANGER = 'acct_live_rungstrngr';
/** In the directory, in the category, and verified by nobody. */
const UNVETTED = 'acct_live_rungunvetd';

const NOW = '2026-07-01T09:00:00.000000Z';
const LATER = '2026-07-05T09:00:00.000000Z';

interface Stack {
  readonly directory: DirectoryService;
  readonly verification: CapabilityVerificationService;
  readonly orders: OrderService;
  readonly matching: MatchingService;
}

function stackFor(database: Database): Stack {
  const directory = new DirectoryService(new PostgresDirectoryRepository(database));
  const verification = new CapabilityVerificationService(
    new PostgresCapabilityVerificationRepository(database),
  );
  const orders = new OrderService(new PostgresOrderRepository(database));

  const source = supplierDirectoryFor({ directory, verification, orders });

  // The catalogue rung is deliberately left unwired here. The point of the suite is the two rungs
  // below it, and a catalogue that answered first would mean the ladder never reached them.
  const matching = new MatchingService(new PostgresMatchingRepository(database), {
    known: knownSupplierRung({ directory: source }),
    verified: verifiedSupplierRung({ directory: source }),
  });

  return { directory, verification, orders, matching };
}

interface PartyOptions {
  readonly tag: string;
  readonly accountId: string;
  readonly categories: readonly string[];
  readonly districts?: readonly string[];
}

/** A registered, activated, open party in the directory. */
async function aParty(directory: DirectoryService, options: PartyOptions): Promise<string> {
  const { tag } = options;
  const supplierId = `sup_live_rung${tag}`;

  await directory.registerSupplier({
    supplierId,
    accountId: options.accountId,
    kind: 'supplier',
    displayName: `Party ${tag}`,
    registeredAt: NOW,
    correlationId: `corr_live_rung${tag}`,
    idempotencyKey: `idem_live_rung${tag}`,
    eventId: `dev_live_rung${tag}r`,
  });
  await directory.activateSupplier({
    supplierId,
    reason: 'documents checked and the trade licence is current',
    occurredAt: NOW,
    correlationId: `corr_live_rung${tag}a`,
    idempotencyKey: `idem_live_rung${tag}a`,
    eventId: `dev_live_rung${tag}a`,
  });
  await directory.setAvailability({
    supplierId,
    acceptsOrders: true,
    occurredAt: NOW,
    correlationId: `corr_live_rung${tag}v`,
    idempotencyKey: `idem_live_rung${tag}v`,
  });

  let index = 0;
  for (const category of options.categories) {
    index += 1;
    await directory.declareFacet({
      facetId: `fac_live_rung${tag}c${String(index)}`,
      supplierId,
      kind: 'category',
      value: category,
      declaredAt: NOW,
      correlationId: `corr_live_rung${tag}c${String(index)}`,
      idempotencyKey: `idem_live_rung${tag}c${String(index)}`,
    });
  }

  index = 0;
  for (const district of options.districts ?? []) {
    index += 1;
    await directory.declareFacet({
      facetId: `fac_live_rung${tag}d${String(index)}`,
      supplierId,
      kind: 'district',
      value: district,
      declaredAt: NOW,
      correlationId: `corr_live_rung${tag}d${String(index)}`,
      idempotencyKey: `idem_live_rung${tag}d${String(index)}`,
    });
  }

  return supplierId;
}

/** Verify a party to `standard` through M-02's real path: open a case, then decide it. */
async function verifyParty(
  verification: CapabilityVerificationService,
  accountId: string,
  tag: string,
): Promise<void> {
  const caseId = `case_live_rung${tag}`;
  await verification.startVerification({
    caseId,
    accountId,
    purpose: 'seller-onboarding',
    requestedLevel: 'standard',
    attributes: {},
    openedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    correlationId: `corr_live_rungv${tag}`,
    idempotencyKey: `idem_live_rungv${tag}`,
    recordId: `rec_live_rungv${tag}`,
    reason: 'the account began seller onboarding',
  });
  await verification.evaluateLevel({
    caseId,
    level: 'standard',
    reason: 'trade licence and identity document accepted by the reviewer',
    occurredAt: NOW,
    decidedAt: NOW,
    updatedAt: NOW,
    correlationId: `corr_live_runge${tag}`,
    idempotencyKey: `idem_live_runge${tag}`,
    recordId: `rec_live_runge${tag}`,
  });
}

/**
 * One order, driven all the way to `completed` through M-11's real state machine.
 *
 * Not inserted. The `known` rung's claim is that somebody actually delivered, and an order row
 * written straight into the table would prove the query and nothing about the claim.
 */
async function aCompletedOrder(
  orders: OrderService,
  sellerAccountId: string,
  tag: string,
): Promise<string> {
  const orderId = `ord_live_rung${tag}`;

  await orders.createOrder({
    orderId,
    buyerAccountId: BUYER,
    sellerAccountId,
    currency: 'LKR',
    createdAt: NOW,
    updatedAt: NOW,
    correlationId: `corr_live_rungo${tag}`,
    idempotencyKey: `idem_live_rungo${tag}`,
    eventId: `oev_live_rungo${tag}`,
    reason: 'the buyer started a basket',
  });
  await orders.addItem({
    itemId: `oit_live_rung${tag}`,
    orderId,
    listingId: `lst_live_rung${tag}`,
    versionId: `ver_live_rung${tag}`,
    commerceUnitTypeId: `cut_live_rung${tag}`,
    quoteId: null,
    lineKind: 'goods',
    quantity: 4n,
    unitPriceMinor: 250n,
    lineTotalMinor: 1000n,
    currency: 'LKR',
    reservationId: `rsv_live_rung${tag}`,
    addedAt: NOW,
    correlationId: `corr_live_rungi${tag}`,
    idempotencyKey: `idem_live_rungi${tag}`,
  });
  await orders.placeOrder({
    orderId,
    snapshotId: `osn_live_rung${tag}`,
    expectedTotalMinor: 1000n,
    policyVersionId: `pol_live_rung${tag}`,
    placedAt: NOW,
    updatedAt: NOW,
    correlationId: `corr_live_rungp${tag}`,
    idempotencyKey: `idem_live_rungp${tag}`,
    eventId: `oev_live_rungp${tag}`,
    reason: 'the buyer placed the order',
  });
  await orders.confirmOrder({
    orderId,
    confirmedAt: NOW,
    updatedAt: NOW,
    correlationId: `corr_live_rungc${tag}`,
    idempotencyKey: `idem_live_rungc${tag}`,
    eventId: `oev_live_rungc${tag}`,
    reason: 'the seller accepted the order',
  });
  await orders.startFulfilment({
    orderId,
    fulfillingAt: LATER,
    updatedAt: LATER,
    correlationId: `corr_live_rungf${tag}`,
    idempotencyKey: `idem_live_rungf${tag}`,
    eventId: `oev_live_rungf${tag}`,
    reason: 'the seller began fulfilling',
  });
  await orders.completeOrder({
    orderId,
    completedAt: LATER,
    updatedAt: LATER,
    correlationId: `corr_live_rungx${tag}`,
    idempotencyKey: `idem_live_rungx${tag}`,
    eventId: `oev_live_rungx${tag}`,
    reason: 'the buyer received the goods',
  });

  return orderId;
}

const NEED = Object.freeze({ category: 'cement', quantity: 20, unit: 'tonne', district: 'matale' });

function runRequest(tag: string): RunLadderRequest {
  return {
    runId: `mrn_live_rung${tag}`,
    requestId: `req_live_rung${tag}`,
    accountId: BUYER,
    interpretationId: null,
    structured: NEED,
    confidencePerMille: 850,
    startedAt: LATER,
    completedAt: LATER,
    correlationId: `corr_live_rungm${tag}`,
    idempotencyKey: `idem_live_rungm${tag}`,
    // Pinned rather than left to the deployment default of 700. How good a candidate has to be
    // before the ladder stops is a business decision, and a suite that inherited it would start
    // failing the day somebody tuned it — for a reason that has nothing to do with these rungs.
    // A supplier with no delivery record cannot reach 700 at the verified rung by design.
    sufficiencyPerMille: 400,
  };
}

// ---------------------------------------------------------------------------
// known
// ---------------------------------------------------------------------------

void test(
  'the known rung finds a supplier this buyer actually delivered with',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const stack = stackFor(database);

      await aParty(stack.directory, {
        tag: 'oldhand',
        accountId: OLD_HAND,
        categories: ['cement'],
        districts: ['matale'],
      });
      await aCompletedOrder(stack.orders, OLD_HAND, 'k1');

      const run = await stack.matching.runLadder(runRequest('k1'));

      const known = run.attempts.find((attempt) => attempt.rung === 'known');
      assert.ok(known !== undefined, 'the known rung ran');
      assert.equal(
        known.outcome,
        'satisfied',
        'the rung looked, found somebody, and they were good enough. Before M-48 existed this said ' +
          '`unavailable`, and every Need the catalogue could not answer became a tender',
      );
      assert.equal(known.candidatesFound, 1);

      const candidates = run.candidates.filter((candidate) => candidate.rung === 'known');
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]?.supplierAccountId, OLD_HAND);
      assert.equal(candidates[0]?.kind, 'supplier', 'nobody has offered anything yet');
      assert.ok(
        (candidates[0]?.explanation ?? '').length > 0,
        'and it says why, in words a customer could read',
      );
    });
  },
);

void test(
  'a supplier the buyer never completed an order with is not known',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const stack = stackFor(database);

      await aParty(stack.directory, {
        tag: 'stranger',
        accountId: STRANGER,
        categories: ['cement'],
        districts: ['matale'],
      });

      // Placed and confirmed, never delivered. A promise is not a delivery record, and counting it
      // would make the strongest signal on the platform the easiest to fake.
      const orderId = 'ord_live_rungpromise';
      await stack.orders.createOrder({
        orderId,
        buyerAccountId: BUYER,
        sellerAccountId: STRANGER,
        currency: 'LKR',
        createdAt: NOW,
        updatedAt: NOW,
        correlationId: 'corr_live_rungpr1',
        idempotencyKey: 'idem_live_rungpr1',
        eventId: 'oev_live_rungpr1',
        reason: 'the buyer started a basket',
      });
      await stack.orders.addItem({
        itemId: 'oit_live_rungpr01',
        orderId,
        listingId: 'lst_live_rungpr01',
        versionId: 'ver_live_rungpr01',
        commerceUnitTypeId: 'cut_live_rungpr01',
        quoteId: null,
        lineKind: 'goods',
        quantity: 4n,
        unitPriceMinor: 250n,
        lineTotalMinor: 1000n,
        currency: 'LKR',
        reservationId: 'rsv_live_rungpr01',
        addedAt: NOW,
        correlationId: 'corr_live_rungpr2',
        idempotencyKey: 'idem_live_rungpr2',
      });
      await stack.orders.placeOrder({
        orderId,
        snapshotId: 'osn_live_rungpr01',
        expectedTotalMinor: 1000n,
        policyVersionId: 'pol_live_rungpr01',
        placedAt: NOW,
        updatedAt: NOW,
        correlationId: 'corr_live_rungpr3',
        idempotencyKey: 'idem_live_rungpr3',
        eventId: 'oev_live_rungpr3',
        reason: 'the buyer placed the order',
      });

      const run = await stack.matching.runLadder(runRequest('k2'));

      const known = run.attempts.find((attempt) => attempt.rung === 'known');
      assert.equal(
        known?.outcome,
        'empty',
        'the rung looked and found nobody, which is a different fact from not having looked',
      );
    });
  },
);

// ---------------------------------------------------------------------------
// verified
// ---------------------------------------------------------------------------

void test(
  'the verified rung finds a stranger M-02 verified, and skips one it did not',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const stack = stackFor(database);

      await aParty(stack.directory, {
        tag: 'stranger',
        accountId: STRANGER,
        categories: ['cement'],
        districts: ['matale'],
      });
      await aParty(stack.directory, {
        tag: 'unvetted',
        accountId: UNVETTED,
        categories: ['cement'],
        districts: ['matale'],
      });

      // One of the two is verified. Both are in the directory, in the category, open for orders and
      // in the right district — so the only thing separating them is M-02's answer, which is exactly
      // the fact this rung is named after.
      await verifyParty(stack.verification, STRANGER, 'v1');

      const run = await stack.matching.runLadder(runRequest('v1'));

      const verified = run.attempts.find((attempt) => attempt.rung === 'verified');
      assert.ok(verified !== undefined, 'the verified rung ran');
      assert.equal(verified.outcome, 'satisfied');
      assert.equal(verified.candidatesFound, 1, 'one of the two, not both');

      const candidates = run.candidates.filter((candidate) => candidate.rung === 'verified');
      assert.deepEqual(
        candidates.map((candidate) => candidate.supplierAccountId),
        [STRANGER],
        'the directory listing both of them is not what makes one of them verified. A verification ' +
          'column in the directory would have returned both, and would have been the stale copy ' +
          'somebody sourced against',
      );
    });
  },
);

// ---------------------------------------------------------------------------
// The ladder, end to end
// ---------------------------------------------------------------------------

void test(
  'a Need that used to escalate to a tender now finds a supplier',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const stack = stackFor(database);

      await aParty(stack.directory, {
        tag: 'stranger',
        accountId: STRANGER,
        categories: ['cement'],
        districts: ['matale'],
      });
      await verifyParty(stack.verification, STRANGER, 'e1');

      const run = await stack.matching.runLadder(runRequest('e1'));

      assert.equal(
        run.run.outcome,
        'matched',
        'the ladder answered the Need rather than recommending a tender. That is the whole point of ' +
          'wiring these rungs: a platform that broadcasts every unmatched Need teaches its suppliers ' +
          'to ignore it',
      );
      assert.equal(run.run.satisfiedBy, 'verified', 'and the record says which rung answered');

      // What each rung did, including the ones that found nothing — which is what makes the outcome
      // explainable to the customer it concerns.
      const outcomes = new Map(run.attempts.map((attempt) => [attempt.rung, attempt.outcome]));
      assert.equal(outcomes.get('known'), 'empty', 'this buyer has no history with them');
      assert.equal(outcomes.get('verified'), 'satisfied');
      assert.equal(
        outcomes.get('catalogue'),
        'unavailable',
        'and the rung this deployment did not wire says so, rather than reporting an empty catalogue',
      );
      assert.equal(
        outcomes.get('rfq'),
        'skipped',
        'the ladder stopped before the rung that would have broadcast the Need',
      );
    });
  },
);
