# K-12 Conversation Foundation — contract

**Status:** foundation implemented.
**Owner:** K-12, `kernel/conversation-foundation/`.
**Schema:** `kernel_conversation_foundation`, created by
[`0018_create_kernel_conversation_foundation_schema.up.sql`](../../db/migrations/0018_create_kernel_conversation_foundation_schema.up.sql).
**Depends on:** K-01 Identity (identifier rules), K-03 Accounts (participant `accountId` references a
universal account). No existence checks are wired yet.

---

## 1. What this component owns

Three primitives for a Telegram-like conversation UX:

- **Conversation** — a container with a context (`direct`, `transaction`, `support`, `ai`), a title,
  and a creation instant.
- **Participant** — one account in one conversation, with a role (`owner`, `member`, `ai`, `system`).
- **Message** — one line in a conversation, with content, a type (`text`, `system`), and a sent-at
  instant.

| Field | Meaning |
|---|---|
| `conversationId` | Caller-supplied opaque handle. Never a natural key |
| `title` | Optional human-readable title; may be null or empty |
| `context` | `direct`, `transaction`, `support`, or `ai` |
| `createdAt` | Canonical UTC instant, caller-supplied |
| `idempotencyKey` | Stable across retries of one logical creation |

| Field | Meaning |
|---|---|
| `participantId` | Caller-supplied opaque handle |
| `conversationId` | The conversation this participant belongs to |
| `accountId` | The K-03 universal account that participates. Not verified in this slice |
| `role` | `owner`, `member`, `ai`, or `system` |
| `joinedAt` | Canonical UTC instant, caller-supplied |
| `idempotencyKey` | Stable across retries of one logical addition |

| Field | Meaning |
|---|---|
| `messageId` | Caller-supplied opaque handle |
| `conversationId` | The conversation this message belongs to |
| `participantId` | The participant that sent this message |
| `content` | Non-empty text content |
| `messageType` | `text` or `system` |
| `sentAt` | Canonical UTC instant, caller-supplied |
| `idempotencyKey` | Stable across retries of one logical send |

### What it does not own, and who does

A conversation request carrying any of these fields is **refused by name**:

| Concern | Owner |
|---|---|
| What kind of party a subject is | **K-01 Identity** |
| Passwords, credentials, MFA, sessions, tokens | **K-02 Authentication** |
| The universal account, capabilities, origin provenance | **K-03 Accounts** |
| Roles, grants, permission evaluation | **K-04 Permissions** |
| Every monetary amount, balance, credit | **K-10 Ledger Foundation** |
| Orders, listings, payments, offers, quotes | **Business modules (M-11, M-04, M-12, M-08, M-10)** |
| AI provider selection, prompt templates, model routing | **K-13 AI Gateway** |
| Name, email, phone, address, avatar, preferences | **The account profile core — separate, undelivered work** |

The full list, with a reason for each, is `FOREIGN_FIELDS` in `registry.ts`, and
`tests/conversation-foundation.test.ts` asserts that every entry names a real owner rather than
a label.

---

## 2. Public contract

```ts
new ConversationService(repository)

createConversation(request): Promise<{ conversation, deduplicated }>
addParticipant(request): Promise<{ participant, deduplicated }>
sendMessage(request): Promise<{ message, deduplicated }>
getMessages(conversationId, options?): Promise<{ messages, hasMore }>
```

### Guarantees

| Guarantee | Meaning |
|---|---|
| Opaque identifiers | K-01's rule set, applied to every K-12 identifier and re-raised in K-12's vocabulary |
| Idempotent creation | A retry with the same idempotency key returns the original record **only when the whole logical record matches** |
| One account per conversation | An account cannot be added as a participant twice in the same conversation |
| Unknown-conversation refusal | `addParticipant` and `sendMessage` check that the conversation exists before writing |
| Unknown-participant refusal | `sendMessage` checks that the participant exists in the conversation before writing |
| Append-only | No operation updates or deletes a conversation, participant or message |
| Determinism | The caller supplies every identifier and instant; this component reads no clock and generates no randomness |
| Immutability in the process | Every record crossing a boundary is deep-frozen and severed from the caller's objects |
| Outbox per mutation | `createConversation` and `sendMessage` each emit one K-08 event and one K-09 audit record inside the same transaction |
| Transaction composition | `PostgresConversationRepository.enlist(client)` opens a conversation write inside a transaction the caller already owns |

### Refusals

| Code | Refused because |
|---|---|
| `malformed-identifier` | Not 8–128 characters of `[A-Za-z0-9._:-]` starting alphanumeric |
| `natural-identifier` | An identifier looks like an email, telephone number, document number, IBAN, URL, domain or personal name |
| `secret-bearing-input` | An identifier names or looks like a credential |
| `malformed-instant` | The instant is not a real UTC instant |
| `foreign-concern` | The request carried a field owned by another component or an unrecognised field |
| `duplicate-conversation-id` | A conversation with this id already exists with different content |
| `duplicate-participant-id` | A participant with this id already exists with different content |
| `duplicate-message-id` | A message with this id already exists with different content |
| `duplicate-participant-account` | The account is already a participant in this conversation |
| `idempotency-key-reuse` | The key was already used for a *different* record |
| `unknown-conversation` | The conversation does not exist |
| `unknown-participant` | The participant does not exist in this conversation |
| `nested-transaction` | An enlisted write tried to issue transaction control |
| `malformed-record` | A stored row, or a candidate record, is the wrong runtime shape |

---

## 3. Why the conversation carries nothing extra

A conversation is a container. It does not carry a status machine, a last-read pointer, an unread
count, moderation state, AI model selection, or business context. Those belong to the consumers
that use K-12: business modules, the AI gateway, and the supervision cockpit. Keeping them out lets
K-12 remain a primitive that any layer can depend on without inheriting concerns from above.

---

## 4. Immutability

Conversations, participants and messages are created and never changed. Enforced at four layers:
no such operation in the service, none in the port, none in the adapter, and `BEFORE UPDATE OR
DELETE` triggers in migration 0018.

---

## 5. Dependencies

K-12 depends on K-01 Identity for identifier rules and on K-03 Accounts for the account id that a
participant references. It does **not** verify that a subject or account exists in this slice; that
verification is deferred to the integration layer that wires K-12 with K-01/K-03. There is no
foreign key out of `kernel_conversation_foundation`.

---

## 6. Outbox

`createConversation` publishes:

- Event `conversation.created` with payload `conversation_id`, `context`, `created_at`, `idempotency_key`
- Audit action `conversation.created` with authority `business-authoritative` and the same evidence

`sendMessage` publishes:

- Event `conversation.message_sent` with payload `message_id`, `conversation_id`, `participant_id`,
  `message_type`, `sent_at`, `idempotency_key`
- Audit action `conversation.message_sent` with authority `business-authoritative` and the same
  evidence

---

## 7. Verification

```bash
npm run verify                                 # everything, including the tests below
npm run check:migrations                       # the FND-002a contract over db/migrations
node --test tests/conversation-foundation.test.ts              # contract, refusals, outbox
node --test tests/conversation-foundation-repository.test.ts   # port conformance, adapter, module contract
npm run test:integration                       # live PostgreSQL; skips without a database
```
