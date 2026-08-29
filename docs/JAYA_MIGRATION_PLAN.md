# JAYA — Migration Plan

**Governing documents:** `docs/JAYA_EXISTING_SYSTEM_AUDIT.md`, `docs/JAYA_MASTER_ARCHITECTURE.md`, `docs/JAYA_MODULE_MAP.md`

This plan describes how to move Claude's existing work into the target modular architecture and continue building.

---

## 1. Migration Philosophy

- **Preserve working code.** Do not rebuild merely for architectural purity.
- **Incremental migration.** Use strangler/compatibility adapters where tight coupling existed; here, coupling is already low.
- **Strangler approach** if a component must be redesigned:

```text
Old Logic
   │
   ▼
Compatibility Adapter
   │
   ▼
New Module Interface
```

- **Test at every step.** Run `npm run verify` after each migration unit.

---

## 2. Migration Units

Each unit follows this format:

```text
Existing component:
Current status:
Target module:
Required changes:
Risk:
Migration method:
Tests required:
```

---

### MU-001 — Toolchain Substrate

| Field | Value |
|---|---|
| Existing component | `package.json`, `tsconfig*.json`, ESLint, Prettier, `.nvmrc`, `package-lock.json` |
| Current status | Pinned, strict, fully tested |
| Target module | Platform substrate (no change) |
| Required changes | Add scripts/docs references for new modules. Keep pins exact. |
| Risk | Low |
| Migration method | Keep as-is; extend `scripts` when adding new commands (e.g., `test:e2e`). |
| Tests required | Existing toolchain tests must remain green. |

---

### MU-002 — Architectural Boundary Checker

| Field | Value |
|---|---|
| Existing component | `platform/checks/boundaries.ts`, `platform/architecture/manifest.ts` |
| Current status | Enforces 4 checks; 4 B-1 checks not yet built |
| Target module | Platform substrate + governance |
| Required changes | Expand `manifest.ts` for new M-XX modules; add table-ownership, policy-literal, contract-presence, and cycle checks as schema/contracts mature. |
| Risk | Medium if manifest changes break existing boundary tests |
| Migration method | Add new module entries to manifest incrementally; keep planted-violation fixtures updated. |
| Tests required | `npm run check:boundaries` must pass; planted violations must still be rejected. |

---

### MU-003 — Migration Contract and Runner

| Field | Value |
|---|---|
| Existing component | `platform/db/migrations.ts`, `platform/db/runner.ts`, `platform/db/client.ts`, `platform/db/postgres.ts` |
| Current status | 12 migration pairs validated; never applied to live server |
| Target module | Platform substrate |
| Required changes | None structural. Add new migrations for each new module schema. |
| Risk | Low |
| Migration method | Continue current naming convention: `NNNN_create_<owner>_<name>_schema.{up,down}.sql`. |
| Tests required | `npm run check:migrations`, integration tests with live PostgreSQL. |

---

### MU-004 — Fixtures / Seed System

| Field | Value |
|---|---|
| Existing component | `platform/fixtures/`, `db/fixtures/` |
| Current status | K-05 and K-08 seed data present |
| Target module | Platform substrate |
| Required changes | Add fixtures for new modules as they are implemented. |
| Risk | Low |
| Migration method | Follow existing fixture manifest contract. |
| Tests required | `npm run check:fixtures`. |

---

### MU-005 — K-05 Configuration

| Field | Value |
|---|---|
| Existing component | `kernel/configuration/` |
| Current status | Foundation implemented; no event/audit wiring |
| Target module | Module 83 — Feature Flags / Configuration + K-05 Configuration kernel |
| Required changes | Wire K-08 outbox publication on `publish`/`activate`. Wire K-09 audit recording on every mutation. |
| Risk | Low-medium |
| Migration method | Add event/audit calls inside service transaction; add outbox repository method. |
| Tests required | Existing configuration tests + new event/audit tests. |

---

### MU-006 — K-08 Event Infrastructure

| Field | Value |
|---|---|
| Existing component | `kernel/event-infrastructure/` |
| Current status | Foundation implemented; no producers |
| Target module | Domain Event Bus (Part G) + K-08 |
| Required changes | Add outbox relay process. Add typed event envelope. Add subscription registry. |
| Risk | Medium — relay process must be crash-safe |
| Migration method | Implement outbox table per schema, relay worker, dead-letter handling. |
| Tests required | Event delivery tests, crash-window recovery tests, idempotency tests. |

---

### MU-007 — K-09 Audit Foundation

| Field | Value |
|---|---|
| Existing component | `kernel/audit-foundation/` |
| Current status | Foundation implemented; no producers |
| Target module | Module 79 — Audit + K-09 |
| Required changes | Provide convenience `audit.recordAction(...)` helpers for services. Ensure audit calls are inside transactions. |
| Risk | Low |
| Migration method | Add audit helper; update services to call it. |
| Tests required | Audit integration tests, immutability tests. |

---

### MU-008 — K-01 Identity

| Field | Value |
|---|---|
| Existing component | `kernel/identity/` |
| Current status | Foundation implemented |
| Target module | Module 01 — Identity |
| Required changes | Add event/audit wiring. Add API route hooks when API layer built. |
| Risk | Low |
| Migration method | Extend service to emit `identity.created` event and record audit. |
| Tests required | Identity tests + event/audit tests. |

---

### MU-009 — K-02 Authentication

| Field | Value |
|---|---|
| Existing component | `kernel/authentication/` |
| Current status | Foundation implemented; no real verifier; no callers |
| Target module | Module 01 — Identity (authn portion) |
| Required changes | Implement `MockVerifier`, `PasswordlessOTPVerifier`, and verifier registry. Wire to K-04 permissions for administration. Add event/audit wiring. |
| Risk | High — authentication is security-critical |
| Migration method | Add verifier port implementations under `kernel/authentication/verifiers/`. Add integration tests. |
| Tests required | Verifier contract tests, session lifecycle integration tests, MFA tests. |

---

### MU-010 — K-03 Accounts

| Field | Value |
|---|---|
| Existing component | `kernel/accounts/` |
| Current status | Foundation implemented |
| Target module | Module 02 — Organisations + Module 04 — User Profile + Universal Account |
| Required changes | Split account profile data into module-owned areas: profile (non-financial) in M-04, org membership in M-02, capability activation in M-01. Keep core universal account in K-03. |
| Risk | Medium — careful to avoid duplicating or losing data ownership |
| Migration method | K-03 keeps `universal_account` table. M-01/M-02/M-04 reference it via ID, never writing K-03 tables. |
| Tests required | Account tests, capability tests, profile tests. |

---

### MU-011 — K-04 Permissions

| Field | Value |
|---|---|
| Existing component | `kernel/permissions/` |
| Current status | Foundation implemented; no read API; no callers |
| Target module | Module 03 — Roles & Permissions |
| Required changes | Restore controlled read-only methods for administration/audit. Wire into API gateway as guard. Add event/audit wiring. |
| Risk | Medium — read surface must be guarded by permissions itself |
| Migration method | Add `findGrant`, `findDecision`, `activePolicy` with explicit admin grants. |
| Tests required | Permission tests, authority tests, audit tests. |

---

### MU-012 — K-06 Policy Engine

| Field | Value |
|---|---|
| Existing component | `kernel/policy-engine/` |
| Current status | Foundation implemented; no consumers |
| Target module | Module 83 — Policy Studio + financial authority zone policy service |
| Required changes | Wire K-08 event publication. Add consumers: M-14 commission rules, M-16 payouts, M-28 rewards. Add UI studio module M-44. |
| Risk | Medium |
| Migration method | Keep engine as-is; expose stable `evaluate` API. Build studio UI later. |
| Tests required | Policy evaluation tests, financial-zone policy tests. |

---

### MU-013 — K-07 Feature Flags

| Field | Value |
|---|---|
| Existing component | `kernel/feature-flags/` |
| Current status | Foundation implemented; no real gating |
| Target module | Module 83 — Feature Flags |
| Required changes | Wire K-08 events. Add UI studio module M-44. Start gating experimental features. |
| Risk | Low |
| Migration method | Keep engine; add flag consumers incrementally. |
| Tests required | Feature flag tests. |

---

### MU-014 — K-11 Commerce Unit Registry

| Field | Value |
|---|---|
| Existing component | `kernel/commerce-unit-registry/` |
| Current status | Foundation implemented; system-authored |
| Target module | Module 12 — Product Catalogue primitives + Module 48 — Asset Type Registry |
| Required changes | Add human registrar path once K-02/K-04 wired. Expand to support asset type registration for ledger. Add event/audit wiring. |
| Risk | Low-medium |
| Migration method | Extend registry with asset type kinds; keep existing unit-of-measure support. |
| Tests required | Commerce unit tests, asset type tests. |

---

### MU-015 — New Kernel Foundations

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | K-10 Ledger, K-12 Conversation, K-13 AI Gateway, K-14 Notifications, K-15 Search |
| Required changes | Implement each as new kernel component with contract, service, repository, postgres adapter, migration, tests. |
| Risk | High — these are prerequisites for most business modules |
| Migration method | Follow existing kernel component pattern. Build in order: K-10 → K-12 → K-13 → K-15 → K-14. |
| Tests required | Full unit + integration test suites for each. |

---

### MU-016 — M-01 Universal Account / M-02 Capability & Verification

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 01 capability layer, Module 02 Organisations, Module 04 User Profile |
| Required changes | Create `modules/account/` and `modules/capability/` directories. Implement capability state machine, verification levels, org membership. |
| Risk | Medium |
| Migration method | New modules; no existing code to migrate. |
| Tests required | Capability tests, verification tests, org membership tests. |

---

### MU-017 — M-03 Need Engine

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 09 — Need Engine |
| Required changes | Implement Need object, lifecycle, multimodal ingestion ports, interpretation pipeline. |
| Risk | High — central commerce primitive |
| Migration method | New module. |
| Tests required | Need lifecycle, interpretation, privacy, event tests. |

---

### MU-018 — M-04 Universal Listing / Inventory Interface

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 22 — Inventory + Module 15 — Supply Offer |
| Required changes | Implement listing lifecycle and inventory interface (`getAvailability`, `reserve`, `release`, `commit`, `receive`, `adjust`, `transfer`). |
| Risk | High — inventory is explicitly required to be replaceable |
| Migration method | Define strict public API and contract tests first. |
| Tests required | Inventory contract tests, reservation race tests, policy tests. |

---

### MU-019 — M-05 Product Catalogue

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 12 — Product Catalogue |
| Required changes | Implement products, variants, SKUs, categories, brands, attributes, compatibility. |
| Risk | Medium |
| Migration method | New module; keep separate from inventory. |
| Tests required | Catalogue CRUD, variant tests, attribute tests. |

---

### MU-020 — M-06 / M-07 Search & Matching

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 13 — Search + Module 14 — Match Engine |
| Required changes | Implement keyword/semantic/visual search aggregation and configurable match scoring. |
| Risk | Medium |
| Migration method | Build on K-15 Search Foundation. |
| Tests required | Search contract tests, match scoring tests. |

---

### MU-021 — M-08 / M-09 / M-10 Offers, RFQ, Quotes

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 17 — RFQ/Tender + Module 18 — Quotes + Module 19 — Offer Scoring |
| Required changes | Implement sourcing ladder, RFQ privacy modes, quote comparison, explainable scoring. |
| Risk | Medium |
| Migration method | New modules. |
| Tests required | RFQ lifecycle, quote evaluation, scoring explanation. |

---

### MU-022 — M-11 Orders + M-21 Split Fulfilment

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 20 — Orders + Module 21 — Split Fulfilment |
| Required changes | Implement order state machine, immutable snapshots, parent/child orders for split fulfilment. |
| Risk | High — financial authority zone |
| Migration method | Strict state machine, snapshot on confirmation, no silent mutation. |
| Tests required | Order state tests, split fulfilment tests, immutability tests. |

---

### MU-023 — M-12 Payments + M-13 Financial Ledger + M-14 Commissions

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 44–53 financial core |
| Required changes | Implement payment orchestration, provider adapters, double-entry ledger, multi-value asset types, balances, commission rules. |
| Risk | Very high — financial correctness is non-negotiable |
| Migration method | Build K-10 first. Then M-12 with MockPaymentProvider. Then M-13 ledger. Then M-14 commission engine. Use exact-decimal arithmetic. |
| Tests required | Payment contract tests, ledger adversarial tests, commission tests, idempotency tests, crash-recovery tests. |

---

### MU-024 — M-15–M-18 Settlement, Payout, Risk

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 15–18 |
| Required changes | Settlement milestones, seller payouts with holds/reserves, seller risk scoring, listing risk moderation. |
| Risk | High |
| Migration method | Build on M-13 ledger and K-06 policy engine. |
| Tests required | Settlement tests, payout tests, risk tests. |

---

### MU-025 — M-19 Logistics + Driver/Vehicle/Dispatch

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 37–42 + Yaanadiri adapter |
| Required changes | Implement logistics module, driver/vehicle network, dispatch scoring, route optimisation, location service, Yaanadiri adapter. |
| Risk | Medium-high |
| Migration method | Build logistics core first with MockLogisticsProvider; add provider adapters later. |
| Tests required | Logistics contract tests, dispatch tests, route tests. |

---

### MU-026 — M-28–M-30 Rewards, Referrals, Attribution

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 54–56 |
| Required changes | Referral relationships, deterministic attribution, rewards ledger (not mutable balance). |
| Risk | Medium — must avoid pyramid/recruitment-only rewards |
| Migration method | Qualifying events defined in commission rules; attribution records immutable. |
| Tests required | Referral tests, attribution tests, rewards ledger tests. |

---

### MU-027 — M-31–M-33 / M-36–M-38 Cockpits and Intelligence

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 05–06 Universal Cockpit, Module 26–27 Merchant, Module 81–82 Ops, Module 59–64 Life Money, Module 30–33 Intelligence |
| Required changes | Build cockpit read-model projections from events. Build dashboards on top. |
| Risk | Medium |
| Migration method | Start with M-36 shell; add sections as underlying modules emit events. |
| Tests required | Projection tests, dashboard tests, privacy tests. |

---

### MU-028 — AI Agents and Control Plane

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Modules 71–75 |
| Required changes | K-13 AI Gateway, M-39 Model Registry, M-40 Router, M-41 Decision Audit, M-42 Monitoring, AI Action Policy. |
| Risk | High — must keep AI out of financial authority zone |
| Migration method | Build gateway first with MockAIProvider; add specialist agents and policy levels. |
| Tests required | AI contract tests, policy level tests, decision audit tests. |

---

### MU-029 — Multimodal Channels

| Field | Value |
|---|---|
| Existing component | None |
| Current status | Not started |
| Target module | Module 07–08 Conversations, Module 10 Multimodal Understanding, Module 69 Browser Assistant, Module 70 Wearables |
| Required changes | Conversation foundation, message content types, image/voice/document interpreters, browser extension API, wearable gateway API. |
| Risk | Medium |
| Migration method | Build K-12 first; add channel adapters feeding into M-03 Need. |
| Tests required | Conversation tests, multimodal interpretation tests, channel tests. |

---

### MU-030 — Deployment and CI

| Field | Value |
|---|---|
| Existing component | None (`.github/workflows/` missing) |
| Current status | Not started |
| Target module | Phase 20 hardening |
| Required changes | GitHub Actions workflows for verify, integration tests, build, deploy. Staging/production configs. |
| Risk | Medium — blocked by BL-10 credential permission |
| Migration method | Create workflow files; request Actions write permission. |
| Tests required | CI green on every PR. |

---

## 3. Migration Priority Order

| Order | Unit | Rationale |
|---|---|---|
| 1 | MU-002, MU-003, MU-004 | Keep substrate enforcement current |
| 2 | MU-006, MU-007 | Event and audit wiring unlock all later modules |
| 3 | MU-009 | Real verifier unlocks identity/auth chain |
| 4 | MU-015 | Complete missing kernel foundations |
| 5 | MU-016 | Account/capability enables cockpit shell |
| 6 | MU-017, MU-019, MU-018, MU-020, MU-021 | Core commerce primitives and discovery |
| 7 | MU-022, MU-023 | Financial authority zone |
| 8 | MU-024, MU-025 | Settlement, risk, logistics |
| 9 | MU-026, MU-028 | Incentives and AI |
| 10 | MU-027, MU-029 | Cockpits and channels |
| 11 | MU-030 | Deployment |

---

## 4. Verification After Each Unit

After every migration unit:

1. Run `npm run verify`.
2. Run `npm test`.
3. If database changes: run `npm run db:reset -- --yes` and `npm run test:integration`.
4. Update `docs/JAYA_AUTONOMOUS_STATUS.md`.
5. Update `docs/JAYA_DECISION_LOG.md` if a new decision is taken.

---

## 5. Rollback Plan

If a migration unit destabilises the codebase:

1. Identify the unit.
2. Revert its files via `git checkout` (do not run `git reset --hard` without instruction).
3. Re-run `npm run verify`.
4. Document the failure in `docs/JAYA_AUTONOMOUS_STATUS.md` and `docs/JAYA_DECISION_LOG.md`.
