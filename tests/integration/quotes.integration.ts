/**
 * M-10 Quotes against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 *
 * Migration 0053 declares things TypeScript cannot, and each is proved here by issuing the offending
 * statement rather than by asserting that the service does not issue it. The service has no path
 * that would try, which is exactly the case a trigger exists for: the defence has to survive
 * somebody adding one.
 *
 * **An offer binds.** `quote_terms_are_immutable` refuses any UPDATE touching the price, the
 * quantity, the lead time, the terms or the validity; it refuses DELETE; and it refuses to move an
 * offer that has already ended. Each is tested with raw SQL, because a market where an accepted
 * offer can be quietly revised is not a market.
 *
 * **Amounts survive exactly.** The prices here are deliberately larger than `Number.MAX_SAFE_INTEGER`
 * so that a driver, a projection or a validator that read them through a double would round them and
 * be caught. No unit test against an in-memory store can catch that, because in memory the bigint
 * never leaves the process.
 *
 * **Microseconds survive.** `valid_until` is when an offer stops binding. A driver that parsed it
 * into a `Date` would round it to the millisecond and apply a time zone the column does not have.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryQuoteRepository,
  PostgresQuoteRepository,
  QuoteError,
  QuoteService,
  type TenderFacts,
  type TenderSource,
} from '../../modules/quotes/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import { parseInstant } from '../../platform/time/instant.ts';
import type { Database } from '../../platform/db/client.ts';

import { liveTestOptions, withTestDatabase } from './harness.ts';

const RFQ = 'rfq_live_quote00001';
const SUPPLIER_A = 'acct_live_quotesupA';
const SUPPLIER_B = 'acct_live_quotesupB';
const BUYER = 'acct_live_quotebuyer';

const NOW = '2026-07-01T09:00:00.000000Z';
const LATER = '2026-07-01T11:30:00.000000Z';
const VALID_UNTIL = '2026-07-08T09:00:00.123456Z';

/**
 * Larger than `Number.MAX_SAFE_INTEGER` (9007199254740991) on purpose.
 *
 * A double cannot hold this, so anything on the path that reads it as one rounds it. In LKR cents
 * this is an implausible order; the point is not the plausibility but that the platform must not
 * silently change a number somebody is charged.
 */
const HUGE_TOTAL = 90_071_992_547_409_931n;
const HUGE_UNIT = 9_007_199_254_740_993n;

class StubTenders implements TenderSource {
  findTender(rfqId: string): Promise<TenderFacts | null> {
    return Promise.resolve(
      rfqId === RFQ
        ? {
            rfqId: RFQ,
            status: 'open',
            quantity: 20n,
            substitutionPolicy: 'equivalent-with-disclosure',
            requiredBy: '2026-07-15T09:00:00.000000Z',
            qualityRequirements: ['SLS 107 certified'],
          }
        : null,
    );
  }

  isInvited(_rfqId: string, supplierAccountId: string): Promise<boolean> {
    return Promise.resolve(supplierAccountId === SUPPLIER_A || supplierAccountId === SUPPLIER_B);
  }
}

function serviceFor(database: Database): QuoteService {
  return new QuoteService(new PostgresQuoteRepository(database), new StubTenders());
}

/** The error message when the statement is refused, or null when it succeeded. */
async function refuses(database: Database, sql: string): Promise<string | null> {
  const client = await database.connect();
  try {
    await client.query(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await client.release();
  }
}

interface OfferOptions {
  readonly tag?: string;
  readonly supplierAccountId?: string;
  readonly kind?: string;
  readonly quantity?: bigint;
  readonly unitPriceMinor?: bigint;
  readonly totalMinor?: bigint;
  readonly substitutionNote?: string | null;
  readonly leadTimeDays?: number;
  readonly validUntil?: string;
}

function submit(service: QuoteService, options: OfferOptions = {}) {
  const tag = options.tag ?? '00001';
  return service.submitQuote({
    quoteId: `quo_live_quote${tag}`,
    rfqId: RFQ,
    supplierAccountId: options.supplierAccountId ?? SUPPLIER_A,
    kind: options.kind ?? 'full',
    quantity: options.quantity ?? 20n,
    unitPriceMinor: options.unitPriceMinor ?? 1_250_000n,
    totalMinor: options.totalMinor ?? 25_000_000n,
    currency: 'LKR',
    leadTimeDays: options.leadTimeDays ?? 5,
    deliveryTerms: 'delivered',
    validUntil: options.validUntil ?? VALID_UNTIL,
    substitutionNote: options.substitutionNote ?? null,
    evidenceReferences: ['doc_live_quotecert1'],
    submittedAt: NOW,
    correlationId: `corr_live_quote${tag}`,
    idempotencyKey: `idem_live_quote${tag}`,
  });
}

test(
  'an offer round-trips through PostgreSQL with its amounts exact',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      await submit(service, {
        tag: '00001',
        unitPriceMinor: HUGE_UNIT,
        totalMinor: HUGE_TOTAL,
      });

      const readBack = await service.getQuote('quo_live_quote00001');
      assert.ok(readBack !== null);
      assert.equal(
        readBack.totalMinor,
        HUGE_TOTAL,
        'an amount larger than a double can hold survives the round trip. Anything that read this ' +
          'through Number would round it, and a price rounded on the way out is a price somebody ' +
          'is charged',
      );
      assert.equal(readBack.unitPriceMinor, HUGE_UNIT);
      assert.equal(readBack.quantity, 20n);
      assert.equal(readBack.currency, 'LKR');
      assert.deepEqual(readBack.evidenceReferences, ['doc_live_quotecert1']);

      // Instants compare as instants, not as spellings: formatInstant trims trailing zeros, so the
      // canonical form of a stored row differs in text from what the caller wrote.
      assert.equal(
        parseInstant(readBack.validUntil).epochMicros,
        parseInstant(VALID_UNTIL).epochMicros,
        'microsecond precision survives, because the column is projected as text rather than handed ' +
          'to the driver as a Date',
      );
    });
  },
);

test('the database refuses to change the terms of an offer', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    await submit(serviceFor(database), { tag: '00002' });

    const repriced = await refuses(
      database,
      `UPDATE module_quotes.quote SET total_minor = 1
        WHERE quote_id = 'quo_live_quote00002';`,
    );
    assert.match(
      repriced ?? '',
      /cannot be changed after submission/,
      'the offer you accepted must be the offer you saw',
    );

    const requantified = await refuses(
      database,
      `UPDATE module_quotes.quote SET quantity = 1 WHERE quote_id = 'quo_live_quote00002';`,
    );
    assert.match(requantified ?? '', /cannot be changed after submission/);

    const extended = await refuses(
      database,
      `UPDATE module_quotes.quote SET valid_until = valid_until + interval '30 days'
        WHERE quote_id = 'quo_live_quote00002';`,
    );
    assert.match(extended ?? '', /cannot be changed after submission/);

    const deleted = await refuses(
      database,
      `DELETE FROM module_quotes.quote WHERE quote_id = 'quo_live_quote00002';`,
    );
    assert.match(deleted ?? '', /cannot be deleted/);
  });
});

test('the database refuses to reopen an offer that has ended', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);
    await submit(service, { tag: '00003' });

    await service.withdrawQuote({
      quoteId: 'quo_live_quote00003',
      actingAccountId: SUPPLIER_A,
      reason: 'the cement went to another buyer this morning',
      occurredAt: LATER,
      correlationId: 'corr_live_quotewd01',
      idempotencyKey: 'idem_live_quotewd01',
    });

    const reopened = await refuses(
      database,
      `UPDATE module_quotes.quote SET status = 'submitted', closed_at = NULL, closure_reason = NULL
        WHERE quote_id = 'quo_live_quote00003';`,
    );
    assert.match(
      reopened ?? '',
      /already withdrawn/,
      'a supplier must not be able to take back a rejection, or a buyer a withdrawal',
    );
  });
});

test(
  'the database refuses an undeclared substitution in either direction',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });

      const undeclared = await refuses(
        database,
        `INSERT INTO module_quotes.quote
         (quote_id, rfq_id, supplier_account_id, kind, status, quantity, unit_price_minor,
          total_minor, currency, lead_time_days, delivery_terms, valid_until, substitution_note,
          evidence_references, submitted_at, updated_at, closed_at, closure_reason,
          correlation_id, idempotency_key)
       VALUES ('quo_live_quote00004', '${RFQ}', '${SUPPLIER_A}', 'substitute', 'submitted', 20,
               1250000, 25000000, 'LKR', 5, 'delivered', '2026-07-08T09:00:00Z', NULL,
               '[]'::jsonb, '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', NULL, NULL,
               'corr_live_quote00004', 'idem_live_quote00004');`,
      );
      assert.match(undeclared ?? '', /quote_substitution_declared/);

      const overdeclared = await refuses(
        database,
        `INSERT INTO module_quotes.quote
         (quote_id, rfq_id, supplier_account_id, kind, status, quantity, unit_price_minor,
          total_minor, currency, lead_time_days, delivery_terms, valid_until, substitution_note,
          evidence_references, submitted_at, updated_at, closed_at, closure_reason,
          correlation_id, idempotency_key)
       VALUES ('quo_live_quote00005', '${RFQ}', '${SUPPLIER_A}', 'full', 'submitted', 20,
               1250000, 25000000, 'LKR', 5, 'delivered', '2026-07-08T09:00:00Z',
               'a difference nobody is offering', '[]'::jsonb, '2026-07-01T09:00:00Z',
               '2026-07-01T09:00:00Z', NULL, NULL, 'corr_live_quote00005',
               'idem_live_quote00005');`,
      );
      assert.match(overdeclared ?? '', /quote_substitution_declared/);
    });
  },
);

test('the database refuses an offer that expires as it arrives', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const lapsed = await refuses(
      database,
      `INSERT INTO module_quotes.quote
         (quote_id, rfq_id, supplier_account_id, kind, status, quantity, unit_price_minor,
          total_minor, currency, lead_time_days, delivery_terms, valid_until, substitution_note,
          evidence_references, submitted_at, updated_at, closed_at, closure_reason,
          correlation_id, idempotency_key)
       VALUES ('quo_live_quote00006', '${RFQ}', '${SUPPLIER_A}', 'full', 'submitted', 20,
               1250000, 25000000, 'LKR', 5, 'delivered', '2026-07-01T09:00:00Z', NULL,
               '[]'::jsonb, '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', NULL, NULL,
               'corr_live_quote00006', 'idem_live_quote00006');`,
    );
    assert.match(lapsed ?? '', /quote_valid_after_submission/);
  });
});

test('an identifier that is a natural key is refused by the schema', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const natural = await refuses(
      database,
      `INSERT INTO module_quotes.quote
         (quote_id, rfq_id, supplier_account_id, kind, status, quantity, unit_price_minor,
          total_minor, currency, lead_time_days, delivery_terms, valid_until, substitution_note,
          evidence_references, submitted_at, updated_at, closed_at, closure_reason,
          correlation_id, idempotency_key)
       VALUES ('quo_live_quote00007', '${RFQ}', 'supplier@example.com', 'full', 'submitted', 20,
               1250000, 25000000, 'LKR', 5, 'delivered', '2026-07-08T09:00:00Z', NULL,
               '[]'::jsonb, '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', NULL, NULL,
               'corr_live_quote00007', 'idem_live_quote00007');`,
    );
    assert.match(
      natural ?? '',
      /quote_supplier_opaque/,
      'an address in an identifier publishes personal data into every row that copies it',
    );
  });
});

test(
  'a reused idempotency key is reported in the module’s own vocabulary',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      await submit(service, { tag: '00008' });

      // A different offer, the same key. The unique constraint fires in the driver, and the adapter
      // translates it: a caller needs to know what it did wrong, not which constraint name it hit.
      await assert.rejects(
        service.submitQuote({
          quoteId: 'quo_live_quote00009',
          rfqId: RFQ,
          supplierAccountId: SUPPLIER_B,
          kind: 'full',
          quantity: 20n,
          unitPriceMinor: 1_000_000n,
          totalMinor: 20_000_000n,
          currency: 'LKR',
          leadTimeDays: 3,
          deliveryTerms: 'delivered',
          validUntil: VALID_UNTIL,
          evidenceReferences: [],
          submittedAt: NOW,
          correlationId: 'corr_live_quote00009',
          idempotencyKey: 'idem_live_quote00008',
        }),
        (error: unknown) => error instanceof QuoteError && error.code === 'idempotency-key-reuse',
      );
    });
  },
);

test('the PostgreSQL adapter and the in-memory one agree', liveTestOptions, async () => {
  // The in-memory repository is a reference implementation, and a reference that disagrees with the
  // real one is worse than none: every unit test written against it would be proving the wrong
  // thing.
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const live = serviceFor(database);
    const memory = new QuoteService(new InMemoryQuoteRepository(), new StubTenders());

    for (const service of [live, memory]) {
      await submit(service, { tag: '00010', supplierAccountId: SUPPLIER_A });
      await submit(service, {
        tag: '00011',
        supplierAccountId: SUPPLIER_B,
        kind: 'partial',
        quantity: 12n,
        totalMinor: 14_000_000n,
        leadTimeDays: 2,
      });
      await service.withdrawQuote({
        quoteId: 'quo_live_quote00010',
        actingAccountId: SUPPLIER_A,
        reason: 'stock committed elsewhere this morning',
        occurredAt: LATER,
        correlationId: 'corr_live_quotewd02',
        idempotencyKey: 'idem_live_quotewd02',
      });
    }

    const shape = async (service: QuoteService): Promise<unknown> =>
      (await service.listQuotesForRfq(RFQ)).map((quote) => ({
        quoteId: quote.quoteId,
        status: quote.status,
        kind: quote.kind,
        quantity: quote.quantity.toString(),
        totalMinor: quote.totalMinor.toString(),
        closureReason: quote.closureReason,
      }));

    assert.deepEqual(await shape(live), await shape(memory));

    const evaluate = async (service: QuoteService): Promise<unknown> =>
      (
        await service.evaluateQuotes({
          rfqId: RFQ,
          now: LATER,
          reliability: { [SUPPLIER_A]: 900, [SUPPLIER_B]: 400 },
        })
      ).map((one) => [one.quoteId, one.rank, one.scorePerMille, one.recommended]);

    assert.deepEqual(
      await evaluate(live),
      await evaluate(memory),
      'and the ranking is the same, because it is computed from the offers rather than stored',
    );
  });
});

test(
  'an accepted offer, its event and its audit record commit together',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      await submit(service, { tag: '00012' });
      await service.acceptQuote({
        quoteId: 'quo_live_quote00012',
        actingAccountId: BUYER,
        reason: 'best available on the date we need it',
        occurredAt: LATER,
        correlationId: 'corr_live_quoteac01',
        idempotencyKey: 'idem_live_quoteac01',
      });

      const client = await database.connect();
      try {
        const rows = await client.query<{ kind: string; payload: Record<string, unknown> }>(
          `SELECT kind, payload FROM module_quotes.outbox ORDER BY outbox_id;`,
        );

        const events = rows.rows.filter((row) => row.kind === 'event');
        const audits = rows.rows.filter((row) => row.kind === 'audit');
        assert.equal(events.length, 2, 'one for the submission and one for the acceptance');
        assert.equal(audits.length, 2);

        const published = JSON.stringify(events);
        assert.ok(
          !published.includes('25000000'),
          'no price travels in an event: the log is read by every subscriber and kept indefinitely',
        );
        assert.ok(published.includes('quote.accepted'));

        assert.ok(
          JSON.stringify(audits).includes('25000000'),
          'and the audit record does carry it, because it answers what was actually agreed',
        );
      } finally {
        await client.release();
      }
    });
  },
);
