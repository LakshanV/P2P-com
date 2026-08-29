# K-13 AI Gateway — contract

**Status:** foundation delivered. **Not complete** — see §8.
**Owner:** K-13, `kernel/ai-gateway/`.
**Schema:** `kernel_ai_gateway`, created by
[`0019_create_kernel_ai_gateway_schema.up.sql`](../../db/migrations/0019_create_kernel_ai_gateway_schema.up.sql)
and extended by
[`0023_create_kernel_ai_gateway_authority.up.sql`](../../db/migrations/0023_create_kernel_ai_gateway_authority.up.sql).
**Depends on:** K-05 Configuration, K-06 Policy Engine, K-09 Audit Foundation, platform substrate.

---

## 1. What this component owns

The single boundary to model providers:

| Concern | Owned here |
|---|---|
| Task definition | `task_definition` |
| Model binding | `model_binding` |
| AI run | `ai_run` |
| AI decision | `ai_decision` |
| Outbox | `outbox` |

What it does **not** own:

| Concern | Owner |
|---|---|
| Prices, listings, orders, payments | Business modules |
| Ledger accounts and balances | **K-10 Ledger foundation** |
| Conversation state | **K-12 Conversation Foundation** |
| Model catalogue and shadow-mode evaluation | M-39 AI Model Registry |
| Routing policy above runtime selection | M-40 AI Routing / Control Plane |
| Decision audit above the record | M-41 AI Decision Audit |

---

## 2. Public contract

```ts
new AIGatewayService(repository, resolveProvider)

registerTask(request): Promise<{ task, deduplicated }>
registerModel(request): Promise<{ binding, deduplicated }>
grantAuthority(request): Promise<{ authority, deduplicated }>
resolveAuthority(taskId, at): Promise<TaskAuthority | null>
executeTask(request): Promise<{ run, deduplicated }>
recordDecision(request): Promise<{ decision, deduplicated }>
```

### Authority

K-13 executes models, not business actions — the deterministic financial authority zone is forbidden
from importing it at all, and `npm run check:boundaries` enforces that. So what the authority model
promises here is a **ceiling**, and nothing wider:

| Level | Name | Meaning |
|---|---|---|
| 0 | `observe` | May look and record what it saw; may not propose |
| 1 | `recommend` | May propose; a human decides and acts |
| 2 | `prepare` | May assemble a complete action; a human approves before it executes |
| 3 | `execute-within-limits` | May execute an approved class of low-risk action inside stated limits |
| 4 | `manage-with-exceptions` | May run a defined operational area, escalating exceptions to a human |

A task runs only at a level a human granted it, only while it is not suspended, and the level it ran
under is written onto the run. **What a caller then does with a level-3 answer is the caller's
contract to keep**; K-13 cannot police it and does not claim to.

Grants are append-only versions. Raising a ceiling, lowering it and pulling the kill switch are all
the same operation — a new version — so the grant in force at an instant is the latest version
granted at or before it, and a grant that applied last month is still readable after this month's
change.

All identifiers and instants are caller-supplied. The service reads no clock and generates no
randomness.

### Guarantees

| Guarantee | Meaning |
|---|---|
| Task id vocabulary | Task ids are dotted lower_snake_case like `need.interpret` |
| Opaque identifiers | Binding, run and decision ids follow the K-01 opaque-identifier rule set |
| One record per id | A duplicate id with different content is refused; the same idempotency key with the same content returns the original |
| Capability match | `executeTask` selects an enabled binding whose capabilities include the task's capability |
| Priority routing | The enabled binding with the lowest `priority` wins; ties break by `binding_id` |
| Nothing runs unauthorised | `executeTask` refuses a task with no grant in force at `startedAt`, before a provider is resolved and before a token is spent |
| The kill switch stops everything | A suspended task refuses every level, **including 0** — something that keeps observing after being switched off is not switched off |
| The ceiling is enforced | A request above the granted `maxAuthority` is refused, and the refusal names both levels by number and by name |
| Authority is never defaulted | `requestedAuthority` is required. A run whose authority nobody stated is a run nobody authorised |
| Gated by the grant in force *then* | The gate reads the grant in force at the run's `startedAt`, not the newest grant, so a later change does not retroactively permit or forbid a past run |
| The run records what it was allowed | `authorityLevel` is stored on the run. Lowering a ceiling afterwards does not rewrite what an earlier run was permitted to do |
| Grants explain themselves | `rationale` is required and non-empty. A grant nobody explained is a grant nobody can review |
| Grants are versions | A grant is appended, never edited; the database refuses UPDATE and DELETE on `task_authority` |
| Deterministic mock | The mock adapter returns output derived from a hash of input and task id, and computes cost from token counts |
| Cost capture | Every run records input/output tokens and cost in integer minor units of the binding's `costAssetTypeId` |
| Policy level range | Decision policy level is an integer 0-4 |
| Atomic outbox | `executeTask` and `recordDecision` write the business row and two outbox rows in one transaction |
| Append-only history | No service operation updates or deletes `task_definition`, `model_binding`, `ai_run` or `ai_decision`; the database enforces the same with triggers |

### Refusals

| Code | Refused because |
|---|---|
| `malformed-identifier` | Not 8–128 characters of `[A-Za-z0-9._:-]` starting alphanumeric |
| `malformed-task-id` | A task id is not dotted lower_snake_case |
| `natural-identifier` | An identifier looks like an email, telephone, document number, IBAN, URL, domain or personal name |
| `secret-bearing-input` | An identifier looks like a credential |
| `malformed-instant` | An instant is not a real UTC instant |
| `foreign-concern` | The request carried a field owned by another component, or an unrecognised field |
| `malformed-record` | A stored row or candidate record is the wrong runtime shape |
| `invalid-capability` | A capability is not one of `text`, `vision`, `speech`, `structured`, `reasoning` |
| `invalid-provider` | A provider is not one of `mock`, `openai`, `anthropic`, `kimi`, `deepseek`, `local` |
| `invalid-cost` | A cost value is negative or not an integer |
| `invalid-authority-level` | An authority level is not one of 0, 1, 2, 3, 4 |
| `no-authority-grant` | The task has no grant in force at the run's start instant |
| `authority-exceeded` | The requested level is above the granted ceiling |
| `authority-suspended` | The task's grant is suspended — the kill switch is engaged |
| `duplicate-authority-id` | A grant id already exists with different content |
| `invalid-policy-level` | A policy level is outside 0-4 |
| `duplicate-task-id` | A task id already exists with different content |
| `duplicate-binding-id` | A binding id already exists with different content |
| `duplicate-run-id` | A run id already exists with different content |
| `duplicate-decision-id` | A decision id already exists with different content |
| `idempotency-key-reuse` | The idempotency key was already used for a different record |
| `no-such-task` | The requested task does not exist |
| `no-such-binding` | The requested binding or run does not exist |
| `no-capable-binding` | No enabled binding can satisfy the task's capability |
| `nested-transaction` | An enlisted write tried to issue transaction control |

---

## 3. Architecture boundary

K-13 is the only component that may import an AI provider SDK (MODULE_MAP.md §12, rule A-1). This
slice contains only the mock adapter; live adapters go in `kernel/ai-gateway/adapters/`. No other
unit may import a provider package.

K-13 does not import any business module, financial module, K-10 Ledger Foundation, K-11 Orders, or
K-12 Payments. It imports only:

- platform substrate (`platform/time/instant`, `platform/outbox/*`, `platform/db/*`)
- K-09 Audit Foundation **types** for the audit action definition
- K-08 Event Infrastructure **types** for the event type definition

---

## 4. Provider adapters

The `AIProvider` port:

```ts
interface AIProvider {
  execute(binding: ModelBinding, task: TaskDefinition, input: unknown): Promise<AIProviderResult>
}
```

Live adapters for OpenAI, Anthropic, Kimi, DeepSeek and local models belong in
`kernel/ai-gateway/adapters/`. The mock adapter is network-free and deterministic.

---

## 5. Routing

`executeTask` selects the enabled binding with the lowest `priority` whose `capabilities` include
the task's capability. A tie breaks by `binding_id` ascending so the choice is deterministic. If no
binding matches, the call is refused with `no-capable-binding`.

---

## 6. Cost capture

Costs are integer minor units (`bigint`). The service computes:

```
inputCost  = ceil(inputTokens  / 1000) * costPer1KInput
outputCost = ceil(outputTokens / 1000) * costPer1KOutput
totalCost  = inputCost + outputCost
```

The mock adapter approximates token counts from JSON string length.

---

## 7. Outbox

Every `executeTask` appends two rows to `kernel_ai_gateway.outbox`:

- `ai.task_executed` event — payload contains run id, task id, binding id, status, tokens, total cost,
  cost asset type id, correlation id, finished at and idempotency key.
- `ai.task_executed` audit record — same evidence.

Every `recordDecision` appends two rows:

- `ai.decision_recorded` event — payload contains decision id, task id, run id, policy level,
  approved, recorded at and idempotency key.
- `ai.decision_recorded` audit record — same evidence.

---

## 8. Persistence

Three implementations of the `AIGatewayRepository` port:

- `InMemoryAIGatewayRepository` — reference implementation, enforces the same uniqueness rules as
  PostgreSQL.
- `PostgresAIGatewayRepository` — owns the `kernel_ai_gateway` schema.
- `EnlistedAIGatewayRepository` — for a caller that already owns a transaction.

Timestamps are projected as UTC text through `to_char`; costs are stored as `bigint` and read as
strings, then converted back to `bigint`.

The migration creates:

- `task_definition`, `model_binding`, `ai_run`, `ai_decision`
- `outbox` with the same columns as other module outbox tables
- Primary keys, unique constraints, `CHECK` constraints, indexes on `task_id` and `binding_id`
- Append-only triggers on the business tables
- An unprocessed outbox index
- A copy of `is_opaque_identifier` in `kernel_ai_gateway`

No statement names another module's schema; no foreign key leaves `kernel_ai_gateway`.

### Deliberately deferred

- No live provider SDKs (OpenAI, Anthropic, Kimi, DeepSeek, local) in this slice.
- No business-module integrations.
- No price or valuation logic beyond the binding's `costAssetTypeId` string.
- No relay wiring — the outbox rows are written; a relay dispatches them.
- No listing or search over runs or decisions.

---

## 9. Verification

```bash
npm run verify                                   # everything, including the tests below
node --test tests/ai-gateway.test.ts             # contract, refusals, routing, cost capture
node --test tests/ai-gateway-authority.test.ts   # authority ceiling, kill switch, grant versions
node --test tests/ai-gateway-repository.test.ts  # port conformance, adapter, migration contract
node --test tests/ai-gateway-mock-provider.test.ts  # mock determinism and cost calculation
npm run test:integration                          # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suite skips with a stated reason when no database is
configured.
