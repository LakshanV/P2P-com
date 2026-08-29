# JAYA — Decision Log

**Governing documents:** `docs/JAYA_MASTER_ARCHITECTURE.md`, `docs/JAYA_MODULE_MAP.md`

This log records architectural and product decisions that future sessions must not unknowingly reverse.

---

## Decision Format

Each entry includes:

- **ID**: unique decision identifier
- **Date**: when taken
- **Decision**: what was decided
- **Context**: why the decision was needed
- **Consequences**: what follows
- **Status**: active / superseded / experimental

---

## D-001 — Project Continuation: Preserve Existing Foundation

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Preserve Claude's existing Phase 0 toolchain, kernel foundations, boundary checks, and test harness. Do not rebuild from scratch. |
| Context | The user brief asked for a complete modular P2P commerce OS. The existing branch already contains a strict modular monolith foundation with 1,261 passing tests, boundary enforcement, migration contracts, and nine kernel component libraries. Rebuilding would discard proven work. |
| Consequences | New work builds on `kernel/`, `platform/`, `tests/`, and the migration system. Existing module boundaries, naming, and tests remain authoritative. |
| Status | active |

---

## D-002 — Module Map Reconciliation

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Reconcile the user's 83-module brief with the existing 62-unit module map rather than replacing either. The 83 brief items become the public vocabulary; the existing K-/M-IDs become the implementation namespace. |
| Context | The existing map already has layered acyclic dependencies and machine-readable manifest. The brief adds depth (e.g., life budgeting, wearables, living-cost adviser). Mapping preserves continuity while expanding scope. |
| Consequences | Every brief module has a corresponding K-/M- target. New modules are added to the existing layer system. `platform/architecture/manifest.ts` must be updated when new modules are introduced. |
| Status | active |

---

## D-003 — Kernel vs Business Module Split

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Keep the existing split: 15 kernel components (shared capability) and 47+ business modules (domain logic). Identity, authentication, accounts, permissions, configuration, policy, events, audit, feature flags, ledger, commerce units, conversation, AI gateway, notifications, and search foundation remain kernel components. |
| Context | The brief lists many capabilities (Identity, AI Gateway, Notifications, Feature Flags, Audit) that are genuinely shared and should not be duplicated per vertical. The existing architecture already recognised this. |
| Consequences | Kernel components may not depend on business modules. Business modules depend downward only. |
| Status | active |

---

## D-004 — AI Gateway as Sole Provider Boundary

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Only the AI Gateway (K-13) may import, reference, or hold credentials for an AI model provider. Business modules address AI by task name only. |
| Context | Required by AI safety (no AI authority over money), provider neutrality, and testability. |
| Consequences | No business module or financial-zone module may import an LLM SDK. Provider adapters live under `kernel/ai/` or `modules/ai-adapters/`. Routing and model registry are separate modules. |
| Status | active |

---

## D-005 — Deterministic Financial Authority Zone

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | The financial authority zone (ledger, orders, payments, commissions, settlements, payouts, rewards ledger core) may never depend on the AI Gateway, and no AI output may be the source of a monetary value or financial state transition. |
| Context | Critical safety requirement from both the user brief and the existing architecture. |
| Consequences | All prices, totals, commissions, settlement amounts are computed by deterministic code from stored inputs and versioned policy. AI may advise, never authorise. |
| Status | active |

---

## D-006 — Mock Adapters First

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | For every external dependency, build an interface, a mock provider, a test provider, and integration documentation before attempting a live provider adapter. |
| Context | Many required credentials are missing (AI keys, payment sandbox, SMS/WhatsApp, maps, Singha, Yaanadiri). The blocker rule says autonomous work must not stop. |
| Consequences | `MockPaymentProvider`, `MockAIProvider`, `MockMapsProvider`, `MockNotificationProvider`, etc. are first-class citizens. Live adapters are added later without changing business logic. |
| Status | active |

---

## D-007 — Event-Driven Upward Communication

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Lower-layer modules notify higher layers exclusively by domain events through K-08 Event Infrastructure. No upward service calls. |
| Context | Prevents cycles, supports later extraction to services, and enables read-model projections. |
| Consequences | Every mutating service call must emit at least one event. The Cockpit Read-Model Engine and financial modules subscribe to events rather than polling tables. |
| Status | active |

---

## D-008 — Outbox Pattern for Transactional Events

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Important domain events are written to an outbox table in the same database transaction as the business state change, then relayed asynchronously to the event bus. |
| Context | Prevents lost events during crashes and supports at-least-once delivery. K-08 already provides durable pub/sub. |
| Consequences | Business mutations that emit events write to `*_outbox` tables within their module schema. A relay process forwards them to K-08. |
| Status | active |

---

## D-009 — Versioned Public Contracts

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Important module interfaces are versioned (e.g., `InventoryServiceV1`, `PaymentServiceV1`). New versions may be introduced; old versions are deprecated and supported during a migration window. |
| Context | Enables replacement of modules without breaking consumers. |
| Consequences | Module contract documents specify version. Breaking changes require a new version, consumer migration tasks, and regression tests. |
| Status | active |

---

## D-010 — Universal Cockpit First

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Build one adaptive cockpit per user (M-36) rather than separate buyer/seller/driver/admin applications. Role-specific views are sections within the same cockpit. |
| Context | A person can be buyer, seller, supplier, introducer, merchant, member, and driver simultaneously. Separate systems would fragment the experience. |
| Consequences | Cockpit layout adapts by role, context, activities, and permissions. Merchant dashboard, introducer dashboard, and financial cockpit are sections or specialised views of the universal cockpit. |
| Status | active |

---

## D-011 — Conversation-First UX but Not Transaction Record

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Conversations are the primary interaction model, but a message is never the sole record of a financial transaction. Orders, payments, and ledger entries are the authoritative transaction records. |
| Context | Telegram-like ease of use, but financial correctness requires deterministic systems. |
| Consequences | Chat messages can reference orders/payments but cannot mutate them. Deterministic commands (e.g., `confirmOrder`) must be issued through explicit APIs or approved AI actions. |
| Status | active |

---

## D-012 — No Pyramid / Recruitment-Only Rewards

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Referral/introducer compensation is linked only to configured genuine economic activity (e.g., a referred customer's qualifying transaction). No payment for recruitment alone, forced joining purchase, starter packs, or pyramid requirements. |
| Context | Legal and ethical requirement from the brief. |
| Consequences | M-29 Referrals and M-14 Commission Rules cooperate to define qualifying events. Attribution records are deterministic and auditable. |
| Status | active |

---

## D-013 — Singha and Yaanadiri Are Adapters

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Singha (wholesale) and Yaanadiri (mobility) are integration adapters, not architectural core. JAYA must support other wholesale facilitators and logistics providers equally. |
| Context | Brief explicitly states neither should be architecturally mandatory. |
| Consequences | Wholesale logic lives in M-09/M-11/M-34 with a `SinghaConnector` adapter. Logistics logic lives in M-19 with a `YaanadiriConnector` adapter. Core modules have no direct knowledge of Singha/Yaanadiri APIs. |
| Status | active |

---

## D-014 — Multi-Value Ledger, Not Just Fiat

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | The ledger supports multiple value classes: fiat, digital assets, rewards points, earnings, and configurable community/social value. Each asset type is registered with class, issuer, precision, transferability, withdrawability, expiry, valuation method, and restrictions. |
| Context | Brief's Universal Value Ledger requirement. |
| Consequences | No module treats JAYA Points as equivalent to LKR. Balances are derived from ledger entries. Restricted credits are clearly distinguished from freely withdrawable money. |
| Status | active |

---

## D-015 — Test Isolation and Contract Tests

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Every module must be testable in isolation using mocks/fakes at module boundaries. Contract tests exist for replaceable modules (inventory, payments, AI provider, logistics, search, notifications, crypto provider). |
| Context | Required for the changeability test and future module replacement. |
| Consequences | Module tests inject fake repositories and adapters. Replacing a module requires passing its contract tests. |
| Status | active |

---

## D-016 — Privacy and Consent as First-Class Modules

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Consent and privacy controls are not bolted onto user settings; they are a first-class concern owned by M-32 User Intelligence with audit support from K-09. |
| Context | Brief requires granular consent, deletion, export, and retention. |
| Consequences | Every feature that uses sensitive data checks consent through the User Intelligence API. Wellbeing/health inputs require explicit opt-in. |
| Status | active |

---

## D-017 — Use Existing Toolchain Pins

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Continue using the pinned toolchain: Node 22.18.0, npm 11.19.0, TypeScript 5.9.3, ESLint 10.8.1, Prettier 3.9.6. Do not upgrade without explicit reason. |
| Context | Reproducibility is already enforced by tests and `.nvmrc`. |
| Consequences | New dependencies must be pinned. Package manager and Node version tests remain green. |
| Status | active |

---

## D-018 — Conventional Commits Going Forward

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Replace the previous `Apply Claude session changes (iteration N)` commit style with conventional commits (`feat(...)`, `fix(...)`, `docs(...)`, `test(...)`, `refactor(...)`, etc.) so history is readable. |
| Context | The existing history is opaque. Future autonomy depends on readable history. |
| Consequences | Every commit message describes scope and change type. Breaking changes are flagged with `!` or `BREAKING CHANGE:`. |
| Status | active |

---

## D-019 — No Git Mutations Without Explicit Instruction

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Do not run `git commit`, `git push`, `git reset`, `git rebase`, or other git mutations unless explicitly asked by the user. |
| Context | System instruction and safety. |
| Consequences | All changes remain uncommitted in the working tree. The user or CI performs commits. |
| Status | active |

---

## D-020 — Run Integration Tests Sequentially

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Run `npm run test:integration` with `--test-concurrency=1` because the test harness derives a single `_test` database name and creates/drops it per test file. Parallel test files race on CREATE/DROP. |
| Context | The default `node --test` runs files in parallel. With one shared derived test database name, one file drops the database while another is using it. |
| Consequences | `package.json` `test:integration` script includes `--test-concurrency=1`. The test database is still created/dropped per file, preserving isolation. |
| Status | active |

---

## D-021 — Add `target` Option to `migrateUp`

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Add an optional `target` string to `RunnerOptions` so `migrateUp` can stop at a specific migration version. |
| Context | Several integration tests want to roll back one migration (e.g., 0009) to prove schema independence. As later migrations were added, rolling back a non-latest migration became impossible without first rolling back everything after it. |
| Consequences | Tests can migrate exactly to the version they intend to roll back. The CLI and default behaviour remain unchanged. |
| Status | active |

---

## D-022 — MockVerifier as First Verifier Adapter

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Implement `MockVerifier` in `kernel/authentication/verifiers/` as the first concrete `Verifier` adapter for K-02. |
| Context | K-02 had no real verifier; every authentication path failed. A mock verifier enables local development, tests, and demonstrates the adapter pattern without requiring external credentials. |
| Consequences | Real deployments must still wire real verifiers. The mock is deterministic, configurable, and refuses to be used in place of a real provider without explicit configuration. |
| Status | active |

---

## D-023 — Integration Tests Use PostgreSQL on Port 5434

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Use port 5434 for the local PostgreSQL container because ports 5432 and 5433 are already allocated on this machine. |
| Context | Docker could not bind 5432 or 5433. The `.env` file was updated to use 5434; the compose configuration already supports `POSTGRES_PORT`. |
| Consequences | New sessions must use the updated `.env` (already created). If the conflicting service is removed, port 5432 can be restored. |
| Status | active |

---

## D-024 — Module-Owned Outbox Tables with Platform Relay

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Each publishing module owns its own `outbox` table inside its schema. The platform relay polls every module-owned outbox and dispatches rows to K-08 Event Infrastructure and K-09 Audit Foundation. |
| Context | D-008 established the outbox pattern, but the original design left open whether outbox tables would be centralised. Central tables would couple producers to a shared schema and complicate module ownership. Per-module tables let a producer write business rows and outbox rows in the same transaction without opening another module's database context. |
| Consequences | K-05, K-06, K-07 and K-11 each have an `outbox` table, migration, repository insert path, and service wiring. The relay is provider-agnostic: it accepts `OutboxSource` implementations and downstream `EventPublisher`/`AuditRecorder` interfaces. A live PostgreSQL integration test exercises the relay against real module tables. Future modules add their own outbox tables; the relay is extended with a new source. |
| Status | active |

---

## D-025 — Kernel-Specific Outbox Adapters

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | K-08 and K-09 each provide their own outbox-to-service adapter (`EventServicePublisher`, `AuditServiceRecorder`) rather than placing that knowledge in the platform relay. |
| Context | The platform relay must remain pure and know nothing about event types, audit actions, or kernel services. At the same time, the payload a module writes to its outbox is the exact request those services expect. An adapter pattern lets K-08/K-09 validate and persist the payload using their own registries and repositories, while the relay only transports opaque rows. This also preserves the architectural layering: platform code does not import kernel services. |
| Consequences | New outbox consumers add an adapter inside their own component. The relay calls the generic `EventPublisher`/`AuditRecorder` interfaces. Integration tests wire real adapters, services, repositories, and schemas to prove end-to-end dispatch. |
| Status | active |

---

## D-026 — K-10 Identifier Rules Match Platform Standard

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | K-10 Ledger Foundation uses the same `is_opaque_identifier` rule set as every other kernel component, including the personal-name pattern `^[A-Za-z]+[._-][A-Za-z]+$`. The TypeScript registry and the PostgreSQL migration function must remain character-for-character identical to the other copies. |
| Context | The K-10 implementation initially shipped a stricter personal-name pattern in TypeScript (`^[A-Z][a-z]+[._-][A-Z][a-z]+$`) while its migration copied the platform-wide broader pattern. This allowed IDs such as `acct_asset` to pass TypeScript validation but be rejected by the database check constraint. |
| Consequences | K-10 tests and consumers use identifiers that pass the platform-wide rule (e.g., include digits or otherwise avoid the letter_letter pattern). The migration test that compares every copy of `is_opaque_identifier` remains authoritative. |
| Status | active |

---

## D-027 — K-10 PostgreSQL Transaction Decoder Accepts Sealed Entries

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | `PostgresLedgerRepository.findTransactionById` and `findTransactionByIdempotencyKey` return `LedgerEntry` domain objects from the entry query and pass them unchanged to `validateTransaction`. The decoder does not attempt to read snake_case columns from already-decoded entries. |
| Context | The original K-10 postgres-repository decoded entries twice: the entry query returned sealed `LedgerEntry` objects, but `toTransaction` tried to read `account_id`, `side`, and `amount` from those objects, causing `account_id is undefined` failures on retry/dedup paths. |
| Consequences | Entry reads have one shape. Future repository methods that return raw rows must decode them before passing to `toTransaction`, or `toTransaction` must be taught to accept both shapes. |
| Status | active |

---

## D-028 — K-10 Migration Rollback Drops Deferred Constraint Trigger

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Migration 0017's rollback must drop the `ledger_entry_balanced` deferred constraint trigger before dropping `enforce_balanced_transaction()`, because the function has a dependent trigger object. |
| Context | The initial 0017 down migration dropped append-only triggers and then the `enforce_balanced_transaction()` function, but omitted the deferred trigger that references it. PostgreSQL refused `DROP FUNCTION` with a dependent-object error. |
| Consequences | All future migrations that create deferred constraint triggers or any trigger functions must drop the trigger before dropping the function in their rollback. This pattern is added to the migration checklist. |
| Status | active |

---

## D-029 — K-12 Conversation Foundation

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Implement K-12 as a kernel component owning `conversation`, `participant`, `message`, and `outbox` in schema `kernel_conversation`. It depends only on K-01 Identity and K-03 Accounts, does not verify subject/account existence in this slice, and emits `conversation.created` and `conversation.message_sent` through its module-owned outbox. |
| Context | The brief requires a conversation-first UX and a separate messaging-content module. A clean foundation for conversations, participants, and messages is needed before M-35 Conversation Supervision or business modules can build on it. |
| Consequences | Business modules reference conversations by id. Participant uniqueness is scoped to `(conversation_id, account_id)`. Messages are append-only. Future work can add attachments, read receipts, and threading without rewriting the core. |
| Status | active |

---

## D-030 — K-13 AI Gateway

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Implement K-13 AI Gateway as the sole boundary to model providers. It owns task definitions, model bindings, AI runs, and recorded decisions in schema `kernel_ai_gateway`. It exposes `registerTask`, `registerModel`, `executeTask`, and `recordDecision`. A deterministic `MockAIProvider` is the first adapter. |
| Context | The brief requires provider-neutral AI access with cost capture and a task router. Business modules and financial modules must never import an AI SDK or call a model directly. K-13 is the only unit permitted to hold provider knowledge. |
| Consequences | All AI-driven business logic routes through `AIGatewayService.executeTask(taskName, input)`. The gateway selects a binding by capability and priority, executes the provider adapter, captures token counts and cost in minor units, and emits `ai.task_executed` plus `ai.decision_recorded`. Live provider adapters (OpenAI, Anthropic, Kimi, etc.) are added later under `kernel/ai-gateway/adapters/` without changing business consumers. |
| Status | active |

---

## D-031 — K-14 Notifications

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Implement K-14 Notifications as the channel-neutral notification kernel. It owns `channel`, `notification`, and `delivery_attempt` in schema `kernel_notifications` (plural, derived from the manifest directory). It exposes `createChannel`, `send`, `schedule`, `getStatus`, and `recordDeliveryAttempt`. The first concrete provider is an in-app provider that succeeds synchronously. |
| Context | The brief requires provider-independent notifications across in-app, push, SMS, WhatsApp, and email. Without a live email/SMS/WhatsApp provider, the in-app channel provides a working end-to-end path while preserving the provider adapter slot. |
| Consequences | Notifications are created and stored before delivery; delivery attempts are recorded. `notification.sent` and `notification.failed` events are emitted through the module-owned outbox. Future channels (email, SMS, WhatsApp, push) are added as provider adapters under `kernel/notifications/providers/` without changing the service surface. |
| Status | active |

---

## D-032 — K-15 Search Foundation

| Field | Value |
|---|---|
| Date | 2026-08-24 |
| Decision | Implement K-15 Search Foundation as a provider-neutral search abstraction. It owns `document` and `query_log` in schema `kernel_search_foundation`. It exposes `index`, `query`, and `remove`. The first adapter uses PostgreSQL full-text search (`to_tsvector`, GIN index, `ts_rank_cd`) with keyword and filter support. |
| Context | The brief requires keyword, semantic, structured, and visual search aggregation. A working in-database implementation satisfies the first slice without adding external dependencies. The port-based repository design lets the search backend be replaced (Elasticsearch, Meilisearch, etc.) later without changing consumers. |
| Consequences | Consumers index documents by `ownerType`/`ownerId`, query with text + filters, and receive ranked results. Query execution is logged. `search.indexed`, `search.removed`, and `search.performed` are emitted through the module-owned outbox. Semantic/visual search is deferred to a future adapter. |
| Status | active |

---

## D-033 — M-01 Universal Account, and the first module-owned schema

| Field | Value |
|---|---|
| Date | 2026-08-29 |
| Decision | Implement M-01 as the first business module. It owns `account_capability` and `capability_state` in schema `module_universal_account`, derived from its manifest directory `universal-account`. It exposes `activateCapability`, `deactivateCapability`, `listCapabilities` and `getCapabilityHistory`, and emits `capability.activated` and `capability.deactivated` through a module-owned outbox. `accountId` is an opaque K-03 identifier and is deliberately not a foreign key. |
| Context | Everything above L1 depends on knowing which roles an account may act in. `docs/JAYA_FINAL_GAP_ANALYSIS.md` §9 ranks M-01 and M-02 as the third P0 item, behind the two kernel gaps that are now closed. The module map named the schema `module_account`, but `platform/db/schema-namespaces.ts` derives every schema name from the manifest directory, and the derivation is the authority — the same correction K-14 took when `kernel_notification` became `kernel_notifications`. |
| Consequences | The current state of a role and the history of how it got there are separate tables: one row per `(account, capability)` in `account_capability`, and an append-only `capability_state` log enforced by a database trigger. Reactivating a deactivated capability moves the same row back to `active` and appends a transition, so a capability has one identity for its whole life and consumers may hold its id. `tests/migrations.test.ts` no longer asserts that no business module owns a schema; it asserts the property that survives M-01 — a `module_` migration is legal only when the manifest registers a module of that name. Verification levels are refused as a foreign concern: they belong to M-02. |
| Status | active |

---

## Decision Status Legend

| Status | Meaning |
|---|---|
| active | Currently binding |
| superseded | Replaced by a later decision; keep for history |
| experimental | Trial decision; revisit after evaluation |
