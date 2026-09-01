/**
 * M-03 Commerce Request against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 *
 * Migration 0049 declares three things TypeScript cannot, and each is proved here by issuing the
 * offending statement rather than by asserting that the service does not.
 *
 * **`raw_text` is write-once.** A trigger refuses any UPDATE that would change it. This is the whole
 * module: what somebody asked for is evidence, and a system that can edit its own evidence has none.
 * The service has no path that would try, so the only way to test the trigger is to go around the
 * service — which is exactly the case the trigger exists for.
 *
 * **Interpretations are append-only and versioned.** `UNIQUE (request_id, version)` makes the
 * sequence readable, and a trigger refuses an UPDATE or DELETE. Together they mean a wrong reading
 * cannot be quietly improved into a right one.
 *
 * **`raw_text` is exempt from the opacity rule and every identifier is not.** A Need saying "call me
 * on 0771234567" stores fine; a `request_id` that looked like a telephone number does not. Both
 * halves are tested, because the exemption is only defensible if the rule still bites everywhere
 * else.
 *
 * Round-tripping matters here more than in most modules. The words go in with leading whitespace,
 * an emoji, a newline and a Sinhala phrase, and come back byte for byte — because a collation, an
 * encoding or a driver that "helpfully" trimmed them would silently destroy the evidence and no unit
 * test against an in-memory store would notice.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CommerceRequestService,
  PostgresCommerceRequestRepository,
} from '../../modules/commerce-request/index.ts';
import { migrateUp } from '../../platform/db/runner.ts';
import { parseInstant } from '../../platform/time/instant.ts';
import type { Database } from '../../platform/db/client.ts';

import { liveTestOptions, rollBackTo, withTestDatabase } from './harness.ts';

const ACCOUNT = 'acct_live_needbuyer';
const NOW = '2026-07-01T09:00:00.000000Z';
const LATER = '2026-07-01T10:00:00.000000Z';

/**
 * A Need with everything awkward in it.
 *
 * Leading and trailing whitespace, a newline, an emoji, a Sinhala phrase, an apostrophe and a
 * telephone number. Every one of these is something an encoding, a collation, a trim or an
 * over-eager identifier rule could quietly destroy.
 */
const AWKWARD_RAW =
  '  20 tonnes of cement — Matale, by Friday 🙏\n' +
  "සිමෙන්ති ටොන් 20ක් අවශ්‍යයි. Don't call after 6pm; ring 0771234567.  ";

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

function serviceFor(database: Database): CommerceRequestService {
  return new CommerceRequestService(new PostgresCommerceRequestRepository(database));
}

test('a Need round-trips through PostgreSQL byte for byte', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    const captured = await service.captureNeed({
      requestId: 'req_live_need00001',
      accountId: ACCOUNT,
      channel: 'text',
      rawText: AWKWARD_RAW,
      neededBy: '2026-07-03T17:00:00.000000Z',
      capturedAt: NOW,
      correlationId: 'corr_live_need0001',
      idempotencyKey: 'idem_live_need0001',
    });

    assert.equal(captured.request.rawText, AWKWARD_RAW, 'on the way in');

    const readBack = await service.getNeed('req_live_need00001');
    assert.equal(
      readBack?.rawText,
      AWKWARD_RAW,
      'and on the way out. A trim, a collation or an encoding that altered this would destroy ' +
        'the evidence the whole module exists to keep',
    );
    assert.equal(readBack?.status, 'captured');

    // Instants are compared as instants, not as spellings. A value goes in as the caller wrote it
    // and comes back in `formatInstant`'s canonical form, which trims trailing zeros — so
    // "17:00:00.000000Z" reads back as "17:00:00Z". Same instant, different text, and asserting on
    // the text would be asserting on a formatting choice rather than on the data.
    assert.equal(
      parseInstant(readBack?.neededBy ?? '').epochMicros,
      parseInstant('2026-07-03T17:00:00.000000Z').epochMicros,
    );
    assert.equal(
      parseInstant(readBack?.capturedAt ?? '').epochMicros,
      parseInstant(NOW).epochMicros,
      'microsecond precision survives, because the column is projected as text rather than ' +
        'handed to the driver as a Date',
    );

    // And precision is genuinely microsecond, not merely claimed. A driver that parsed the column
    // into a Date would round this to the millisecond and nobody would notice until an ordering
    // depended on it.
    const precise = await service.captureNeed({
      requestId: 'req_live_need00011',
      accountId: ACCOUNT,
      channel: 'text',
      rawText: 'a Need captured at an awkward microsecond',
      capturedAt: '2026-07-01T09:00:00.123456Z',
      correlationId: 'corr_live_need0011',
      idempotencyKey: 'idem_live_need0011',
    });
    const preciseBack = await service.getNeed(precise.request.requestId);
    assert.equal(
      parseInstant(preciseBack?.capturedAt ?? '').epochMicros,
      parseInstant('2026-07-01T09:00:00.123456Z').epochMicros,
      'the last three digits survive the round trip',
    );
  });
});

test(
  'the database refuses to change what somebody said, even around the service',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      await service.captureNeed({
        requestId: 'req_live_need00002',
        accountId: ACCOUNT,
        channel: 'text',
        rawText: 'I need the 6mm bolts',
        capturedAt: NOW,
        correlationId: 'corr_live_need0002',
        idempotencyKey: 'idem_live_need0002',
      });

      const edited = await refuses(
        database,
        `UPDATE module_commerce_request.request
            SET raw_text = 'I need the 6cm bolts'
          WHERE request_id = 'req_live_need00002';`,
      );
      assert.ok(
        edited !== null,
        'the words must not be editable. A correction is a new interpretation, so the original ' +
          'survives every reinterpretation',
      );
      assert.match(edited, /never edited|new row in request_interpretation/);

      // Identity is equally fixed: repointing a Need at another account would rewrite whose it is.
      const repointed = await refuses(
        database,
        `UPDATE module_commerce_request.request
            SET account_id = 'acct_live_somebody'
          WHERE request_id = 'req_live_need00002';`,
      );
      assert.ok(repointed !== null);
      assert.match(repointed, /identity of a Need/);

      // And the lifecycle columns still move, or the trigger would have made the module unusable.
      const progressed = await service.markReady({
        requestId: 'req_live_need00002',
        reason: 'the buyer confirmed the size',
        occurredAt: LATER,
        correlationId: 'corr_live_need0002',
        idempotencyKey: 'idem_live_rdy00002',
        eventId: 'nev_live_need00002',
      });
      assert.equal(progressed.request.status, 'ready');
    });
  },
);

test(
  'interpretations append, and the database refuses to improve one after the fact',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      await service.captureNeed({
        requestId: 'req_live_need00003',
        accountId: ACCOUNT,
        channel: 'text',
        rawText: 'I need the 6mm bolts, two boxes',
        capturedAt: NOW,
        correlationId: 'corr_live_need0003',
        idempotencyKey: 'idem_live_need0003',
      });

      await service.interpret({
        requestId: 'req_live_need00003',
        interpretationId: 'int_live_need00031',
        origin: 'model',
        confidencePerMille: 610,
        structured: { item: 'bolt', size: '6cm', quantity: 2, unit: 'box' },
        aiRunId: 'airun_live_need031',
        rationale: 'read the size as 6cm from an ambiguous abbreviation',
        interpretedAt: LATER,
        correlationId: 'corr_live_need0003',
        idempotencyKey: 'idem_live_int00031',
        eventId: 'nev_live_need00031',
      });

      const corrected = await service.interpret({
        requestId: 'req_live_need00003',
        interpretationId: 'int_live_need00032',
        origin: 'human',
        confidencePerMille: 1000,
        structured: { item: 'bolt', size: '6mm', quantity: 2, unit: 'box' },
        rationale: 'the customer said 6mm, not 6cm',
        interpretedAt: '2026-07-01T11:00:00.000000Z',
        correlationId: 'corr_live_need0003',
        idempotencyKey: 'idem_live_int00032',
        eventId: 'nev_live_need00032',
      });
      assert.equal(corrected.interpretation.version, 2);

      const history = await service.listInterpretations('req_live_need00003');
      assert.equal(history.length, 2, 'the wrong reading is still there');
      assert.deepEqual(
        history.map((one) => [one.version, one.origin, one.structured.size]),
        [
          [1, 'model', '6cm'],
          [2, 'human', '6mm'],
        ],
        'and jsonb round-trips the structured reading intact',
      );

      const improved = await refuses(
        database,
        `UPDATE module_commerce_request.request_interpretation
            SET structured = '{"size":"6mm"}'::jsonb
          WHERE interpretation_id = 'int_live_need00031';`,
      );
      assert.ok(improved !== null, 'a wrong reading is not quietly corrected in place');
      assert.match(improved, /append-only/);

      const erased = await refuses(
        database,
        `DELETE FROM module_commerce_request.request_interpretation
          WHERE interpretation_id = 'int_live_need00031';`,
      );
      assert.ok(erased !== null, 'nor deleted');

      // Two readings claiming the same version would make the sequence unreadable, which is the
      // only thing the sequence is for.
      const duplicate = await refuses(
        database,
        `INSERT INTO module_commerce_request.request_interpretation
           (interpretation_id, request_id, version, origin, confidence_per_mille, structured,
            ai_run_id, rationale, supersedes_interpretation_id, interpreted_at, correlation_id,
            idempotency_key)
         VALUES ('int_live_need00033', 'req_live_need00003', 2, 'rule', 500, '{}'::jsonb,
                 NULL, 'a second version 2', NULL, '2026-07-01T12:00:00Z', 'corr_live_need0003',
                 'idem_live_int00033');`,
      );
      assert.ok(duplicate !== null);
      assert.match(duplicate, /request_interpretation_version_unique|unique/i);
    });
  },
);

test(
  'the database enforces what an interpretation must and must not carry',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      await service.captureNeed({
        requestId: 'req_live_need00004',
        accountId: ACCOUNT,
        channel: 'text',
        rawText: 'something to interpret',
        capturedAt: NOW,
        correlationId: 'corr_live_need0004',
        idempotencyKey: 'idem_live_need0004',
      });

      const insert = (
        id: string,
        origin: string,
        confidence: number,
        aiRun: string,
        rationale: string,
      ): string =>
        `INSERT INTO module_commerce_request.request_interpretation
           (interpretation_id, request_id, version, origin, confidence_per_mille, structured,
            ai_run_id, rationale, supersedes_interpretation_id, interpreted_at, correlation_id,
            idempotency_key)
         VALUES ('${id}', 'req_live_need00004', 1, '${origin}', ${String(confidence)}, '{}'::jsonb,
                 ${aiRun}, '${rationale}', NULL, '2026-07-01T10:00:00Z', 'corr_live_need0004',
                 'idem_live_${id.slice(-8)}');`;

      // A model reading with no run behind it cannot be traced to the model and prompt that
      // produced it, which is the only way a wrong answer is diagnosed rather than argued about.
      const untraceable = await refuses(
        database,
        insert(
          'int_live_need00041',
          'model',
          800,
          'NULL',
          'a model reading with nothing behind it',
        ),
      );
      assert.ok(untraceable !== null);
      assert.match(untraceable, /ai_run_matches_origin/);

      // And a human reading naming a run would credit a model for a correction a person made.
      const miscredited = await refuses(
        database,
        insert(
          'int_live_need00042',
          'human',
          1000,
          "'airun_live_need042'",
          'a person correcting it, credited to a model',
        ),
      );
      assert.ok(miscredited !== null);
      assert.match(miscredited, /ai_run_matches_origin/);

      // Confidence is an integer per-mille. There is no floating-point column in this schema, so a
      // value outside 0..1000 is a defect rather than an unusual reading.
      const impossible = await refuses(
        database,
        insert('int_live_need00043', 'rule', 1500, 'NULL', 'a confidence above certainty'),
      );
      assert.ok(impossible !== null);
      assert.match(impossible, /confidence_in_range/);

      // An interpretation without a reason is one nobody can argue with later.
      const unexplained = await refuses(
        database,
        insert('int_live_need00044', 'rule', 900, 'NULL', 'ok'),
      );
      assert.ok(unexplained !== null);
      assert.match(unexplained, /rationale_present/);
    });
  },
);

test('the opacity rule exempts the words and binds everything else', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = serviceFor(database);

    // The exemption. A Need full of personal detail is exactly what a Need looks like.
    const personal = await service.captureNeed({
      requestId: 'req_live_need00005',
      accountId: ACCOUNT,
      channel: 'voice',
      rawText: 'Nimal here — ring me on 0771234567 or nimal@example.com about the cement',
      capturedAt: NOW,
      correlationId: 'corr_live_need0005',
      idempotencyKey: 'idem_live_need0005',
    });
    assert.match(personal.request.rawText, /nimal@example\.com/);

    // And the rule still bites on every identifier, which is what makes the exemption defensible
    // rather than a hole. An email address as a request id publishes personal data into every row
    // that copies it.
    const naturalId = await refuses(
      database,
      `INSERT INTO module_commerce_request.request
           (request_id, account_id, channel, raw_text, conversation_id, status,
            current_interpretation_id, captured_at, updated_at, needed_by, closed_at,
            closure_reason, correlation_id, idempotency_key)
         VALUES ('nimal@example.com', '${ACCOUNT}', 'text', 'a Need keyed by an email address',
                 NULL, 'captured', NULL, '2026-07-01T09:00:00Z', '2026-07-01T09:00:00Z', NULL,
                 NULL, NULL, 'corr_live_need0006', 'idem_live_need0006');`,
    );
    assert.ok(naturalId !== null, 'an email address is not an identifier');
    assert.match(naturalId, /request_id_opaque/);

    // Media references obey it too: a filename or a URL is somebody else's address space.
    const url = await refuses(
      database,
      `INSERT INTO module_commerce_request.request_media
           (media_id, request_id, kind, reference, position, caption, added_at, correlation_id,
            idempotency_key)
         VALUES ('med_live_need00051', 'req_live_need00005', 'image',
                 'https://example.com/photo.jpg', 0, 'the broken part', '2026-07-01T09:00:00Z',
                 'corr_live_need0005', 'idem_live_med00051');`,
    );
    assert.ok(url !== null);
    assert.match(url, /reference_opaque/);
  });
});

test(
  'a terminal Need carries its closure, and the outbox holds the facts without the words',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = serviceFor(database);

      await service.captureNeed({
        requestId: 'req_live_need00007',
        accountId: ACCOUNT,
        channel: 'text',
        rawText: 'twenty tonnes of cement for Nimal on 0771234567',
        capturedAt: NOW,
        correlationId: 'corr_live_need0007',
        idempotencyKey: 'idem_live_need0007',
      });

      const cancelled = await service.cancelNeed({
        requestId: 'req_live_need00007',
        reason: 'the buyer no longer needs it',
        occurredAt: LATER,
        correlationId: 'corr_live_need0007',
        idempotencyKey: 'idem_live_can00007',
        eventId: 'nev_live_need00071',
      });
      assert.equal(cancelled.request.status, 'cancelled');
      assert.equal(cancelled.request.closedAt, LATER);

      // A terminal status and a closure are the same fact; the CHECK refuses one without the other.
      const halfClosed = await refuses(
        database,
        `UPDATE module_commerce_request.request
            SET closure_reason = NULL
          WHERE request_id = 'req_live_need00007';`,
      );
      assert.ok(halfClosed !== null);
      assert.match(halfClosed, /closure_agrees_with_status/);

      // The published facts carry the shape of what happened and never the words.
      const client = await database.connect();
      try {
        const rows = await client.query<{ payload: unknown }>(
          `SELECT payload FROM module_commerce_request.outbox ORDER BY recorded_at, outbox_id;`,
        );
        const published = JSON.stringify(rows.rows);
        assert.ok(published.length > 0, 'something was published, or this proves nothing');
        assert.ok(!published.includes('cement'), 'the words must not travel');
        assert.ok(!published.includes('0771234567'), 'and certainly not a telephone number');
        assert.ok(!published.includes('Nimal'), 'nor a name');
        assert.ok(published.includes('raw_text_length'), 'the length does');
      } finally {
        await client.release();
      }
    });
  },
);

test('migration 0049 rolls back and leaves no trace of the schema', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });

    const client = await database.connect();
    try {
      const before = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.tables
            WHERE table_schema = 'module_commerce_request';`,
      );
      assert.equal(Number(before.rows[0]?.count ?? 0), 5, 'four tables and the outbox');
    } finally {
      await client.release();
    }

    // 0049 is the first version to roll back, so everything from it upward comes off.
    await rollBackTo(database, directory, '0049');

    const after = await database.connect();
    try {
      const schemas = await after.query<{ count: string }>(
        `SELECT count(*) AS count FROM information_schema.schemata
            WHERE schema_name = 'module_commerce_request';`,
      );
      assert.equal(
        Number(schemas.rows[0]?.count ?? 0),
        0,
        'the rollback leaves nothing behind. It also destroys every Need, which the migration ' +
          'says out loud rather than leaving somebody to discover',
      );
    } finally {
      await after.release();
    }
  });
});
