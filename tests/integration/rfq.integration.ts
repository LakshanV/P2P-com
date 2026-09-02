/**
 * M-09 RFQ against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 *
 * Migration 0052 declares four things TypeScript cannot, and each is proved here by issuing the
 * offending statement rather than by asserting that the service does not issue it.
 *
 * **There is nowhere to hide a customer's words.** The specification is flattened across named,
 * typed columns and `item_description` is capped at 500 characters. A `jsonb` blob would have been a
 * place a pasted message could sit unnoticed; a schema with no hiding place is the version of the
 * privacy rule that survives somebody editing the specification builder. Tested by trying to store
 * a message-length description directly.
 *
 * **One invitation per supplier per tender.** `UNIQUE (rfq_id, supplier_account_id)` makes inviting
 * somebody twice impossible rather than merely discouraged. A platform that sends duplicate
 * invitations is one people filter out.
 *
 * **Invitations and transitions are append-only.** A supplier has already seen the tender, and
 * rewriting the record of what they were told would make it disagree with what happened.
 *
 * **An award names exactly one winner, in both directions.** An awarded tender with no winner
 * cannot say who was chosen; a winner on an unawarded tender claims a decision nobody made.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryRfqRepository,
  PostgresRfqRepository,
  RfqError,
  RfqService,
  buildSpecification,
  type RfqSpecification,
} from '../../modules/rfq/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import { parseInstant } from '../../platform/time/instant.ts';
import type { Database } from '../../platform/db/client.ts';

import { liveTestOptions, withTestDatabase } from './harness.ts';

const BUYER = 'acct_live_rfqbuyer01';
const SUPPLIER_A = 'acct_live_rfqsupplA1';
const SUPPLIER_B = 'acct_live_rfqsupplB1';
const NEED = 'req_live_rfqneed0001';
const RUN = 'mrun_live_rfqrun0001';

const NOW = '2026-07-01T09:00:00.000000Z';
const LATER = '2026-07-02T09:00:00.000000Z';
const CLOSES = '2026-07-04T17:00:00.123456Z';

/**
 * A quantity larger than `Number.MAX_SAFE_INTEGER`.
 *
 * Implausible as tonnes of cement and entirely plausible as a unit of something small, and either
 * way the platform must not silently change it. Anything on the path that read the `bigint` column
 * through a double would round this and be caught here — never by a unit test, where the value
 * never leaves the process.
 */
const HUGE_QUANTITY = 9_007_199_254_740_993n;

function specification(overrides: Record<string, unknown> = {}): RfqSpecification {
  return buildSpecification({
    structured: {
      commodity: 'cement',
      quantity: 20,
      unit: 'tonne',
      district: 'matale',
      grade: 'OPC 43',
      requiredBy: '2026-07-05T09:00:00.000000Z',
      ...overrides,
    },
    itemDescription: 'Ordinary Portland Cement, OPC 43 grade, delivered in bulk',
    substitutionPolicy: 'equivalent-with-disclosure',
    qualityRequirements: ['SLS 107 certified'],
  });
}

function serviceFor(database: Database): RfqService {
  return new RfqService(new PostgresRfqRepository(database));
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

async function openTender(
  service: RfqService,
  tag = '0001',
  spec: RfqSpecification = specification(),
): Promise<string> {
  const rfqId = `rfq_live_rfq${tag}`;
  await service.openRfq({
    rfqId,
    eventId: `evt_live_rfq${tag}open`,
    requestId: NEED,
    accountId: BUYER,
    matchRunId: RUN,
    visibility: 'private',
    specification: spec,
    closesAt: CLOSES,
    openedAt: NOW,
    correlationId: `corr_live_rfq${tag}`,
    idempotencyKey: `idem_live_rfq${tag}`,
  });
  return rfqId;
}

test(
  'a tender round-trips through PostgreSQL with its quantity exact',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      await openTender(
        service,
        '0001',
        specification({ quantity: HUGE_QUANTITY.toString(), unit: 'sachet' }),
      );

      const readBack = await service.getRfq('rfq_live_rfq0001');
      assert.ok(readBack !== null);
      assert.equal(
        readBack.specification.quantity,
        HUGE_QUANTITY,
        'a quantity larger than a double can hold survives, because nothing on the path reads the ' +
          'bigint column through Number',
      );
      assert.equal(readBack.specification.category, 'cement');
      assert.equal(readBack.specification.unit, 'sachet');
      assert.equal(readBack.specification.substitutionPolicy, 'equivalent-with-disclosure');
      assert.deepEqual(readBack.specification.qualityRequirements, ['SLS 107 certified']);
      assert.equal(readBack.specification.attributes.grade, 'OPC 43');
      assert.equal(readBack.status, 'open');

      assert.equal(
        parseInstant(readBack.closesAt).epochMicros,
        parseInstant(CLOSES).epochMicros,
        'microsecond precision survives on the instant after which no offer is accepted',
      );
    });
  },
);

test('the schema has nowhere to hide a customer’s words', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    // A pasted message, at message length. The cap is the point: a field long enough to hold one
    // will eventually hold one, put there by somebody who thought it easier than filling in the
    // attributes.
    const message = 'x'.repeat(501);
    const pasted = await refuses(
      database,
      `INSERT INTO module_rfq.rfq
         (rfq_id, request_id, account_id, match_run_id, status, visibility, category,
          item_description, quantity, unit, attributes, delivery_district, required_by, condition,
          quality_requirements, substitution_policy, attachment_references, closes_at, opened_at,
          updated_at, closed_at, awarded_quote_id, closure_reason, correlation_id, idempotency_key)
       VALUES ('rfq_live_rfq0002', '${NEED}', '${BUYER}', NULL, 'open', 'private', 'cement',
               '${message}', 20, 'tonne', '{}'::jsonb, NULL, NULL, NULL, '[]'::jsonb,
               'equivalent-with-disclosure', '[]'::jsonb, '2026-07-04T17:00:00Z',
               '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', NULL, NULL, NULL,
               'corr_live_rfq0002', 'idem_live_rfq0002');`,
    );
    assert.match(pasted ?? '', /rfq_item_description_bounded/);

    // And there is no other column to put one in instead. Asserted as an exact set rather than by
    // pattern, so adding a `notes` or `buyer_message` column fails this test rather than passing it
    // for want of a pattern nobody thought of.
    const client = await database.connect();
    try {
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'module_rfq' AND table_name = 'rfq'
          ORDER BY column_name;`,
      );

      assert.deepEqual(
        columns.rows.map((row) => row.column_name),
        [
          'account_id',
          'attachment_references',
          'attributes',
          'awarded_quote_id',
          'category',
          'closed_at',
          'closes_at',
          'closure_reason',
          'condition',
          'correlation_id',
          'delivery_district',
          'idempotency_key',
          'item_description',
          'match_run_id',
          'opened_at',
          'quality_requirements',
          'quantity',
          'request_id',
          'required_by',
          'rfq_id',
          'status',
          'substitution_policy',
          'unit',
          'updated_at',
          'visibility',
        ],
        'the tender table holds exactly these columns. The only free text a supplier sees is ' +
          'item_description, and it is capped',
      );
    } finally {
      await client.release();
    }
  });
});

test('a supplier cannot be invited to the same tender twice', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);
    const rfqId = await openTender(service, '0003');

    await service.inviteSupplier({
      rfqId,
      invitationId: 'inv_live_rfq00000001',
      supplierAccountId: SUPPLIER_A,
      sourceRung: 'verified',
      reason: 'verified supplier for cement in this district, with prior deliveries',
      scorePerMille: 820,
      invitedAt: NOW,
      correlationId: 'corr_live_rfqinv001',
      idempotencyKey: 'idem_live_rfqinv001',
    });

    // A second rung finding the same supplier is not a reason to ask twice. The service converges
    // on the invitation that already exists rather than failing: the caller's intent — this
    // supplier should be invited — is satisfied, and they have already been told.
    const again = await service.inviteSupplier({
      rfqId,
      invitationId: 'inv_live_rfq00000002',
      supplierAccountId: SUPPLIER_A,
      sourceRung: 'known',
      reason: 'found again by a second rung, which is not a reason to ask twice',
      scorePerMille: 640,
      invitedAt: LATER,
      correlationId: 'corr_live_rfqinv002',
      idempotencyKey: 'idem_live_rfqinv002',
    });

    assert.equal(again.replayed, true);
    assert.equal(again.invitation.invitationId, 'inv_live_rfq00000001');
    assert.equal(
      again.invitation.sourceRung,
      'verified',
      'the record keeps why they were actually asked, not why a later rung would have asked',
    );

    const invitations = await service.listInvitations(rfqId);
    assert.equal(invitations.length, 1);

    // And exactly one notification was published, which is the point: a platform that sends
    // duplicate invitations is one people filter out.
    const client = await database.connect();
    try {
      const events = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM module_rfq.outbox
          WHERE kind = 'event' AND payload->'payload'->>'supplier_account_id' = '${SUPPLIER_A}';`,
      );
      assert.equal(events.rows[0]?.count, '1');
    } finally {
      await client.release();
    }

    // The service checks first, and the unique index is what makes it true under a race that gets
    // past that check. Both layers, because only one of them survives a concurrent caller.
    const raced = await refuses(
      database,
      `INSERT INTO module_rfq.rfq_invitation
         (invitation_id, rfq_id, supplier_account_id, source_rung, reason, score_per_mille,
          invited_at, correlation_id, idempotency_key)
       VALUES ('inv_live_rfq00000009', '${rfqId}', '${SUPPLIER_A}', 'known',
               'a second row for the same supplier on the same tender', 640,
               '2026-07-02T09:00:00Z', 'corr_live_rfqinv009', 'idem_live_rfqinv009');`,
    );
    assert.match(raced ?? '', /rfq_invitation_once_per_supplier/);
  });
});

test('the database refuses to rewrite an invitation or a transition', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);
    const rfqId = await openTender(service, '0004');

    await service.inviteSupplier({
      rfqId,
      invitationId: 'inv_live_rfq00000003',
      supplierAccountId: SUPPLIER_B,
      sourceRung: 'external',
      reason: 'discovered through the external directory for this category',
      scorePerMille: 520,
      invitedAt: NOW,
      correlationId: 'corr_live_rfqinv003',
      idempotencyKey: 'idem_live_rfqinv003',
    });

    const edited = await refuses(
      database,
      `UPDATE module_rfq.rfq_invitation SET reason = 'a different reason'
        WHERE invitation_id = 'inv_live_rfq00000003';`,
    );
    assert.match(edited ?? '', /append-only/);

    const erased = await refuses(
      database,
      `DELETE FROM module_rfq.rfq_invitation WHERE invitation_id = 'inv_live_rfq00000003';`,
    );
    assert.match(
      erased ?? '',
      /append-only/,
      'they have already seen it, and pretending otherwise would make the record disagree with ' +
        'what happened',
    );

    const rewritten = await refuses(
      database,
      `UPDATE module_rfq.rfq_event SET reason = 'something else' WHERE rfq_id = '${rfqId}';`,
    );
    assert.match(rewritten ?? '', /append-only/);
  });
});

test('an award names exactly one winner, in both directions', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);
    const rfqId = await openTender(service, '0005');

    const winnerless = await refuses(
      database,
      `UPDATE module_rfq.rfq SET status = 'awarded' WHERE rfq_id = '${rfqId}';`,
    );
    assert.match(
      winnerless ?? '',
      /rfq_award_names_winner/,
      'an awarded tender that cannot say who was chosen cannot be explained to the suppliers who ' +
        'lost',
    );

    const unawardedWinner = await refuses(
      database,
      `UPDATE module_rfq.rfq SET awarded_quote_id = 'quo_live_rfq00000001'
        WHERE rfq_id = '${rfqId}';`,
    );
    assert.match(unawardedWinner ?? '', /rfq_award_names_winner/);

    // Through the service, both move together.
    await service.awardRfq({
      rfqId,
      eventId: 'evt_live_rfqaward01',
      quoteId: 'quo_live_rfq00000001',
      reason: 'the only offer that met the date',
      occurredAt: LATER,
      correlationId: 'corr_live_rfqaw001',
      idempotencyKey: 'idem_live_rfqaw001',
    });

    const awarded = await service.getRfq(rfqId);
    assert.equal(awarded?.status, 'awarded');
    assert.equal(awarded?.awardedQuoteId, 'quo_live_rfq00000001');
  });
});

test(
  'awarding a second, different offer is refused rather than replayed',
  liveTestOptions,
  async () => {
    // The defect this test exists for: an idempotent shortcut once treated a second decision as a
    // retry, so awarding an already-awarded tender to somebody else answered "replayed" and changed
    // nothing — while telling the caller it had succeeded.
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);
      const rfqId = await openTender(service, '0006');

      await service.awardRfq({
        rfqId,
        eventId: 'evt_live_rfqaward02',
        quoteId: 'quo_live_rfq00000002',
        reason: 'best on price and date together',
        occurredAt: LATER,
        correlationId: 'corr_live_rfqaw002',
        idempotencyKey: 'idem_live_rfqaw002',
      });

      await assert.rejects(
        service.awardRfq({
          rfqId,
          eventId: 'evt_live_rfqaward03',
          quoteId: 'quo_live_rfq00000003',
          reason: 'a second decision, which is not a retry of the first',
          occurredAt: '2026-07-02T10:00:00.000000Z',
          correlationId: 'corr_live_rfqaw003',
          idempotencyKey: 'idem_live_rfqaw003',
        }),
        (error: unknown) => error instanceof RfqError && error.code === 'illegal-transition',
      );

      const held = await service.getRfq(rfqId);
      assert.equal(held?.awardedQuoteId, 'quo_live_rfq00000002', 'the first award stands');
    });
  },
);

test('the PostgreSQL adapter and the in-memory one agree', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const live = serviceFor(database);
    const memory = new RfqService(new InMemoryRfqRepository());

    for (const service of [live, memory]) {
      const rfqId = await openTender(service, '0007');
      await service.inviteSupplier({
        rfqId,
        invitationId: 'inv_live_rfq00000004',
        supplierAccountId: SUPPLIER_A,
        sourceRung: 'verified',
        reason: 'verified for this category and district, with prior deliveries on record',
        scorePerMille: 780,
        invitedAt: NOW,
        correlationId: 'corr_live_rfqinv004',
        idempotencyKey: 'idem_live_rfqinv004',
      });
      await service.inviteSupplier({
        rfqId,
        invitationId: 'inv_live_rfq00000005',
        supplierAccountId: SUPPLIER_B,
        sourceRung: 'external',
        reason: 'discovered through the external directory, unverified but in the right category',
        scorePerMille: null,
        invitedAt: NOW,
        correlationId: 'corr_live_rfqinv005',
        idempotencyKey: 'idem_live_rfqinv005',
      });
      await service.closeRfq({
        rfqId,
        eventId: 'evt_live_rfqclose01',
        reason: 'quoting window has passed',
        occurredAt: LATER,
        correlationId: 'corr_live_rfqcl001',
        idempotencyKey: 'idem_live_rfqcl001',
      });
    }

    const shape = async (service: RfqService): Promise<unknown> => {
      const rfq = await service.getRfq('rfq_live_rfq0007');
      const invitations = await service.listInvitations('rfq_live_rfq0007');
      return {
        status: rfq?.status,
        closureReason: rfq?.closureReason,
        quantity: rfq?.specification.quantity.toString(),
        attributes: rfq?.specification.attributes,
        invitations: invitations.map((one) => [
          one.supplierAccountId,
          one.sourceRung,
          one.scorePerMille,
        ]),
      };
    };

    assert.deepEqual(await shape(live), await shape(memory));
  });
});

test('no specification travels in an event', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);
    const rfqId = await openTender(service, '0008');

    await service.inviteSupplier({
      rfqId,
      invitationId: 'inv_live_rfq00000006',
      supplierAccountId: SUPPLIER_A,
      sourceRung: 'verified',
      reason: 'verified supplier for cement in this district, with prior deliveries',
      scorePerMille: 820,
      invitedAt: NOW,
      correlationId: 'corr_live_rfqinv006',
      idempotencyKey: 'idem_live_rfqinv006',
    });

    const client = await database.connect();
    try {
      const rows = await client.query<{ kind: string; payload: Record<string, unknown> }>(
        `SELECT kind, payload FROM module_rfq.outbox WHERE kind = 'event' ORDER BY outbox_id;`,
      );
      const published = JSON.stringify(rows.rows);

      assert.ok(
        !published.includes('OPC 43'),
        'the specification stays in the tender, which a supplier fetches through a route that ' +
          'can check they were invited',
      );
      assert.ok(!published.includes('Ordinary Portland Cement'));
      assert.ok(
        published.includes('cement'),
        'the category does travel, because a consumer has to route on something',
      );
      assert.ok(published.includes(SUPPLIER_A), 'and who was asked, so they can be told');
    } finally {
      await client.release();
    }
  });
});
