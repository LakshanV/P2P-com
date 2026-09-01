/**
 * M-09 RFQ — asking the market, and what a supplier is allowed to see.
 *
 * An RFQ exists only when JAYA could not solve a Need itself, so by the time one is opened the
 * catalogue has been searched, the buyer's own suppliers have been asked and the verified network
 * has been checked. That ordering is the product; this module is what happens after it fails.
 *
 * **The rule this suite is weighted towards is privacy**, because it is the one with a real victim.
 * A Need is a sentence a customer wrote, exempt from the identifier rules on purpose, and it may
 * hold a telephone number, an address or a hint about what they will pay. A tender goes to
 * strangers. Everything between the two is tested here, from three directions:
 *
 *   * the **allowlist** — a reading's unrecognised keys do not travel, whatever they are called;
 *   * the **guard** — a string that looks like a pasted message is refused wherever it appears;
 *   * the **shape** — there is no free-text field wide enough to hide a Need in.
 *
 * The third is what actually holds. The first two are what catches the mistake somebody makes at
 * five o'clock.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryRfqRepository,
  RfqError,
  RfqService,
  buildSpecification,
  carriedKeys,
  type RfqSpecification,
} from '../modules/rfq/index.ts';

/**
 * Serialise the way the wire does.
 *
 * A specification carries a `bigint` quantity, and `JSON.stringify` throws on one rather than
 * rounding it — the same property the HTTP pipeline handles with `toJsonSafe`. The suite asserts on
 * what a supplier would actually receive, so it converts the same way.
 */
const serialise = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );

const BUYER = 'acct_01HR0RFQbuyer01';
const SUPPLIER_A = 'acct_01HR0RFQsupplA1';
const SUPPLIER_B = 'acct_01HR0RFQsupplB1';
const NEED = 'req_01HR0RFQneed001';
const RUN = 'mrun_01HR0RFQrun001';
const NOW = '2026-07-01T09:00:00.000000Z';
const CLOSES = '2026-07-04T17:00:00.000000Z';

/** The reading of a Need that could not be sourced any other way. */
const READING = Object.freeze({
  commodity: 'cement',
  quantity: 20,
  unit: 'tonne',
  district: 'matale',
  grade: 'OPC 43',
  requiredBy: '2026-07-05T09:00:00.000000Z',
});

function specification(overrides: Partial<Record<string, unknown>> = {}): RfqSpecification {
  return buildSpecification({
    structured: { ...READING, ...overrides },
    itemDescription: 'Ordinary Portland Cement, OPC 43 grade, delivered in bulk',
    substitutionPolicy: 'equivalent-with-disclosure',
    qualityRequirements: ['SLS 107 certified'],
  });
}

function build(): { service: RfqService; repository: InMemoryRfqRepository } {
  const repository = new InMemoryRfqRepository();
  return { service: new RfqService(repository), repository };
}

async function anRfq(
  service: RfqService,
  tag = '0001',
  spec: RfqSpecification = specification(),
): Promise<string> {
  const rfqId = `rfq_01HR0RFQ${tag}`;
  await service.openRfq({
    rfqId,
    requestId: NEED,
    accountId: BUYER,
    matchRunId: RUN,
    visibility: 'private',
    specification: spec,
    closesAt: CLOSES,
    openedAt: NOW,
    correlationId: 'corr_01HR0RFQopen01',
    idempotencyKey: `idem_rfq_open_${tag}`,
    eventId: `rev_01HR0RFQ${tag}`,
  });
  return rfqId;
}

const codeOf = (error: unknown): string | undefined =>
  error instanceof RfqError ? error.code : undefined;

// ---------------------------------------------------------------------------
// What a supplier may see
// ---------------------------------------------------------------------------

test('the specification carries the requirement and nothing else', async () => {
  const { service } = build();
  const rfqId = await anRfq(service);
  const rfq = await service.getRfq(rfqId);
  const spec = rfq?.specification;

  assert.ok(spec !== undefined);
  assert.equal(spec.category, 'cement');
  assert.equal(spec.quantity, 20n);
  assert.equal(spec.unit, 'tonne');
  assert.equal(spec.deliveryDistrict, 'matale');
  assert.deepEqual({ ...spec.attributes }, { grade: 'OPC 43' });
  assert.deepEqual([...spec.qualityRequirements], ['SLS 107 certified']);
  assert.equal(spec.substitutionPolicy, 'equivalent-with-disclosure');
});

test('a key the builder does not recognise never reaches a supplier', () => {
  // An allowlist, and the direction is the point: a denylist would need updating every time M-03's
  // interpreter learned a new field, and the one nobody remembered would be the one that leaked.
  const spec = specification({
    customerPhone: '0771234567',
    buyerNote: 'call me after six, my wife handles the payments',
    maxBudget: 950_000,
    competitorComplaint: 'the last supplier was hopeless',
  });

  const serialised = serialise(spec);
  assert.ok(!serialised.includes('0771234567'));
  assert.ok(!serialised.includes('call me after six'));
  assert.ok(!serialised.includes('950000'));
  assert.ok(!serialised.includes('hopeless'));
  assert.deepEqual({ ...spec.attributes }, { grade: 'OPC 43' }, 'only the recognised attribute');
});

test('the budget is not carried even though the platform may know it', () => {
  // Not a privacy rule: a supplier who can see what a buyer will pay quotes that number, and that
  // is the difference between a market and a rubber stamp.
  assert.ok(
    !carriedKeys().includes('budget'),
    'no budget key is on the allowlist, and adding one changes what a tender is',
  );
  assert.ok(!carriedKeys().includes('budgetMinor'));
  assert.ok(!carriedKeys().includes('maxBudget'));
  assert.ok(!carriedKeys().includes('willingToPay'));
});

test('the allowlist is small enough to read, and holds no free-text key', () => {
  // A guard against the allowlist quietly becoming a passthrough. Every key here is a requirement a
  // supplier must meet; none of them is somewhere prose could live.
  const keys = carriedKeys();
  assert.ok(
    keys.length < 30,
    `${String(keys.length)} keys is too many to review; it should be a list`,
  );

  for (const suspicious of ['notes', 'note', 'comment', 'message', 'text', 'description', 'raw']) {
    assert.ok(!keys.includes(suspicious), `"${suspicious}" is where a customer message would hide`);
  }
});

test('a string that looks like a pasted message is refused wherever it appears', () => {
  // The guard that catches the accidental case: the paste that carries a contact detail along with
  // it. Somebody determined can still write prose with no phone number in it — which is why the
  // structural defence matters more, and why this is the belt rather than the braces.
  const leaks: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['a phone number in the description', { itemDescription: 'Cement, call me on 0771234567' }],
    ['an email in the description', { itemDescription: 'Cement — email nimal@example.com' }],
    ['"call me" in the description', { itemDescription: 'Cement, and call me after six please' }],
    ['a phone number in an attribute', { structured: { grade: 'OPC 43, ring 0771234567' } }],
  ];

  for (const [why, overrides] of leaks) {
    assert.throws(
      () =>
        buildSpecification({
          structured: { ...READING, ...((overrides.structured as object) ?? {}) },
          itemDescription:
            (overrides.itemDescription as string) ?? 'Ordinary Portland Cement, OPC 43',
          substitutionPolicy: 'none',
        }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'private-text-in-specification', why);
        return true;
      },
      `${why} was not caught`,
    );
  }
});

test('the item description is too short to hold a Need', () => {
  // The structural defence. A field long enough to hold a customer's whole message is a field that
  // will eventually hold one, pasted by somebody who thought it easier than filling in attributes.
  assert.throws(
    () =>
      buildSpecification({
        structured: READING,
        itemDescription: 'Cement. '.repeat(200),
        substitutionPolicy: 'none',
      }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-specification');
      return true;
    },
  );
});

test('an attribute that is not a string is refused rather than stringified', () => {
  // A supplier filters on attributes, so an object there is either meaningless or a nested field
  // nobody looked at — and guessing at one is how something private ends up on a supplier's screen.
  // The nested object is not a scalar, so the builder drops it rather than guessing at its shape.
  // Dropping is the right answer: what must not happen is the note reaching a supplier.
  const spec = buildSpecification({
    structured: { ...READING, grade: { value: 'OPC 43', sourceNote: 'the buyer said so' } },
    itemDescription: 'Cement',
    substitutionPolicy: 'none',
  });
  assert.ok(!serialise(spec).includes('the buyer said so'));
});

test('a tender nobody could quote for is refused rather than sent', () => {
  // Asking eleven strangers what the buyer meant is not a use of their time.
  assert.throws(
    () =>
      buildSpecification({
        structured: { quantity: 20 },
        itemDescription: 'Something',
        substitutionPolicy: 'none',
      }),
    /a supplier cannot quote for "something"/,
  );

  assert.throws(
    () =>
      buildSpecification({
        structured: { commodity: 'cement' },
        itemDescription: 'Cement',
        substitutionPolicy: 'none',
      }),
    /quoting for an unknown amount is guessing/,
  );
});

test('the words are not a parameter of anything in this module', async () => {
  // The structural defence, asserted structurally. If `openRfq` ever grows a way to accept prose,
  // this fails and somebody has to argue for it.
  const { service } = build();
  await assert.rejects(
    service.openRfq({
      rfqId: 'rfq_01HR0RFQleak01',
      requestId: NEED,
      accountId: BUYER,
      visibility: 'private',
      specification: specification(),
      closesAt: CLOSES,
      openedAt: NOW,
      correlationId: 'corr_01HR0RFQopen01',
      idempotencyKey: 'idem_rfq_leak_001',
      eventId: 'rev_01HR0RFQleak1',
      rawText: 'I need 20 tonnes of cement, ring me on 0771234567',
    } as never),
    (error: unknown) => {
      assert.equal(codeOf(error), 'foreign-concern');
      assert.match((error as Error).message, /a supplier never receives it/);
      return true;
    },
  );
});

test('no specification travels in an event', async () => {
  // An event is fanned out to every subscriber and kept indefinitely. A private tender whose
  // contents are in a shared log is not private.
  const { service, repository } = build();
  await anRfq(service, '0002');

  const published = JSON.stringify(repository.outbox().entries());
  assert.ok(published.includes('rfq.created'));
  assert.ok(published.includes('cement'), 'the category travels, because consumers route on it');
  assert.ok(!published.includes('OPC 43'), 'and the specification does not');
  assert.ok(!published.includes('SLS 107'));
  assert.ok(!published.includes('Ordinary Portland Cement'));
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

test('a supplier is invited by name, with a reason they could read', async () => {
  const { service } = build();
  const rfqId = await anRfq(service, '0003');

  const invited = await service.inviteSupplier({
    invitationId: 'inv_01HR0RFQ000031',
    rfqId,
    supplierAccountId: SUPPLIER_A,
    sourceRung: 'verified',
    reason: 'verified for cement and serves Matale',
    scorePerMille: 780,
    invitedAt: NOW,
    correlationId: 'corr_01HR0RFQinv01',
    idempotencyKey: 'idem_rfq_inv_0031',
  });

  assert.equal(invited.invitation.supplierAccountId, SUPPLIER_A);
  assert.equal(invited.invitation.sourceRung, 'verified');
  assert.equal(await service.isInvited(rfqId, SUPPLIER_A), true);
  assert.equal(await service.isInvited(rfqId, SUPPLIER_B), false);
});

test('an invitation without a reason is refused', async () => {
  // A supplier receiving an irrelevant tender is how a platform trains people to ignore it, so
  // every invitation has to answer "why me".
  const { service } = build();
  const rfqId = await anRfq(service, '0004');

  await assert.rejects(
    service.inviteSupplier({
      invitationId: 'inv_01HR0RFQ000041',
      rfqId,
      supplierAccountId: SUPPLIER_A,
      reason: 'because',
      invitedAt: NOW,
      correlationId: 'corr_01HR0RFQinv01',
      idempotencyKey: 'idem_rfq_inv_0041',
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-reason');
      return true;
    },
  );
});

test('inviting the same supplier twice is the first invitation, not a second email', async () => {
  const { service, repository } = build();
  const rfqId = await anRfq(service, '0005');

  const first = await service.inviteSupplier({
    invitationId: 'inv_01HR0RFQ000051',
    rfqId,
    supplierAccountId: SUPPLIER_A,
    reason: 'verified for cement and serves Matale',
    invitedAt: NOW,
    correlationId: 'corr_01HR0RFQinv01',
    idempotencyKey: 'idem_rfq_inv_0051',
  });
  const second = await service.inviteSupplier({
    invitationId: 'inv_01HR0RFQ000052',
    rfqId,
    supplierAccountId: SUPPLIER_A,
    reason: 'verified for cement and serves Matale',
    invitedAt: NOW,
    correlationId: 'corr_01HR0RFQinv01',
    idempotencyKey: 'idem_rfq_inv_0052',
  });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal((await service.listInvitations(rfqId)).length, 1);
  // One event and one audit record — both name the action, so the count is two rows for one
  // invitation. What matters is that a second invitation produced neither.
  const invitationEvents = repository
    .outbox()
    .entries()
    .filter((one) => one.kind === 'event' && JSON.stringify(one).includes('supplier_invited'));
  assert.equal(invitationEvents.length, 1, 'one notification, not two');
});

test('nobody is invited to a tender they cannot quote for', async () => {
  const { service } = build();
  const rfqId = await anRfq(service, '0006');
  await service.closeRfq({
    rfqId,
    reason: 'the window has passed',
    occurredAt: CLOSES,
    correlationId: 'corr_01HR0RFQcls01',
    idempotencyKey: 'idem_rfq_cls_0006',
    eventId: 'rev_01HR0RFQcls06',
  });

  await assert.rejects(
    service.inviteSupplier({
      invitationId: 'inv_01HR0RFQ000061',
      rfqId,
      supplierAccountId: SUPPLIER_A,
      reason: 'verified for cement and serves Matale',
      invitedAt: CLOSES,
      correlationId: 'corr_01HR0RFQinv01',
      idempotencyKey: 'idem_rfq_inv_0061',
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'rfq-closed');
      assert.match((error as Error).message, /teaches people to ignore it/);
      return true;
    },
  );
});

test('a supplier sees the tenders they were invited to, and no others', async () => {
  const { service } = build();
  const mine = await anRfq(service, '0007');
  const theirs = await anRfq(service, '0008');

  await service.inviteSupplier({
    invitationId: 'inv_01HR0RFQ000071',
    rfqId: mine,
    supplierAccountId: SUPPLIER_A,
    reason: 'verified for cement and serves Matale',
    invitedAt: NOW,
    correlationId: 'corr_01HR0RFQinv01',
    idempotencyKey: 'idem_rfq_inv_0071',
  });
  await service.inviteSupplier({
    invitationId: 'inv_01HR0RFQ000081',
    rfqId: theirs,
    supplierAccountId: SUPPLIER_B,
    reason: 'verified for cement and serves Kandy',
    invitedAt: NOW,
    correlationId: 'corr_01HR0RFQinv01',
    idempotencyKey: 'idem_rfq_inv_0081',
  });

  const inbox = await service.listInvitationsForSupplier(SUPPLIER_A);
  assert.deepEqual(
    inbox.map((one) => one.rfqId),
    [mine],
  );
});

// ---------------------------------------------------------------------------
// Closing once
// ---------------------------------------------------------------------------

test('a tender closes, is awarded, and cannot be either twice', async () => {
  const { service } = build();
  const rfqId = await anRfq(service, '0009');

  const closed = await service.closeRfq({
    rfqId,
    reason: 'the quoting window has passed',
    occurredAt: CLOSES,
    correlationId: 'corr_01HR0RFQcls01',
    idempotencyKey: 'idem_rfq_cls_0009',
    eventId: 'rev_01HR0RFQcls09',
  });
  assert.equal(closed.rfq.status, 'closed');

  // A closed tender may still be awarded: the window is for quoting, and a buyer deciding the
  // morning after should not have to reopen anything.
  const awarded = await service.awardRfq({
    rfqId,
    quoteId: 'qte_01HR0RFQquote01',
    reason: 'best landed cost and the earliest delivery',
    occurredAt: '2026-07-05T09:00:00.000000Z',
    correlationId: 'corr_01HR0RFQawd01',
    idempotencyKey: 'idem_rfq_awd_0009',
    eventId: 'rev_01HR0RFQawd09',
  });
  assert.equal(awarded.rfq.status, 'awarded');
  assert.equal(awarded.rfq.awardedQuoteId, 'qte_01HR0RFQquote01');

  await assert.rejects(
    service.awardRfq({
      rfqId,
      quoteId: 'qte_01HR0RFQquote02',
      reason: 'changing our mind after telling everybody',
      occurredAt: '2026-07-05T10:00:00.000000Z',
      correlationId: 'corr_01HR0RFQawd01',
      idempotencyKey: 'idem_rfq_awd_0099',
      eventId: 'rev_01HR0RFQawd99',
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'illegal-transition');
      assert.match(
        (error as Error).message,
        /a second decision, not a retry/,
        'awarding an already-awarded tender to somebody else is not idempotent: the losing ' +
          'suppliers have already been told, and the winner must not change silently afterwards',
      );
      return true;
    },
  );

  // And awarding the *same* quote again is a retry, which must still converge.
  const retried = await service.awardRfq({
    rfqId,
    quoteId: 'qte_01HR0RFQquote01',
    reason: 'best landed cost and the earliest delivery',
    occurredAt: '2026-07-05T09:00:01.000000Z',
    correlationId: 'corr_01HR0RFQawd02',
    idempotencyKey: 'idem_rfq_awd_0009',
    eventId: 'rev_01HR0RFQawd09',
  });
  assert.equal(retried.replayed, true);
  assert.equal(retried.rfq.awardedQuoteId, 'qte_01HR0RFQquote01');
});

test('cancelling is not closing, and suppliers are owed the difference', async () => {
  // "Somebody else won" and "it is not happening" are different outcomes, and a supplier who cannot
  // tell them apart cannot tell whether quoting here is worth their time.
  const { service, repository } = build();
  const rfqId = await anRfq(service, '0010');

  const cancelled = await service.cancelRfq({
    rfqId,
    reason: 'the buyer no longer needs it',
    occurredAt: NOW,
    correlationId: 'corr_01HR0RFQcan01',
    idempotencyKey: 'idem_rfq_can_0010',
    eventId: 'rev_01HR0RFQcan10',
  });

  assert.equal(cancelled.rfq.status, 'cancelled');
  const published = JSON.stringify(repository.outbox().entries());
  assert.ok(published.includes('rfq.cancelled'));
  assert.ok(!published.includes('rfq.awarded'));
});

test('a tender that closes before it opens is refused', async () => {
  // A window nobody could quote in is worse than no tender at all: suppliers see it and learn the
  // platform wastes their time.
  const { service } = build();

  await assert.rejects(
    service.openRfq({
      rfqId: 'rfq_01HR0RFQ0011',
      requestId: NEED,
      accountId: BUYER,
      visibility: 'private',
      specification: specification(),
      closesAt: '2026-07-01T08:00:00.000000Z',
      openedAt: NOW,
      correlationId: 'corr_01HR0RFQopen01',
      idempotencyKey: 'idem_rfq_open_0011',
      eventId: 'rev_01HR0RFQ0011',
    }),
    /must close after it opens/,
  );
});

test('a retry opens one tender', async () => {
  const { service } = build();
  const first = await service.openRfq({
    rfqId: 'rfq_01HR0RFQ0012',
    requestId: NEED,
    accountId: BUYER,
    visibility: 'private',
    specification: specification(),
    closesAt: CLOSES,
    openedAt: NOW,
    correlationId: 'corr_01HR0RFQopen01',
    idempotencyKey: 'idem_rfq_open_0012',
    eventId: 'rev_01HR0RFQ0012',
  });
  const second = await service.openRfq({
    rfqId: 'rfq_01HR0RFQ0012',
    requestId: NEED,
    accountId: BUYER,
    visibility: 'private',
    specification: specification(),
    closesAt: CLOSES,
    // A retry arrives later and under a fresh correlation id, by definition.
    openedAt: '2026-07-01T09:00:01.000000Z',
    correlationId: 'corr_01HR0RFQopen02',
    idempotencyKey: 'idem_rfq_open_0012',
    eventId: 'rev_01HR0RFQ0012',
  });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal((await service.listRfqsForRequest(NEED)).length, 1);
});

test('an award names the winner, and a non-award names none', async () => {
  // An awarded RFQ with no winner cannot say who was chosen; a winner on an unawarded one claims a
  // decision nobody made. The record refuses both.
  const { service } = build();
  const rfqId = await anRfq(service, '0013');
  const open = await service.getRfq(rfqId);
  assert.equal(open?.awardedQuoteId, null);

  const awarded = await service.awardRfq({
    rfqId,
    quoteId: 'qte_01HR0RFQquote13',
    reason: 'the only offer that met the specification',
    occurredAt: CLOSES,
    correlationId: 'corr_01HR0RFQawd01',
    idempotencyKey: 'idem_rfq_awd_0013',
    eventId: 'rev_01HR0RFQawd13',
  });
  assert.equal(awarded.rfq.awardedQuoteId, 'qte_01HR0RFQquote13');
});

test('the returned specification cannot be edited through the object handed back', async () => {
  const { service } = build();
  const rfqId = await anRfq(service, '0014');
  const rfq = await service.getRfq(rfqId);

  assert.throws(() => {
    (rfq?.specification.attributes as Record<string, string>).grade = 'OPC 53';
  }, 'what a supplier was asked to meet is what a dispute is judged against');
});
