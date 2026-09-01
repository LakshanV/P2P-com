/**
 * M-03 Commerce Request — keeping what somebody said, separately from every guess about it.
 *
 * This module is the front door of the product, and one claim carries it: **the original survives**.
 * A Need holds exactly what a person wrote, and an interpretation is a separate append-only record
 * pointing at it. So the suite is weighted towards the ways that could quietly stop being true —
 * an update path that rewrites the text, an interpretation that overwrites its predecessor, a
 * correction that erases the guess it corrected.
 *
 * The reason it matters is not tidiness. An interpretation is a guess, made by a model or a rule or
 * a person, and it will sometimes be wrong. A design that wrote the structured result back over the
 * raw text would destroy the only evidence of what was actually asked for — so a customer disputing
 * "I ordered the 6mm one" could be shown nothing but the platform's own opinion of what they meant.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CommerceRequestError,
  CommerceRequestService,
  InMemoryCommerceRequestRepository,
  MAXIMUM_RAW_TEXT_LENGTH,
  REQUEST_TRANSITIONS,
  type CommerceRequest,
} from '../modules/commerce-request/index.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = 'acct_01HR0NEEDbuyer1';
const NOW = '2026-07-01T09:00:00.000000Z';
const LATER = '2026-07-01T10:00:00.000000Z';

/** A Need somebody might actually send: imprecise, in their own words, with a deadline in it. */
const RAW = '  20 tonnes of cement, Matale, needed by Friday. Call me on 0771234567.  ';

function build(): {
  service: CommerceRequestService;
  repository: InMemoryCommerceRequestRepository;
} {
  const repository = new InMemoryCommerceRequestRepository();
  return { service: new CommerceRequestService(repository), repository };
}

async function aNeed(
  service: CommerceRequestService,
  tag = '0001',
  rawText = RAW,
): Promise<CommerceRequest> {
  const result = await service.captureNeed({
    requestId: `req_01HR0NEED${tag}`,
    accountId: ACCOUNT,
    channel: 'text',
    rawText,
    capturedAt: NOW,
    correlationId: 'corr_01HR0NEEDcap01',
    idempotencyKey: `idem_need_${tag}`,
  });
  return result.request;
}

const codeOf = (error: unknown): string | undefined =>
  error instanceof CommerceRequestError ? error.code : undefined;

// ---------------------------------------------------------------------------
// The original survives
// ---------------------------------------------------------------------------

test('a Need is stored exactly as it was written, whitespace and all', async () => {
  // Not trimmed, not normalised, not spell-corrected. A Need is compared against what the customer
  // typed, and "helpfully" trimming it means the stored evidence differs from what they would swear
  // they sent.
  const { service } = build();
  const need = await aNeed(service);

  assert.equal(need.rawText, RAW, 'byte for byte');
  assert.equal(need.status, 'captured');
  assert.equal(need.currentInterpretationId, null, 'nothing has guessed at it yet');
});

test('a telephone number in a Need is stored, not refused', async () => {
  // The identifier rules that govern every id in this repository deliberately do not govern this
  // field. "Call me on 0771234567 about the cement" is a Need, not a leak, and a platform that
  // refused it would be unable to accept the thing it exists to accept.
  const { service } = build();
  const need = await aNeed(service, '0002', 'Need a plumber, 0771234567, leaking pipe in Kandy');

  assert.match(need.rawText, /0771234567/);
});

test('there is no way to change what somebody said', () => {
  // The absence *is* the test. If a method to edit raw text ever appears, this fails and somebody
  // has to argue for it in a code review rather than adding it quietly.
  const { service } = build();
  const surface = new Set(
    Object.getOwnPropertyNames(Object.getPrototypeOf(service) as object).filter(
      (name) => name !== 'constructor',
    ),
  );

  for (const forbidden of ['updateRawText', 'editNeed', 'rewriteNeed', 'setRawText', 'normalise']) {
    assert.ok(!surface.has(forbidden), `${forbidden} must not exist: the original is evidence`);
  }

  // And what does exist is only what the module claims to do.
  assert.deepEqual([...surface].sort(), [
    'attachMedia',
    'cancelNeed',
    'captureNeed',
    'expireNeed',
    'getNeed',
    'interpret',
    'listHistory',
    'listInterpretations',
    'listMedia',
    'listNeedsForAccount',
    'markFulfilled',
    'markReady',
    'startSourcing',
  ]);
});

test('the database refuses to update raw_text, not just the service', () => {
  // Defence at the layer that survives a refactor. The service could gain an edit path by accident;
  // the trigger would still refuse it.
  const migration = readFileSync(
    path.join(REPO_ROOT, 'db/migrations/0049_create_module_commerce_request_schema.up.sql'),
    'utf8',
  );

  assert.match(migration, /request_raw_text_is_write_once/);
  assert.match(migration, /NEW\.raw_text IS DISTINCT FROM OLD\.raw_text/);
  assert.match(
    migration,
    /request_interpretation_is_append_only/,
    'a better reading is a new row, not an edit',
  );
});

// ---------------------------------------------------------------------------
// Interpretation appends
// ---------------------------------------------------------------------------

test('interpreting a Need adds a reading and leaves the words alone', async () => {
  const { service } = build();
  const need = await aNeed(service, '0003');

  const result = await service.interpret({
    requestId: need.requestId,
    interpretationId: 'int_01HR0NEED000001',
    origin: 'model',
    confidencePerMille: 820,
    structured: { item: 'cement', quantity: 20, unit: 'tonne', place: 'Matale' },
    aiRunId: 'airun_01HR0NEED0001',
    rationale: 'read a quantity, a unit, a commodity and a district from the text',
    interpretedAt: LATER,
    correlationId: 'corr_01HR0NEEDint01',
    idempotencyKey: 'idem_need_int_0001',
    eventId: 'evt_01HR0NEEDint01',
  });

  assert.equal(result.interpretation.version, 1);
  assert.equal(result.request.status, 'interpreted');
  assert.equal(result.request.currentInterpretationId, 'int_01HR0NEED000001');
  assert.equal(result.request.rawText, RAW, 'the words are untouched');
});

test('a correction is a new reading, and the wrong one is still there', async () => {
  // The whole point of the design. Somebody looking at a bad outcome months later can see what the
  // model thought, what the customer said it should have been, and when the platform changed its
  // mind — rather than only the answer that happens to be current.
  const { service } = build();
  const need = await aNeed(service, '0004', 'I need the 6mm bolts, two boxes');

  await service.interpret({
    requestId: need.requestId,
    interpretationId: 'int_01HR0NEED000010',
    origin: 'model',
    confidencePerMille: 610,
    structured: { item: 'bolt', size: '6cm', quantity: 2, unit: 'box' },
    aiRunId: 'airun_01HR0NEED0010',
    rationale: 'read the size as 6cm from an ambiguous abbreviation',
    interpretedAt: LATER,
    correlationId: 'corr_01HR0NEEDint10',
    idempotencyKey: 'idem_need_int_0010',
    eventId: 'evt_01HR0NEEDint10',
  });

  const corrected = await service.interpret({
    requestId: need.requestId,
    interpretationId: 'int_01HR0NEED000011',
    origin: 'human',
    confidencePerMille: 1000,
    structured: { item: 'bolt', size: '6mm', quantity: 2, unit: 'box' },
    rationale: 'the customer said 6mm, not 6cm',
    interpretedAt: '2026-07-01T11:00:00.000000Z',
    correlationId: 'corr_01HR0NEEDint11',
    idempotencyKey: 'idem_need_int_0011',
    eventId: 'evt_01HR0NEEDint11',
  });

  assert.equal(corrected.interpretation.version, 2);
  assert.equal(corrected.interpretation.origin, 'human');
  assert.equal(
    corrected.interpretation.supersedesInterpretationId,
    'int_01HR0NEED000010',
    'the chain records what it replaced, so a gap in versions does not break the history',
  );

  const history = await service.listInterpretations(need.requestId);
  assert.equal(history.length, 2, 'the wrong reading is not deleted');
  assert.equal(history[0]?.structured.size, '6cm', 'and it still says what it said');
  assert.equal(history[1]?.structured.size, '6mm');
});

test('a model reading must name its run, and a human one must not', async () => {
  // A wrong model reading has to be traceable to the model and prompt behind it, or it can only be
  // argued about. And a human reading carrying a run id would credit a model for a correction a
  // person made.
  const { service } = build();
  const need = await aNeed(service, '0005');

  await assert.rejects(
    service.interpret({
      requestId: need.requestId,
      interpretationId: 'int_01HR0NEED000020',
      origin: 'model',
      confidencePerMille: 500,
      structured: {},
      rationale: 'a model reading with nothing behind it',
      interpretedAt: LATER,
      correlationId: 'corr_01HR0NEEDint20',
      idempotencyKey: 'idem_need_int_0020',
      eventId: 'evt_01HR0NEEDint20',
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-record');
      assert.match((error as Error).message, /traced to the model and prompt/);
      return true;
    },
  );

  await assert.rejects(
    service.interpret({
      requestId: need.requestId,
      interpretationId: 'int_01HR0NEED000021',
      origin: 'human',
      confidencePerMille: 1000,
      structured: {},
      aiRunId: 'airun_01HR0NEED0021',
      rationale: 'a person correcting it, credited to a model',
      interpretedAt: LATER,
      correlationId: 'corr_01HR0NEEDint21',
      idempotencyKey: 'idem_need_int_0021',
      eventId: 'evt_01HR0NEEDint21',
    }),
    (error: unknown) => {
      assert.match((error as Error).message, /did not produce/);
      return true;
    },
  );
});

test('confidence is a whole per-mille, and a fraction is refused', async () => {
  // No floating-point value exists anywhere in this repository. A confidence stored as a double
  // compares unequal to itself across a round trip, and a sourcing threshold built on one drifts
  // without anybody editing it.
  const { service } = build();
  const need = await aNeed(service, '0006');

  for (const bad of [0.82, -1, 1001, Number.NaN]) {
    await assert.rejects(
      service.interpret({
        requestId: need.requestId,
        interpretationId: 'int_01HR0NEED000030',
        origin: 'rule',
        confidencePerMille: bad,
        structured: {},
        rationale: 'a confidence that is not a whole per-mille',
        interpretedAt: LATER,
        correlationId: 'corr_01HR0NEEDint30',
        idempotencyKey: 'idem_need_int_0030',
        eventId: 'evt_01HR0NEEDint30',
      }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'malformed-confidence', `${String(bad)} was accepted`);
        return true;
      },
    );
  }
});

test('an interpretation without a reason is refused', async () => {
  const { service } = build();
  const need = await aNeed(service, '0007');

  await assert.rejects(
    service.interpret({
      requestId: need.requestId,
      interpretationId: 'int_01HR0NEED000040',
      origin: 'rule',
      confidencePerMille: 900,
      structured: { item: 'cement' },
      rationale: 'ok',
      interpretedAt: LATER,
      correlationId: 'corr_01HR0NEEDint40',
      idempotencyKey: 'idem_need_int_0040',
      eventId: 'evt_01HR0NEEDint40',
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-rationale');
      assert.match((error as Error).message, /nobody can argue with later/);
      return true;
    },
  );
});

test('a returned interpretation cannot be edited through the object it was handed', async () => {
  // `structured` is an open object, so a shallow freeze would hand a caller a frozen wrapper around
  // a mutable understanding.
  const { service } = build();
  const need = await aNeed(service, '0008');
  const result = await service.interpret({
    requestId: need.requestId,
    interpretationId: 'int_01HR0NEED000050',
    origin: 'rule',
    confidencePerMille: 950,
    structured: { item: 'cement', spec: { grade: 'OPC 43' } },
    rationale: 'parsed from a structured order form',
    interpretedAt: LATER,
    correlationId: 'corr_01HR0NEEDint50',
    idempotencyKey: 'idem_need_int_0050',
    eventId: 'evt_01HR0NEEDint50',
  });

  assert.throws(() => {
    (result.interpretation.structured as Record<string, unknown>).item = 'sand';
  });
  assert.throws(() => {
    (result.interpretation.structured.spec as Record<string, unknown>).grade = 'OPC 53';
  }, 'the nested object must be frozen too, or the freeze is decorative');
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('a Need moves through its life, and the history says how', async () => {
  const { service } = build();
  const need = await aNeed(service, '0009');

  const ready = await service.markReady({
    requestId: need.requestId,
    reason: 'the buyer confirmed the quantity',
    occurredAt: LATER,
    correlationId: 'corr_01HR0NEEDrdy01',
    idempotencyKey: 'idem_need_rdy_0009',
    eventId: 'evt_01HR0NEEDrdy09',
  });
  assert.equal(ready.request.status, 'ready');

  await service.startSourcing({
    requestId: need.requestId,
    reason: 'the ladder started',
    occurredAt: '2026-07-01T11:00:00.000000Z',
    correlationId: 'corr_01HR0NEEDsrc01',
    idempotencyKey: 'idem_need_src_0009',
    eventId: 'evt_01HR0NEEDsrc09',
  });

  const done = await service.markFulfilled({
    requestId: need.requestId,
    reason: 'an order was placed against it',
    occurredAt: '2026-07-01T12:00:00.000000Z',
    correlationId: 'corr_01HR0NEEDful01',
    idempotencyKey: 'idem_need_ful_0009',
    eventId: 'evt_01HR0NEEDful09',
  });
  assert.equal(done.request.status, 'fulfilled');
  assert.equal(done.request.closedAt, '2026-07-01T12:00:00.000000Z');
  assert.equal(done.request.closureReason, 'an order was placed against it');

  const history = await service.listHistory(need.requestId);
  assert.deepEqual(
    history.map((one) => [one.fromStatus, one.toStatus]),
    [
      [null, 'captured'],
      ['captured', 'ready'],
      ['ready', 'sourcing'],
      ['sourcing', 'fulfilled'],
    ],
  );
});

test('expiry and cancellation are different endings', async () => {
  // "They changed their mind" and "we were too slow" are different failures, and only one of them
  // is ours. Collapsing them would hide the second inside the first, which is the direction that
  // flatters us.
  const { service } = build();
  const abandoned = await aNeed(service, '0010');
  const stale = await aNeed(service, '0011');

  const cancelled = await service.cancelNeed({
    requestId: abandoned.requestId,
    reason: 'the buyer no longer needs it',
    occurredAt: LATER,
    correlationId: 'corr_01HR0NEEDcan01',
    idempotencyKey: 'idem_need_can_0010',
    eventId: 'evt_01HR0NEEDcan10',
  });
  const expired = await service.expireNeed({
    requestId: stale.requestId,
    reason: 'nobody sourced it within the window',
    occurredAt: LATER,
    correlationId: 'corr_01HR0NEEDexp01',
    idempotencyKey: 'idem_need_exp_0011',
    eventId: 'evt_01HR0NEEDexp11',
  });

  assert.equal(cancelled.request.status, 'cancelled');
  assert.equal(expired.request.status, 'expired');
  assert.notEqual(cancelled.request.status, expired.request.status);
});

test('a Need that has ended refuses further change', async () => {
  const { service } = build();
  const need = await aNeed(service, '0012');
  await service.cancelNeed({
    requestId: need.requestId,
    reason: 'the buyer no longer needs it',
    occurredAt: LATER,
    correlationId: 'corr_01HR0NEEDcan02',
    idempotencyKey: 'idem_need_can_0012',
    eventId: 'evt_01HR0NEEDcan12',
  });

  await assert.rejects(
    service.interpret({
      requestId: need.requestId,
      interpretationId: 'int_01HR0NEED000060',
      origin: 'rule',
      confidencePerMille: 900,
      structured: {},
      rationale: 'interpreting something nobody wants any more',
      interpretedAt: '2026-07-01T12:00:00.000000Z',
      correlationId: 'corr_01HR0NEEDint60',
      idempotencyKey: 'idem_need_int_0060',
      eventId: 'evt_01HR0NEEDint60',
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'request-closed');
      return true;
    },
  );

  await assert.rejects(
    service.markReady({
      requestId: need.requestId,
      reason: 'reopening a cancelled Need',
      occurredAt: '2026-07-01T12:00:00.000000Z',
      correlationId: 'corr_01HR0NEEDrdy02',
      idempotencyKey: 'idem_need_rdy_0012',
      eventId: 'evt_01HR0NEEDrdy12',
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'request-closed');
      assert.match((error as Error).message, /an ending is a fact/);
      return true;
    },
  );
});

test('repeating a transition already made is the answer, not a refusal', async () => {
  // A caller retrying a cancellation it is not sure landed must not be told the Need is already
  // cancelled as though that were a problem.
  const { service } = build();
  const need = await aNeed(service, '0013');
  const move = {
    requestId: need.requestId,
    reason: 'the buyer no longer needs it',
    occurredAt: LATER,
    correlationId: 'corr_01HR0NEEDcan03',
    idempotencyKey: 'idem_need_can_0013',
    eventId: 'evt_01HR0NEEDcan13',
  };

  const first = await service.cancelNeed(move);
  const second = await service.cancelNeed(move);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal((await service.listHistory(need.requestId)).length, 2, 'one capture, one cancel');
});

test('every terminal status is genuinely terminal', () => {
  for (const status of ['fulfilled', 'cancelled', 'expired'] as const) {
    assert.deepEqual(
      [...REQUEST_TRANSITIONS[status]],
      [],
      `${status} must lead nowhere: an ending is a fact rather than a state to move out of`,
    );
  }
  // And cancellation is reachable from every live state, because a person may always change their
  // mind — a Need they cannot withdraw is a Need that keeps working after they stopped wanting it.
  for (const status of ['captured', 'interpreted', 'ready', 'sourcing'] as const) {
    assert.ok(
      REQUEST_TRANSITIONS[status].includes('cancelled'),
      `${status} must permit cancellation`,
    );
  }
});

// ---------------------------------------------------------------------------
// Idempotency and boundaries
// ---------------------------------------------------------------------------

test('a retry a second later, under a fresh correlation id, converges', async () => {
  // The defect M-11, M-12, M-13 and M-04 each shipped once. A retry is a different request that
  // means the same thing: it arrives later and carries a fresh correlation id by definition, and a
  // module that called that a key reuse would tell a client to send a new key — which creates a
  // second Need.
  const { service } = build();
  const first = await service.captureNeed({
    requestId: 'req_01HR0NEEDretry1',
    accountId: ACCOUNT,
    channel: 'text',
    rawText: 'a Need the client retried',
    capturedAt: NOW,
    correlationId: 'corr_01HR0NEEDfst01',
    idempotencyKey: 'idem_need_retry_01',
  });
  const second = await service.captureNeed({
    requestId: 'req_01HR0NEEDretry1',
    accountId: ACCOUNT,
    channel: 'text',
    rawText: 'a Need the client retried',
    capturedAt: '2026-07-01T09:00:01.000000Z',
    correlationId: 'corr_01HR0NEEDsnd01',
    idempotencyKey: 'idem_need_retry_01',
  });

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.request.requestId, first.request.requestId);
});

test('the same key for genuinely different words is refused', async () => {
  const { service } = build();
  await service.captureNeed({
    requestId: 'req_01HR0NEEDkey001',
    accountId: ACCOUNT,
    channel: 'text',
    rawText: 'twenty tonnes of cement',
    capturedAt: NOW,
    correlationId: 'corr_01HR0NEEDkey01',
    idempotencyKey: 'idem_need_key_0001',
  });

  await assert.rejects(
    service.captureNeed({
      requestId: 'req_01HR0NEEDkey002',
      accountId: ACCOUNT,
      channel: 'text',
      rawText: 'a plumber, urgently',
      capturedAt: NOW,
      correlationId: 'corr_01HR0NEEDkey02',
      idempotencyKey: 'idem_need_key_0001',
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'idempotency-key-reuse');
      return true;
    },
  );
});

test('a field belonging to another module is refused with the owner named', async () => {
  // M-03 sits at the front of the platform, so a caller most naturally reaches for something
  // downstream. Saying who owns it is the difference between a useful refusal and a puzzle.
  const { service } = build();

  for (const [field, expected] of [
    ['matchedListingId', /M-07 Matching/],
    ['orderId', /M-11 Orders/],
    ['price', /M-14 Commission Rules/],
    ['allowed', /K-04 Permissions/],
    ['listingId', /M-04 Universal Listing/],
  ] as const) {
    await assert.rejects(
      service.captureNeed({
        requestId: 'req_01HR0NEEDfgn001',
        accountId: ACCOUNT,
        channel: 'text',
        rawText: 'a Need carrying somebody else’s concern',
        capturedAt: NOW,
        correlationId: 'corr_01HR0NEEDfgn01',
        idempotencyKey: 'idem_need_fgn_0001',
        [field]: 'anything',
      }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'foreign-concern', `${field} was accepted`);
        assert.match((error as Error).message, expected);
        return true;
      },
    );
  }
});

test('an empty Need and an unbounded one are both refused', async () => {
  const { service } = build();

  for (const bad of ['', '   ', '\n\t ']) {
    await assert.rejects(
      service.captureNeed({
        requestId: 'req_01HR0NEEDempty1',
        accountId: ACCOUNT,
        channel: 'text',
        rawText: bad,
        capturedAt: NOW,
        correlationId: 'corr_01HR0NEEDemp01',
        idempotencyKey: 'idem_need_empty_01',
      }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'malformed-raw-text');
        return true;
      },
    );
  }

  await assert.rejects(
    service.captureNeed({
      requestId: 'req_01HR0NEEDlong01',
      accountId: ACCOUNT,
      channel: 'text',
      rawText: 'x'.repeat(MAXIMUM_RAW_TEXT_LENGTH + 1),
      capturedAt: NOW,
      correlationId: 'corr_01HR0NEEDlng01',
      idempotencyKey: 'idem_need_long_01',
    }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'malformed-raw-text');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// What leaves the module
// ---------------------------------------------------------------------------

test('the words never appear in an event or an audit record', async () => {
  // An event is fanned out to every subscriber, forwarded to the audit log and kept indefinitely.
  // Publishing the raw text would take the one field deliberately exempt from the identifier rules
  // and spray it across the platform.
  const { service, repository } = build();
  const need = await aNeed(service, '0014', 'twenty tonnes of cement for Nimal on 0771234567');

  await service.markReady({
    requestId: need.requestId,
    reason: 'the buyer confirmed it',
    occurredAt: LATER,
    correlationId: 'corr_01HR0NEEDpub01',
    idempotencyKey: 'idem_need_pub_0014',
    eventId: 'evt_01HR0NEEDpub14',
  });

  const published = JSON.stringify(repository.outbox().entries());
  assert.ok(published.length > 0, 'something was published, or this test proves nothing');
  assert.ok(!published.includes('cement'), 'the words must not travel');
  assert.ok(!published.includes('0771234567'), 'and certainly not a telephone number');
  assert.ok(!published.includes('Nimal'), 'nor a name');
  assert.ok(
    published.includes('raw_text_length'),
    'the length does travel, so a consumer can tell a one-word Need from a specification',
  );
});

test('the module reads no clock and generates no randomness', () => {
  // Determinism is what lets a retry converge and a test pin time. A module that read a clock could
  // not be replayed, and one that minted an id could not be made idempotent.
  const directory = path.join(REPO_ROOT, 'modules/commerce-request');
  const forbidden = [/Date\.now\(/, /new Date\(/, /Math\.random\(/, /crypto\.randomUUID\(/];

  for (const file of ['service.ts', 'repository.ts', 'validate.ts', 'registry.ts', 'outbox.ts']) {
    const source = readFileSync(path.join(directory, file), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(
        pattern.exec(source) === null,
        `${file} uses ${String(pattern)}; the caller supplies every instant and identifier`,
      );
    }
  }
});
