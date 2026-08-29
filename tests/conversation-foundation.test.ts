/**
 * K-12 Conversation Foundation — the contract, every refusal, and outbox emission.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConversationError,
  FOREIGN_FIELDS,
  IDENTITY_REFUSALS,
  type ConversationService,
  type CreateConversationRequest,
  type SendMessageRequest,
  type AddParticipantRequest,
} from '../kernel/conversation-foundation/index.ts';

import {
  addParticipantRequest,
  build,
  createConversationRequest,
  sendMessageRequest,
} from './helpers/conversation-foundation-fixtures.ts';

const codeOf = (error: unknown): string | undefined =>
  error instanceof ConversationError ? error.code : undefined;

const rejectsWith = async (
  fn: () => Promise<unknown>,
  code: string,
  message: RegExp,
): Promise<void> => {
  await assert.rejects(fn, (error: unknown) => {
    assert.equal(codeOf(error), code, `expected ${code}, got ${String(codeOf(error))}`);
    assert.match((error as ConversationError).message, message);
    return true;
  });
};

async function createConversation(
  service: ConversationService,
  overrides: Partial<CreateConversationRequest> = {},
) {
  return service.createConversation(createConversationRequest(overrides));
}

async function addParticipant(
  service: ConversationService,
  conversationId: string,
  overrides: Partial<AddParticipantRequest> = {},
) {
  return service.addParticipant(addParticipantRequest({ conversationId, ...overrides }));
}

async function sendMessage(
  service: ConversationService,
  conversationId: string,
  participantId: string,
  overrides: Partial<SendMessageRequest> = {},
) {
  return service.sendMessage(sendMessageRequest({ conversationId, participantId, ...overrides }));
}

// ---------------------------------------------------------------------------
// Conversation creation
// ---------------------------------------------------------------------------

test('creates a conversation with the declared fields', async () => {
  const { service, repository } = build();
  const result = await createConversation(service, {
    conversationId: 'conv_01HQZXCREATE01',
    title: 'A test conversation',
    context: 'support',
    idempotencyKey: 'idem_create_01',
  });

  assert.equal(result.deduplicated, false);
  assert.equal(result.conversation.conversationId, 'conv_01HQZXCREATE01');
  assert.equal(result.conversation.title, 'A test conversation');
  assert.equal(result.conversation.context, 'support');
  assert.equal(result.conversation.idempotencyKey, 'idem_create_01');
  assert.equal(repository.conversations().length, 1);
});

test('creates a conversation with a null title', async () => {
  const { service } = build();
  const result = await createConversation(service, { title: null });
  assert.equal(result.conversation.title, null);
});

test('creates a conversation with an empty title', async () => {
  const { service } = build();
  const result = await createConversation(service, { title: '' });
  assert.equal(result.conversation.title, '');
});

test('a retry with the same idempotency key returns the original conversation', async () => {
  const { service, repository } = build();
  const first = await createConversation(service, { conversationId: 'conv_01HQZXIDEM' });
  const second = await createConversation(service, { conversationId: 'conv_01HQZXIDEM' });

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.conversation.conversationId, 'conv_01HQZXIDEM');
  assert.equal(repository.conversations().length, 1);
});

test('rejects a reused idempotency key with different content', async () => {
  const { service } = build();
  await createConversation(service, {
    conversationId: 'conv_01HQZXKEY1',
    idempotencyKey: 'idem_conv_0001',
  });
  await rejectsWith(
    () =>
      createConversation(service, {
        conversationId: 'conv_01HQZXKEY2',
        idempotencyKey: 'idem_conv_0001',
      }),
    'idempotency-key-reuse',
    /different conversation/,
  );
});

test('rejects a duplicate conversation id with different content', async () => {
  const { service } = build();
  await createConversation(service, { conversationId: 'conv_01HQZXDUP' });
  await rejectsWith(
    () =>
      createConversation(service, {
        conversationId: 'conv_01HQZXDUP',
        context: 'transaction',
        idempotencyKey: 'idem_conv_0002',
      }),
    'duplicate-conversation-id',
    /already exists/,
  );
});

test('rejects a conversation with an unknown context', async () => {
  const { service } = build();
  await rejectsWith(
    () =>
      createConversation(service, {
        context: 'group' as 'direct',
      }),
    'malformed-record',
    /expected one of/,
  );
});

// ---------------------------------------------------------------------------
// Adding participants
// ---------------------------------------------------------------------------

test('adds a participant to a conversation', async () => {
  const { service, repository } = build();
  const conversation = await createConversation(service);
  const result = await addParticipant(service, conversation.conversation.conversationId, {
    participantId: 'part_01HQZXPART01',
    accountId: 'acct_01HQZXPART01',
  });

  assert.equal(result.deduplicated, false);
  assert.equal(result.participant.conversationId, conversation.conversation.conversationId);
  assert.equal(result.participant.accountId, 'acct_01HQZXPART01');
  assert.equal(repository.participants().length, 1);
});

test('rejects adding a participant to an unknown conversation', async () => {
  const { service } = build();
  await rejectsWith(
    () => addParticipant(service, 'conv_01HQZXNOCONV'),
    'unknown-conversation',
    /does not exist/,
  );
});

test('rejects adding the same account twice to one conversation', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  await addParticipant(service, conversation.conversation.conversationId, {
    accountId: 'acct_01HQZXDUPACCT',
  });
  await rejectsWith(
    () =>
      addParticipant(service, conversation.conversation.conversationId, {
        accountId: 'acct_01HQZXDUPACCT',
        participantId: 'part_01HQZXDUPACCT2',
        idempotencyKey: 'idem_part_dup2',
      }),
    'duplicate-participant-account',
    /already a participant/,
  );
});

test('the same account may participate in different conversations', async () => {
  const { service } = build();
  const first = await createConversation(service);
  const second = await createConversation(service);
  await addParticipant(service, first.conversation.conversationId, {
    accountId: 'acct_01HQZXSHARED',
  });
  const result = await addParticipant(service, second.conversation.conversationId, {
    accountId: 'acct_01HQZXSHARED',
  });
  assert.equal(result.deduplicated, false);
});

test('a retry with the same participant idempotency key returns the original participant', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  const request = addParticipantRequest({
    conversationId: conversation.conversation.conversationId,
  });
  const first = await service.addParticipant(request);
  const second = await service.addParticipant(request);

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(first.participant.participantId, second.participant.participantId);
});

test('rejects a reused participant idempotency key with different content', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  await addParticipant(service, conversation.conversation.conversationId, {
    participantId: 'part_01HQZXPKEY1',
    idempotencyKey: 'idem_part_0001',
  });
  await rejectsWith(
    () =>
      addParticipant(service, conversation.conversation.conversationId, {
        participantId: 'part_01HQZXPKEY2',
        idempotencyKey: 'idem_part_0001',
      }),
    'idempotency-key-reuse',
    /different participant/,
  );
});

test('rejects an invalid participant role', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  await rejectsWith(
    () =>
      addParticipant(service, conversation.conversation.conversationId, {
        role: 'guest' as 'member',
      }),
    'malformed-record',
    /expected one of/,
  );
});

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------

test('sends a message in a conversation', async () => {
  const { service, repository } = build();
  const conversation = await createConversation(service);
  const participant = await addParticipant(service, conversation.conversation.conversationId);
  const result = await sendMessage(
    service,
    conversation.conversation.conversationId,
    participant.participant.participantId,
  );

  assert.equal(result.deduplicated, false);
  assert.equal(result.message.conversationId, conversation.conversation.conversationId);
  assert.equal(result.message.content, 'Hello, world!');
  assert.equal(repository.messages().length, 1);
});

test('rejects sending a message to an unknown conversation', async () => {
  const { service } = build();
  await rejectsWith(
    () =>
      service.sendMessage(
        sendMessageRequest({
          conversationId: 'conv_01HQZXNOMSGCONV',
        }),
      ),
    'unknown-conversation',
    /does not exist/,
  );
});

test('rejects sending a message from an unknown participant', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  await rejectsWith(
    () => sendMessage(service, conversation.conversation.conversationId, 'part_01HQZXNOBODY'),
    'unknown-participant',
    /not a member/,
  );
});

test('rejects sending a message from a participant of another conversation', async () => {
  const { service } = build();
  const first = await createConversation(service);
  const second = await createConversation(service);
  const participant = await addParticipant(service, first.conversation.conversationId);
  await rejectsWith(
    () =>
      sendMessage(
        service,
        second.conversation.conversationId,
        participant.participant.participantId,
      ),
    'unknown-participant',
    /not a member/,
  );
});

test('rejects an empty message content', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  const participant = await addParticipant(service, conversation.conversation.conversationId);
  await rejectsWith(
    () =>
      sendMessage(
        service,
        conversation.conversation.conversationId,
        participant.participant.participantId,
        { content: '' },
      ),
    'malformed-record',
    /non-empty text/,
  );
});

test('rejects a whitespace-only message content', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  const participant = await addParticipant(service, conversation.conversation.conversationId);
  await rejectsWith(
    () =>
      sendMessage(
        service,
        conversation.conversation.conversationId,
        participant.participant.participantId,
        { content: '   ' },
      ),
    'malformed-record',
    /non-empty text/,
  );
});

test('a retry with the same message idempotency key returns the original message', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  const participant = await addParticipant(service, conversation.conversation.conversationId);
  const request = sendMessageRequest({
    conversationId: conversation.conversation.conversationId,
    participantId: participant.participant.participantId,
  });
  const first = await service.sendMessage(request);
  const second = await service.sendMessage(request);

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(first.message.messageId, second.message.messageId);
});

test('rejects a reused message idempotency key with different content', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  const participant = await addParticipant(service, conversation.conversation.conversationId);
  await sendMessage(
    service,
    conversation.conversation.conversationId,
    participant.participant.participantId,
    {
      messageId: 'msg_01HQZXMKEY1',
      idempotencyKey: 'idem_msg_0001',
    },
  );
  await rejectsWith(
    () =>
      sendMessage(
        service,
        conversation.conversation.conversationId,
        participant.participant.participantId,
        { messageId: 'msg_01HQZXMKEY2', idempotencyKey: 'idem_msg_0001' },
      ),
    'idempotency-key-reuse',
    /different message/,
  );
});

test('accepts a system message type', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  const participant = await addParticipant(service, conversation.conversation.conversationId, {
    role: 'system',
  });
  const result = await sendMessage(
    service,
    conversation.conversation.conversationId,
    participant.participant.participantId,
    { messageType: 'system', content: 'Conversation started' },
  );
  assert.equal(result.message.messageType, 'system');
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test('returns messages ordered by sentAt descending', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  const participant = await addParticipant(service, conversation.conversation.conversationId);
  const convId = conversation.conversation.conversationId;
  const partId = participant.participant.participantId;

  await sendMessage(service, convId, partId, {
    messageId: 'msg_01HQZXOLD',
    sentAt: '2026-04-01T10:00:00Z',
    idempotencyKey: 'idem_msg_old',
  });
  await sendMessage(service, convId, partId, {
    messageId: 'msg_01HQZXNEW',
    sentAt: '2026-04-01T12:00:00Z',
    idempotencyKey: 'idem_msg_new',
  });

  const page = await service.getMessages(convId);
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0]?.messageId, 'msg_01HQZXNEW');
  assert.equal(page.messages[1]?.messageId, 'msg_01HQZXOLD');
});

test('paginates messages with the default page size', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  const participant = await addParticipant(service, conversation.conversation.conversationId);
  const convId = conversation.conversation.conversationId;
  const partId = participant.participant.participantId;

  for (let i = 0; i < 55; i += 1) {
    await sendMessage(service, convId, partId, {
      messageId: `msg_01HQZXPAGE${String(i).padStart(3, '0')}`,
      sentAt: `2026-04-01T12:00:00.${String(i).padStart(6, '0')}Z`,
      idempotencyKey: `idem_page_${i}`,
    });
  }

  const page = await service.getMessages(convId);
  assert.equal(page.messages.length, 50);
  assert.equal(page.hasMore, true);
});

test('paginates messages with a custom limit up to the maximum', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  const participant = await addParticipant(service, conversation.conversation.conversationId);
  const convId = conversation.conversation.conversationId;
  const partId = participant.participant.participantId;

  for (let i = 0; i < 101; i += 1) {
    await sendMessage(service, convId, partId, {
      messageId: `msg_01HQZXMAX${String(i).padStart(3, '0')}`,
      sentAt: `2026-04-01T12:00:00.${String(i).padStart(6, '0')}Z`,
      idempotencyKey: `idem_max_${i}`,
    });
  }

  const page = await service.getMessages(convId, { limit: 200 });
  assert.equal(page.messages.length, 100);
  assert.equal(page.hasMore, true);
});

test('paginates with the after cursor', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  const participant = await addParticipant(service, conversation.conversation.conversationId);
  const convId = conversation.conversation.conversationId;
  const partId = participant.participant.participantId;

  for (let i = 0; i < 10; i += 1) {
    await sendMessage(service, convId, partId, {
      messageId: `msg_01HQZXCURSOR${i}`,
      sentAt: `2026-04-01T12:00:00.${String(i).padStart(6, '0')}Z`,
      idempotencyKey: `idem_cursor_${i}`,
    });
  }

  const first = await service.getMessages(convId, { limit: 5 });
  assert.equal(first.messages.length, 5);
  assert.equal(first.hasMore, true);

  const after = first.messages[first.messages.length - 1]?.messageId;
  assert.ok(after !== undefined);
  const second = await service.getMessages(convId, { after, limit: 5 });
  assert.equal(second.messages.length, 5);
  assert.equal(second.hasMore, false);
});

test('getMessages refuses an invalid conversation id', async () => {
  const { service } = build();
  await rejectsWith(() => service.getMessages('alice@example.com'), 'natural-identifier', /email/);
});

test('getMessages refuses an unknown conversation', async () => {
  const { service } = build();
  await rejectsWith(
    () => service.getMessages('conv_01HQZXNOREAD'),
    'unknown-conversation',
    /does not exist/,
  );
});

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

test('creating a conversation emits one event and one audit record', async () => {
  const { service, repository } = build();
  const result = await createConversation(service, { conversationId: 'conv_01HQZXOUTBOX' });

  const entries = repository.outbox().entries();
  assert.equal(entries.length, 2);

  const event = entries.find((entry) => entry.kind === 'event');
  const audit = entries.find((entry) => entry.kind === 'audit');
  assert.ok(event !== undefined);
  assert.ok(audit !== undefined);

  const eventPayload = event.payload as { type: string; payload: { conversation_id: string } };
  assert.equal(eventPayload.type, 'conversation.created');
  assert.equal(eventPayload.payload.conversation_id, result.conversation.conversationId);

  const auditPayload = audit.payload as { action: string };
  assert.equal(auditPayload.action, 'conversation.created');
});

test('sending a message emits one event and one audit record', async () => {
  const { service, repository } = build();
  const conversation = await createConversation(service);
  const participant = await addParticipant(service, conversation.conversation.conversationId);
  const result = await sendMessage(
    service,
    conversation.conversation.conversationId,
    participant.participant.participantId,
  );

  const entries = repository.outbox().entries();
  assert.equal(entries.length, 4);

  const event = entries.find(
    (entry) =>
      entry.kind === 'event' &&
      (entry.payload as { type: string }).type === 'conversation.message_sent',
  );
  const audit = entries.find(
    (entry) =>
      entry.kind === 'audit' &&
      (entry.payload as { action: string }).action === 'conversation.message_sent',
  );
  assert.ok(event !== undefined);
  assert.ok(audit !== undefined);

  const eventPayload = event.payload as { type: string; payload: { message_id: string } };
  assert.equal(eventPayload.type, 'conversation.message_sent');
  assert.equal(eventPayload.payload.message_id, result.message.messageId);

  const auditPayload = audit.payload as { action: string };
  assert.equal(auditPayload.action, 'conversation.message_sent');
});

test('outbox entries carry the producer and correlation id', async () => {
  const { service, repository } = build();
  const result = await createConversation(service, { conversationId: 'conv_01HQZXPAYLOAD' });

  const event = repository
    .outbox()
    .entries()
    .find((entry) => entry.kind === 'event');
  assert.ok(event !== undefined);
  assert.equal(event.producer, 'K-12');
  assert.equal(event.correlationId, result.conversation.conversationId);
});

// ---------------------------------------------------------------------------
// Foreign concerns
// ---------------------------------------------------------------------------

test('every foreign field is refused by name on conversation creation', async () => {
  const cases: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ['subjectId', 'sub_01HQZX', /K-01 Identity owns the subject/],
    ['sessionId', 'sess-1', /K-02 Authentication owns sessions/],
    ['accountId', 'acct_01HQZX', /K-03 Accounts owns the universal account/],
    ['roles', ['admin'], /K-04 Permissions owns roles and grants/],
    ['balance', 1000, /K-10 Ledger foundation is the authority on every amount/],
    ['orderId', 'order-1', /orders belong to the Orders module/],
    ['aiModel', 'gpt-4', /the AI Gateway module owns model selection/],
    ['email', 'alice@example.com', /a profile field/],
    ['status', 'active', /a conversation has no lifecycle state/],
  ];

  for (const [field, value, why] of cases) {
    const { service, repository } = build();
    await assert.rejects(
      service.createConversation({ ...createConversationRequest(), [field]: value }),
      (error: unknown) => {
        assert.equal(codeOf(error), 'foreign-concern', `"${field}" was silently accepted`);
        assert.match((error as ConversationError).message, why);
        return true;
      },
      `passing "${field}" must be refused`,
    );
    assert.equal(repository.conversations().length, 0);
  }
});

test('an unrecognised field is refused rather than silently dropped', async () => {
  const { service } = build();
  await rejectsWith(
    () =>
      service.createConversation({
        ...createConversationRequest(),
        nickname: 'chat',
      } as CreateConversationRequest),
    'foreign-concern',
    /silently dropped/,
  );
});

test('the foreign-field table names a real owner for every entry', () => {
  for (const [field, owner] of Object.entries(FOREIGN_FIELDS)) {
    assert.ok(owner.length > 20, `${field} needs a real explanation, not a label`);
    assert.ok(
      /K-\d\d|module|deferred|profile|preference|personal data|lifecycle|owns|separate work/i.test(
        owner,
      ),
      `${field} does not name who owns it or why it is absent: "${owner}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Identifiers and instants
// ---------------------------------------------------------------------------

test('K-01 identifier rules apply to every K-12 identifier', async () => {
  const cases: ReadonlyArray<
    readonly [string, string, string, (s: ConversationService) => Promise<unknown>]
  > = [
    [
      'conversationId',
      'alice@example.com',
      'natural-identifier',
      (service) =>
        service.createConversation(
          createConversationRequest({ conversationId: 'alice@example.com' }),
        ),
    ],
    [
      'idempotencyKey',
      'passport-X1234567',
      'natural-identifier',
      (service) =>
        service.createConversation(
          createConversationRequest({ idempotencyKey: 'passport-X1234567' }),
        ),
    ],
    [
      'participantId',
      '0771234567',
      'natural-identifier',
      async (service) => {
        const conversation = await createConversation(service);
        return service.addParticipant(
          addParticipantRequest({
            conversationId: conversation.conversation.conversationId,
            participantId: '0771234567',
          }),
        );
      },
    ],
    [
      'accountId',
      'example.com',
      'natural-identifier',
      async (service) => {
        const conversation = await createConversation(service);
        return service.addParticipant(
          addParticipantRequest({
            conversationId: conversation.conversation.conversationId,
            accountId: 'example.com',
          }),
        );
      },
    ],
    [
      'messageId',
      'msg_1',
      'malformed-identifier',
      async (service) => {
        const conversation = await createConversation(service);
        const participant = await addParticipant(service, conversation.conversation.conversationId);
        return service.sendMessage(
          sendMessageRequest({
            conversationId: conversation.conversation.conversationId,
            participantId: participant.participant.participantId,
            messageId: 'msg_1',
          }),
        );
      },
    ],
  ];

  for (const [field, value, expected, call] of cases) {
    const { service } = build();
    await assert.rejects(call(service), (error: unknown) => {
      assert.ok(
        error instanceof ConversationError,
        `${field}=${value} raised an ${(error as Error).name} from a component the caller never called`,
      );
      assert.equal(codeOf(error), expected, `${field}=${value} got ${String(codeOf(error))}`);
      return true;
    });
  }
});

test('credential-shaped identifiers are refused on every field', async () => {
  const cases: ReadonlyArray<readonly [string, (s: ConversationService) => Promise<unknown>]> = [
    [
      'conversationId',
      (service) =>
        service.createConversation(
          createConversationRequest({ conversationId: 'sk-abcdefghijklmnopqrstuvwxyz' }),
        ),
    ],
    [
      'idempotencyKey',
      (service) =>
        service.createConversation(
          createConversationRequest({ idempotencyKey: 'sk-abcdefghijklmnopqrstuvwxyz' }),
        ),
    ],
    [
      'participantId',
      async (service) => {
        const conversation = await createConversation(service);
        return service.addParticipant(
          addParticipantRequest({
            conversationId: conversation.conversation.conversationId,
            participantId: 'sk-abcdefghijklmnopqrstuvwxyz',
          }),
        );
      },
    ],
    [
      'messageId',
      async (service) => {
        const conversation = await createConversation(service);
        const participant = await addParticipant(service, conversation.conversation.conversationId);
        return service.sendMessage(
          sendMessageRequest({
            conversationId: conversation.conversation.conversationId,
            participantId: participant.participant.participantId,
            messageId: 'sk-abcdefghijklmnopqrstuvwxyz',
          }),
        );
      },
    ],
  ];

  for (const [, call] of cases) {
    const { service } = build();
    await rejectsWith(() => call(service), 'secret-bearing-input', /credential/);
  }
});

test('the K-01 refusal mapping is total over what K-01 can raise here', () => {
  assert.deepEqual(Object.keys(IDENTITY_REFUSALS).sort(), [
    'malformed-identifier',
    'natural-identifier',
    'secret-bearing-input',
  ]);
  for (const [from, to] of Object.entries(IDENTITY_REFUSALS)) {
    assert.equal(from, to, 'the codes carry the same meaning and should keep the same name');
  }
});

test('an impossible calendar instant is refused rather than rolled forward', async () => {
  for (const bad of [
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-04-01 12:00:00Z',
    '2026-04-01T12:00:00+05:30',
    'yesterday',
    '',
  ]) {
    const { service } = build();
    await rejectsWith(
      () => service.createConversation(createConversationRequest({ createdAt: bad })),
      'malformed-instant',
      /is not a valid UTC instant/,
    );
  }
});

test('nothing is written when a request is refused', async () => {
  const { service, repository } = build();
  await assert.rejects(
    service.createConversation(createConversationRequest({ conversationId: 'alice@example.com' })),
  );
  await assert.rejects(
    service.createConversation(createConversationRequest({ createdAt: '2026-02-30T00:00:00Z' })),
  );

  assert.equal(repository.conversations().length, 0);
  assert.equal(repository.participants().length, 0);
  assert.equal(repository.messages().length, 0);
  assert.equal(repository.outbox().entries().length, 0);
});

// ---------------------------------------------------------------------------
// Surface checks
// ---------------------------------------------------------------------------

test('the service exposes no operation that mutates history', () => {
  const { service } = build();
  const operations = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(service) as object | null;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  operations.delete('constructor');

  const mutators = [...operations].filter((operation) =>
    /^(update|delete|remove|amend|edit|rewrite|set[A-Z])/i.test(operation),
  );
  assert.deepEqual(mutators, [], 'conversations and messages are append-only');
});

test('the service surface matches the contract', () => {
  const { service } = build();
  const operations = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(service) as object | null;
  while (proto !== null && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) operations.add(key);
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  operations.delete('constructor');

  assert.deepEqual([...operations].sort(), [
    'addParticipant',
    'createConversation',
    'getMessages',
    'sendMessage',
  ]);
});

test('records are sealed when returned', async () => {
  const { service } = build();
  const conversation = await createConversation(service);
  assert.ok(Object.isFrozen(conversation.conversation));

  const participant = await addParticipant(service, conversation.conversation.conversationId);
  assert.ok(Object.isFrozen(participant.participant));

  const message = await sendMessage(
    service,
    conversation.conversation.conversationId,
    participant.participant.participantId,
  );
  assert.ok(Object.isFrozen(message.message));
});
