/**
 * K-12 Conversation Foundation against a live PostgreSQL server — opt-in, and honestly skipped otherwise.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConversationService,
  PostgresConversationRepository,
} from '../../kernel/conversation-foundation/index.ts';
import { migrateDown, migrateUp } from '../../platform/db/runner.ts';
import type { Database } from '../../platform/db/client.ts';

import {
  createConversationRequest,
  sendMessageRequest,
} from '../helpers/conversation-foundation-fixtures.ts';
import {
  developmentDatabaseName,
  developmentSnapshot,
  liveTestOptions,
  withTestDatabase,
} from './harness.ts';

async function count(database: Database, table: string): Promise<number> {
  const client = await database.connect();
  try {
    const result = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table};`);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.release();
  }
}

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

test(
  'creates a conversation, adds a participant and sends a message end-to-end',
  liveTestOptions,
  async () => {
    const before = await developmentSnapshot();

    await withTestDatabase(async ({ database, directory, name }) => {
      assert.notEqual(
        name,
        developmentDatabaseName(),
        'the target is never the development database',
      );
      await migrateUp(database, { directory });

      const service = new ConversationService(new PostgresConversationRepository(database));

      const conversation = await service.createConversation(
        createConversationRequest({ conversationId: 'conv_live_01' }),
      );
      assert.equal(conversation.deduplicated, false);

      const participant = await service.addParticipant({
        participantId: 'part_live_01',
        conversationId: conversation.conversation.conversationId,
        accountId: 'acct_live_01',
        role: 'member',
        joinedAt: '2026-04-01T12:00:00Z',
        idempotencyKey: 'idem_part_live_01',
      });
      assert.equal(participant.deduplicated, false);

      const message = await service.sendMessage(
        sendMessageRequest({
          messageId: 'msg_live_01',
          conversationId: conversation.conversation.conversationId,
          participantId: participant.participant.participantId,
        }),
      );
      assert.equal(message.deduplicated, false);

      const page = await service.getMessages(conversation.conversation.conversationId);
      assert.equal(page.messages.length, 1);
      assert.equal(page.messages[0]?.messageId, 'msg_live_01');

      assert.equal(await count(database, 'kernel_conversation_foundation.conversation'), 1);
      assert.equal(await count(database, 'kernel_conversation_foundation.participant'), 1);
      assert.equal(await count(database, 'kernel_conversation_foundation.message'), 1);
      assert.equal(await count(database, 'kernel_conversation_foundation.outbox'), 4);
    });

    const after = await developmentSnapshot();
    assert.deepEqual(
      after.applied.map((entry) => entry.version),
      before.applied.map((entry) => entry.version),
      'the development database was read and never written',
    );
  },
);

test(
  'the database refuses a duplicate account participant in the same conversation',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory });
      const service = new ConversationService(new PostgresConversationRepository(database));

      const conversation = await service.createConversation(
        createConversationRequest({ conversationId: 'conv_dup_participant' }),
      );
      await service.addParticipant({
        participantId: 'part_dup_01',
        conversationId: conversation.conversation.conversationId,
        accountId: 'acct_dup_01',
        role: 'member',
        joinedAt: '2026-04-01T12:00:00Z',
        idempotencyKey: 'idem_part_dup_01',
      });

      const result = await refuses(
        database,
        `INSERT INTO kernel_conversation_foundation.participant
           (participant_id, conversation_id, account_id, role, joined_at, idempotency_key)
         VALUES ('part_dup_02', '${conversation.conversation.conversationId}', 'acct_dup_01', 'owner', '2026-04-01T12:00:00Z', 'idem_part_dup_02');`,
      );
      assert.ok(result !== null, 'a duplicate account participant must be refused');
      assert.match(result, /unique constraint/i);

      assert.equal(await count(database, 'kernel_conversation_foundation.participant'), 1);
    });
  },
);

test('the database refuses to mutate conversation history', liveTestOptions, async () => {
  await withTestDatabase(async ({ database, directory }) => {
    await migrateUp(database, { directory });
    const service = new ConversationService(new PostgresConversationRepository(database));

    const conversation = await service.createConversation(
      createConversationRequest({ conversationId: 'conv_mutate_01' }),
    );
    const conversationId = conversation.conversation.conversationId;

    const update = await refuses(
      database,
      `UPDATE kernel_conversation_foundation.conversation SET context = 'support' WHERE conversation_id = '${conversationId}';`,
    );
    assert.ok(update !== null, 'updating a conversation must be refused');
    assert.match(update, /append-only/i);

    const deleteConversation = await refuses(
      database,
      `DELETE FROM kernel_conversation_foundation.conversation WHERE conversation_id = '${conversationId}';`,
    );
    assert.ok(deleteConversation !== null, 'deleting a conversation must be refused');
    assert.match(deleteConversation, /append-only/i);
  });
});

test(
  'kernel_conversation_foundation rolls back independently of other schemas',
  liveTestOptions,
  async () => {
    await withTestDatabase(async ({ database, directory }) => {
      await migrateUp(database, { directory, target: '0018' });
      const service = new ConversationService(new PostgresConversationRepository(database));

      await service.createConversation(
        createConversationRequest({ conversationId: 'conv_rollback_01' }),
      );

      await migrateDown(database, { directory, version: '0018' });

      const client = await database.connect();
      try {
        await assert.rejects(
          client.query('SELECT 1 FROM kernel_conversation_foundation.conversation LIMIT 1;'),
        );
      } finally {
        await client.release();
      }
    });
  },
);
