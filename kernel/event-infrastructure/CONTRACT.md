# K-08 Event Infrastructure — module contract

**Component:** K-08, `kernel/event-infrastructure`
**Schema:** `kernel_event_infrastructure` (derived from the architecture manifest)
**Build step:** B-1 — depends only on the platform substrate
**Delivered by:** FND-003b

An event is a statement that something happened, addressed to nobody in particular. That is what
makes it the only sanctioned way for two modules in the same layer to affect each other:
MODULE_MAP.md §10.3 forbids sibling calls, so a module that needs another to react publishes a fact
and stops caring who reads it.

The hard part is not fan-out. It is that a fact must survive a crash, must reach each consumer at
least once, must not be silently applied twice, must stop being retried at some point, and must
never be quietly rewritten. Everything below exists for one of those five.

---

## 1. What this component owns

| Owns | Does not own |
|---|---|
| The event envelope, the type registry and payload schema versions | What any event *means*. Business events belong to the modules that publish them |
| The append-only log, delivery state, retry scheduling and dead-lettering | Consumer effects. A handler's idempotency is the consumer's, using the key this component supplies |
| The `kernel_event_infrastructure` schema and everything in it | Any other unit's schema. This component reads and writes nothing else |
| Who may publish and who may acknowledge | Authentication and authorisation — **K-02** and **K-04**. `Actor` is supplied by the caller and checked |

It touches no other schema, in code or in SQL, and `tests/events-repository.test.ts` asserts that
mechanically against both the adapter and the migration.

---

## 2. Public contract

Everything another unit may use is exported from `kernel/event-infrastructure/index.ts`.

```ts
service.publish(request): Promise<PublishResult>          // append + fan out, one transaction
service.register(subscription, handler): void
service.deliver({ subscription, worker, claimToken, now, limit? }): Promise<DeliveryOutcome[]>
service.replay({ eventId, subscription, deliveryId, operator, reason, now, discardReceipt? })
service.eventById(eventId): Promise<EventEnvelope>
service.deliveriesForEvent(eventId): Promise<readonly Delivery[]>
```

**Provider-neutral.** No broker vocabulary appears in any type. Kafka, SQS, NATS and a PostgreSQL
table are all implementations of the port in `repository.ts`; choosing one later must not change a
caller. There is deliberately no broker SDK in this repository.

**Deterministic.** `now`, every identifier and every claim token come from the caller. This
component reads no clock and generates no randomness — including no jitter in the backoff, which is
a real trade-off: jitter would spread retry load, and it would also make retry timing unassertable.
A caller that needs spread can stagger its workers.

### Guarantees

| Guarantee | Meaning |
|---|---|
| Durable append | An event and every delivery it fans out to share one transaction. Either the fact and all its work exist, or neither does |
| Immutable events | Content is fixed at append and fingerprinted with SHA-256. The port offers no operation that changes an event, and replay creates deliveries rather than touching one |
| At-least-once delivery | A handler is acknowledged only after it returns. The alternative — acknowledging first — is at-most-once, and silently losing an event is worse than processing one twice |
| Consumer-side idempotency | A receipt per (subscription, event), written in the same transaction as the acknowledgement. A redelivered event whose receipt exists never reaches the handler |
| Safe concurrent claiming | `FOR UPDATE SKIP LOCKED`, and every completion predicated on the claim token. Two workers cannot both authoritatively finish one delivery |
| Conflict parity | The reference implementation refuses at commit every uniqueness conflict the database refuses with a constraint — a second event under one idempotency key, a second delivery at one `(event, subscription, generation)`, two live claims holding one token — and reports the conflict the *first* violated statement would have produced, because events are inserted before deliveries |
| Convergent retries | Two overlapping retries of one publication do not both fail. The loser re-reads, checks that the winner is the same logical event, and returns it. A key reused for genuinely different content still fails closed |
| Deterministic bounded retry | `base × 2^(attempt−1)`, capped at `maxBackoffSeconds`. `backoffSeconds` is exported, so an operator can compute a `nextAttemptAt` rather than infer it |
| Terminal dead-lettering | After `maxAttempts` a delivery is dead-lettered and never retried automatically. It stays for inspection and can only return through an explicit replay |
| Operator-explicit replay | A replay appends the next generation, names its operator and carries a reason. It never reopens a terminal delivery |
| Schema-version validation | An envelope is validated against the exact declared version of its type. Unknown types, unknown versions and undeclared fields are refused |

### Refusals

| Code | Refused because |
|---|---|
| `unknown-event-type` | An unregistered type has no declared payload, so nothing can say whether the envelope is well formed |
| `unknown-schema-version` | The type is known at other versions. Usually a producer running ahead of its own deployment |
| `malformed-envelope` | An identifier or instant is not well formed, or the event claims to have been recorded before it happened |
| `invalid-payload` | A field is undeclared, missing, wrongly typed, or nested. Undeclared fields are refused rather than dropped: dropping one lets a producer believe it published something no consumer will ever see |
| `secret-bearing-payload` | A field name or a value carries a credential. An event is fanned out and kept; a credential in one is published and cannot be unpublished |
| `origin-not-permitted` | `ai-suggested`, or a system actor claiming a human decided |
| `producer-not-permitted` | A unit tried to publish a type another unit owns. A unit that could do that could fabricate another's history |
| `ai-not-permitted` | AI tried to publish, claim or acknowledge. See below |
| `duplicate-event-id` | An event is evidence and is never rewritten |
| `idempotency-key-reuse` | The key was already used for a different event |
| `stale-claim` | The lease was lost and another worker owns this delivery |
| `claim-token-reuse` | A token identifies one claim, not one worker. Two claims that cannot be told apart defeat the stale-worker guard |
| `obsolete-delivery` | The delivery is terminal. A replay appends a new generation instead |
| `delivery-not-terminal` | Replaying live work would put two deliveries of one event in front of one consumer |
| `replay-not-authorised` | Replay needs an operator and a reason. Automatic replay is how one incident becomes two |
| `no-such-event` / `no-such-delivery` | Nothing to act on |
| `concurrent-modification` | Something moved underneath the transaction |
| `nested-transaction` | An enlisted append tried to issue `BEGIN`, `COMMIT`, `ROLLBACK` or `SAVEPOINT`. The transaction belongs to the caller — see §4 |
| `unknown-subscription` | Not registered, or registered with no handler. Claiming work with nothing to run it would burn attempts and dead-letter events that were never delivered |

### AI is not an authority here

Two separate refusals, because they protect different things:

- **AI may not publish.** `origin: 'ai-suggested'` and `actor.kind: 'ai'` are both refused, and the
  database `CHECK` refuses the origin as well, so a write around the service still could not record
  one. An event is trusted evidence that a fact occurred; a fabricated one is indistinguishable
  from a real one to every consumer downstream. AI may propose a fact to a human or to a
  deterministic system, which publishes it and owns it.
- **AI may not mark a delivery successful.** Acknowledging asserts that a consumer really processed
  the event — which AI cannot know — and an acknowledgement suppresses redelivery for ever. AI may
  not order a replay either.

---

## 3. Persistence and transport

An injected `EventRepository` port with three implementations:

| Implementation | Owns a transaction? | For |
|---|---|---|
| `InMemoryEventRepository` | yes, modelled | the reference implementation, used by the tests |
| `PostgresEventRepository` | yes, its own `BEGIN … COMMIT` | a caller that is only publishing |
| `EnlistedEventRepository` | no — it uses the caller's | a producing module coupling a domain write to its event (§4) |

The reference implementation is not a convenience double. It refuses at commit every uniqueness
conflict the database refuses with a constraint, and in the order the statements run: an event is
inserted before its deliveries, so two overlapping publications collide on the event's idempotency
key rather than on a delivery row, which is the error a caller will really see. A reference
implementation that reported a different conflict from the database would make every guarantee
proved against it worth less than it appears.

**PostgreSQL is the transport, not merely the store**, and that is the point rather than a
compromise. A table with `FOR UPDATE SKIP LOCKED` gives durable at-least-once delivery, and it lets
a producing module append its domain rows and its events in the **same transaction**. No broker can
offer that.

| Table | Holds | Why separate |
|---|---|---|
| `event` | the append-only log | never updated; there is no UPDATE against it anywhere in the adapter |
| `event_delivery` | one row per (event, subscription, generation) | delivery state on the event would make a consumer's retry loop rewrite history |
| `event_receipt` | one row per (subscription, event) | written with the acknowledgement, so it exists if and only if the delivery was acknowledged |

Timestamps are projected as UTC text through `to_char`, never left to the driver's `Date` parser —
lease expiry and retry due-times are comparisons, and precision lost in the driver is lost before
anything here can notice. Same reasoning, and the same projection, as K-05's adapter.

---

## 4. How a module must publish (capability built, no module using it)

**No module publishes events yet.** K-08 has no producing module and no consuming module; the
subscriptions used in the tests are fixtures. What follows is the mechanism the first producer will
use — it exists and is tested, but nothing in the repository calls it.

A domain write and its event must be **atomically coupled**. The module opens one transaction,
writes its rows, and appends its event through a repository *enlisted* in that same transaction:

```ts
const client = await database.connect();
try {
  await client.query('BEGIN;');                        // the caller owns the transaction

  await orders.insert(client, order);                  // the domain write
  const events = new EventService(
    types,
    subscriptions,
    PostgresEventRepository.enlist(client),            // enlisted, not self-opening
    policy,
  );
  await events.publish({ /* … */ });                   // the fact, same transaction

  await client.query('COMMIT;');                       // both, or neither
} catch (error) {
  await client.query('ROLLBACK;');
  throw error;
} finally {
  await client.release();
}
```

Publishing *after* the caller's commit is the mistake this exists to prevent: the process can die in
between and the fact is lost with no trace that it should have existed. Publishing *before* is
worse — the event announces something that may then roll back.

Two properties of the enlisted path are load-bearing, and both are asserted:

- **It issues no transaction control.** No `BEGIN`, `COMMIT`, `ROLLBACK` or `SAVEPOINT`, ever.
  PostgreSQL has no nested transactions: a `BEGIN` inside an open transaction is ignored with a
  warning, and a `COMMIT` would end *the caller's* transaction, committing domain rows it had not
  finished writing and making its later `ROLLBACK` silently roll back nothing. The enlisted client
  refuses those statements rather than trusting nobody will add one.
- **It releases nothing and swallows nothing.** The connection belongs to the caller, and a failure
  inside the append propagates so the caller's `ROLLBACK` undoes it. Handling the error here would
  commit domain state with no event — precisely the outcome the shared transaction prevents.

`PostgresEventRepository`'s own `withTransaction` is unchanged and still opens and owns a
transaction, for callers that are only publishing. Both paths write through the same
`PostgresEventTransaction`, so there is one implementation of every statement.

Consumers must be idempotent. Delivery is at-least-once, so a handler is handed
`idempotencyKey = "<subscription>:<eventId>"`, stable across every redelivery and every replay
generation. A handler that writes that key alongside its own effect, in its own transaction, gets
exactly-once *effect* out of at-least-once delivery.

---

## 5. Deliberately deferred

| Deferred | Waiting on | Why it is not here |
|---|---|---|
| Broker binding (Kafka/SQS/NATS) | a real throughput requirement | A broker chosen before a single real producer exists is a guess dressed as infrastructure. The port makes it a later decision rather than a rewrite |
| A module that actually publishes | K-02, K-04 and a business module | The enlisted mechanism in §4 exists and is tested; nothing calls it. A capability is not an integration, and this row stays until a real producer uses it |
| Administrative API and UI | **K-02** Authentication, **K-04** Permissions | An endpoint that publishes or replays events before there is anyone to authorise it is a hole |
| Audit of replays | **K-09** Audit Foundation | The operator and reason are recorded on the delivery, but there is no durable audit trail to write them to |
| Consumer registration at runtime | a real consumer | Subscriptions are declared, not discovered. A runtime registry with no consumers would be untested behaviour |
| Retention and archival | an operational requirement | The log grows without bound. Deliberate: deleting evidence needs a policy, not a default |

---

## 6. Migration limitations

- **Never executed.** No PostgreSQL runtime is available to this repository, so
  `0004_create_kernel_event_infrastructure_schema` has been validated statically and applied
  nowhere. Its SQL is unproven, including the `SKIP LOCKED` claim statement — the single most
  important statement in the component.
- The rollback drops the schema with `RESTRICT` and drops child tables before the parent, because
  both `event_delivery` and `event_receipt` carry foreign keys into `event`.
- Rolling back discards the event log. That is a consequence of removing the component rather than
  an accident: an event log with no component to read it is not evidence anybody can use.
- There is no retention policy and no partitioning. Both are real operational needs at volume and
  neither is guessed at here.

---

## 7. Verification

```bash
npm run verify                                    # everything, including the tests below
npm run check:migrations                          # the FND-002a contract over db/migrations
node --test tests/events.test.ts                  # registry, envelope, publication refusals
node --test tests/events-delivery.test.ts         # claiming, retry, DLQ, crash window, replay
node --test tests/events-repository.test.ts       # port conformance, adapter queries, contract
node --test tests/events-concurrency.test.ts      # commit conflicts, retry convergence, enlistment
npm run test:integration                          # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suites skip with a stated reason when no database is
configured, and a skipped run is not evidence of anything.
