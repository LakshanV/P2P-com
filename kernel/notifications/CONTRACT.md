# K-14 Notifications — contract

**Status:** foundation delivered. **Not complete** — see §7.
**Owner:** K-14, `kernel/notifications/`.
**Schema:** `kernel_notifications`, created by
[`0020_create_kernel_notifications_schema.up.sql`](../../db/migrations/0020_create_kernel_notifications_schema.up.sql).
**Depends on:** K-03 Accounts (identifier rules and recipient reference), K-08 Event Infrastructure,
K-09 Audit Foundation.

---

## 1. What this component owns

Three things:

1. **Channel configurations** (`kernel_notifications.channel`) — a mapping from a channel vocabulary
   (e.g. `in_app`) to a provider (e.g. `in_app`, `mock_email`) plus provider-specific configuration
   and an enabled flag.
2. **Notifications** (`kernel_notifications.notification`) — the rendered subject, body, payload,
   priority, lifecycle status and scheduling metadata for one message to one account.
3. **Delivery attempts** (`kernel_notifications.delivery_attempt`) — one row per attempt, recording
   success or failure and an error code.

It does **not** own:

- The account — K-03 Accounts owns that; K-14 references it by id.
- Template bodies or template rendering — a future template service owns those; K-14 stores only
  the template id and the rendered result.
- Any business outcome — orders, payments, quotes, listings and the like belong to the business
  modules that emit the events K-14 may react to in later slices.

### What it does not own, and who does

| Concern | Owner |
|---|---|
| The universal account | **K-03 Accounts** |
| Who or what caused the account to exist | **K-03 Accounts** |
| Template bodies, rendering engines, variable substitution | A future template service |
| Identity, subjects, party kinds | **K-01 Identity** |
| Authentication, sessions, credentials | **K-02 Authentication** |
| Roles, grants, permission evaluation | **K-04 Permissions** |
| Every monetary amount | **K-10 Ledger foundation** |
| Orders, payments, listings, offers, quotes | The business modules that own each |
| Event routing and subscriptions | **K-08 Event Infrastructure** |
| Audit storage and authority classification | **K-09 Audit Foundation** |

The full list, with a reason for each, is `FOREIGN_FIELDS` in `registry.ts`, and
`tests/notifications.test.ts` asserts that every entry names a real owner rather than carrying a
label.

---

## 2. Public contract

```ts
new NotificationService(repository, resolveProvider)

createChannel(request): Promise<{ channel, deduplicated }>
send(request): Promise<{ notification, deduplicated }>
schedule(request): Promise<{ notification, deduplicated }>
getStatus(notificationId): Promise<NotificationStatus>
recordDeliveryAttempt(request): Promise<{ attempt, deduplicated }>
```

`resolveProvider(provider: string): NotificationProvider` is injected so the service stays
channel-neutral. The only provider delivered in this slice is the in-app provider.

### Guarantees

| Guarantee | Meaning |
|---|---|
| Channel neutrality | The service does not know how a channel is delivered; it looks up the configured provider name and delegates to an injected adapter |
| Idempotent creation | A retry with the same idempotency key returns the original record **only when the whole logical record matches** — identifiers, content and instants |
| No duplicate channel/provider | A single `(channel, provider)` pair may be registered once; two providers cannot claim the same channel vocabulary |
| Enabled-channel check | `send` and `schedule` refuse a channel that is disabled or absent |
| Synchronous in-app delivery | The in-app provider records a successful `DeliveryAttempt` immediately and the notification status becomes `sent` |
| Append-only delivery attempts | An attempt is recorded once and never changed |
| Event + audit per lifecycle change | `sent` and `failed` each produce a K-08 event and a K-09 audit record through the module outbox |
| Determinism | The caller supplies every identifier and every instant; this component reads no clock and generates no randomness |
| Immutability in the process | Every record crossing a boundary — service result, repository read, decoded row — is deep-frozen and severed from the caller's objects |
| Transaction composition | `PostgresNotificationRepository.enlist(client)` writes a notification inside a transaction the caller already owns |

### Refusals

| Code | Refused because |
|---|---|
| `malformed-identifier` | Not 8–128 characters of `[A-Za-z0-9._:-]` starting alphanumeric |
| `natural-identifier` | An identifier looks like an email, telephone number, document number, IBAN, URL, domain or personal name |
| `secret-bearing-input` | An identifier names or looks like a credential |
| `malformed-instant` | An instant is not a real UTC instant. 31 April is refused rather than rolled forward |
| `foreign-concern` | The request carried a field owned by another component or a field this component does not recognise |
| `malformed-record` | A stored row, or a candidate record, is the wrong runtime shape |
| `invalid-channel` | The channel is not one of `in_app`, `email`, `sms`, `push`, `whatsapp` |
| `invalid-priority` | The priority is not one of `low`, `normal`, `high`, `urgent` |
| `invalid-status` | A notification status is not one of `pending`, `sent`, `failed`, `scheduled` |
| `invalid-attempt-status` | A delivery-attempt status is not `success` or `failure` |
| `duplicate-channel-id` | A channel id already exists with different content |
| `duplicate-channel-provider` | The `(channel, provider)` pair is already registered |
| `duplicate-notification-id` | A notification id already exists with different content |
| `duplicate-attempt-id` | A delivery-attempt id already exists with different content |
| `idempotency-key-reuse` | The key was already used for a *different* record |
| `no-such-channel` | No channel configuration exists for the requested channel vocabulary |
| `channel-disabled` | The channel exists but is disabled |
| `no-such-notification` | The requested notification does not exist |
| `nested-transaction` | An enlisted write tried to issue transaction control |

---

## 3. Domain model

### Notification

| Field | Meaning |
|---|---|
| `notificationId` | Caller-supplied opaque handle. Never a natural key |
| `accountId` | The K-03 universal account that should receive this notification |
| `channel` | One of `in_app`, `email`, `sms`, `push`, `whatsapp` |
| `templateId` | Identifier of the template that was rendered; the template body is not stored here |
| `subject` | Rendered subject line |
| `body` | Rendered body |
| `payload` | JSON object of variables that produced the rendered subject and body |
| `priority` | One of `low`, `normal`, `high`, `urgent` |
| `status` | One of `pending`, `sent`, `failed`, `scheduled` |
| `scheduledAt` | ISO-8601 instant when delivery is scheduled; null when not scheduled |
| `sentAt` | ISO-8601 instant when the notification was delivered; null until then |
| `createdAt` | ISO-8601 instant when the notification was created |
| `idempotencyKey` | Stable across retries of one logical send |

### DeliveryAttempt

| Field | Meaning |
|---|---|
| `attemptId` | Caller-supplied opaque handle |
| `notificationId` | The notification this attempt delivered |
| `channel` | Channel the attempt used |
| `provider` | Provider that handled the attempt |
| `status` | `success` or `failure` |
| `errorCode` | Refusal code when status is `failure`; otherwise null |
| `attemptedAt` | ISO-8601 instant when the attempt happened |
| `idempotencyKey` | Stable across retries of one logical attempt |

### Channel

| Field | Meaning |
|---|---|
| `channelId` | Caller-supplied opaque handle for this configuration |
| `channel` | One of `in_app`, `email`, `sms`, `push`, `whatsapp` |
| `provider` | Provider that implements this channel |
| `enabled` | Whether this channel may currently be used |
| `configuration` | JSON object of provider-specific configuration |
| `createdAt` | ISO-8601 instant when the channel was created |
| `idempotencyKey` | Stable across retries of one logical creation |

---

## 4. Immutability and mutability

A channel configuration and a delivery attempt are append-only: created once and never changed or
removed. A notification is also created once, but its `status` and `sent_at` may be updated by a
delivery attempt — first synchronously by `send`, later asynchronously by
`recordDeliveryAttempt`. There is no relink, no deletion and no content mutation.

Enforced at four layers: no such operation in the service except status update, none in the port
except status update, no `UPDATE` or `DELETE` path for channels and delivery attempts in the
adapter, and triggers in migration 0020 that refuse mutation on those two tables.

---

## 5. The K-03 dependency

K-14 depends on K-03 for the universal account reference and for the identifier rule set.
`assertAccountIdentifier` is imported from K-03 and its refusals are re-raised as
`NotificationError`s. There is no foreign key from `kernel_notifications.notification.account_id`
into `kernel_accounts`, and no SQL of K-14's names `kernel_accounts`. Existence of the account is
assumed by the caller; a notification for a non-existent account can be stored, just as a
notification for a future scheduled delivery can be stored.

---

## 6. Provider architecture

Providers implement `NotificationProvider`:

```ts
interface NotificationProvider {
  readonly channel: string;
  readonly provider: string;
  deliver(notification: Notification): Promise<DeliveryAttempt>;
}
```

The service resolves a provider by name and delegates delivery. This slice ships one provider:
`InAppNotificationProvider`, which succeeds synchronously and derives the attempt id and idempotency
key deterministically from the notification.

---

## 7. Persistence, and what is deferred

An injected `NotificationRepository` port with three implementations:
`InMemoryNotificationRepository` (the reference implementation), `PostgresNotificationRepository`,
and `EnlistedNotificationRepository` for a caller that already owns a transaction.

Timestamps are projected as UTC text through `to_char`, never left to the driver's `Date` parser.
Decoding is fail-closed and runs the same validators the service calls.

### Deliberately deferred

- **No real email/SMS/push/WhatsApp provider.** Only the in-app provider is wired.
- **No event-driven consumers.** K-14 emits events; downstream modules may react in later slices.
- **No scheduling worker.** `schedule` stores the notification with `status=scheduled`; a future
  worker will call `recordDeliveryAttempt` when the time arrives.
- **No template service integration.** The caller supplies subject, body, payload and template id.
- **No K-02 authentication or K-04 permission checks.** The service assumes the caller is allowed to
  send to the named account.
- **No listing or search.** Notifications are looked up by id only.
- **No erasure or archive policy.** Personal data lives in rendered subject/body/payload; a future
  slice must decide retention and erasure.

---

## 8. Verification

```bash
npm run verify                                  # everything, including the tests below
npm run check:migrations                        # the FND-002a contract over db/migrations
node --test tests/notifications.test.ts         # contract, refusals, idempotency, lifecycle
node --test tests/notifications-repository.test.ts  # port conformance, adapter, module contract
npm run test:integration                        # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suites skip with a stated reason when no database is
configured, and a skipped run is not evidence of anything.
