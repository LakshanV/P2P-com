# JAYA — MODULE MAP

**Document status:** BASELINE (specification-only — no module in this map has any implementation)
**Created by task:** DOC-001
**Authority rank:** 5 (module specifications) per `JAYA_MASTER_AUTONOMOUS_DEV_GUIDE_v3.md` §1
**Governing sources:** v3 §7 (modularity), §8 (commerce kernel), §9 (primary module map), §10 (module contract standard), §11 (universal commerce unit), §29 (AI control plane), §37 (event-driven integration), §38 (financial architecture). Compatible detail from v1.0 §8 (modular monolith first), §9 (core domain objects), §56 (event architecture).

**Related baseline documents:**
- [CURRENT_IMPLEMENTATION_STATUS.md](./CURRENT_IMPLEMENTATION_STATUS.md)
- [MASTER_IMPLEMENTATION_CHECKLIST.md](./MASTER_IMPLEMENTATION_CHECKLIST.md)

---

## Table of contents

- [1. Purpose and binding rules](#1-purpose-and-binding-rules)
- [2. Architectural shape — modular monolith](#2-architectural-shape--modular-monolith)
- [3. The commerce kernel](#3-the-commerce-kernel)
- [4. Independently owned business modules](#4-independently-owned-business-modules)
- [5. Reconciliation with the v3 module list](#5-reconciliation-with-the-v3-module-list)
- [6. Module contract standard](#6-module-contract-standard)
- [7. Ownership and contract register](#7-ownership-and-contract-register)
- [8. Dependency graph](#8-dependency-graph)
- [9. Build order](#9-build-order)
- [10. Anti-cycle rules](#10-anti-cycle-rules)
- [11. Deterministic financial authority zone](#11-deterministic-financial-authority-zone)
- [12. AI provider neutrality](#12-ai-provider-neutrality)
- [13. Enforcement and verification](#13-enforcement-and-verification)

---

## 1. Purpose and binding rules

This document defines the module topology of JAYA before any code exists, so that the first line of implementation lands inside an already-decided boundary rather than creating one by accident.

Five rules are binding on every subsequent task. They are not style preferences.

| # | Rule | Source | Consequence of violation |
|---|---|---|---|
| MR-1 | **Module isolation.** No module may read or write another module's private data store. Cross-module access happens only through a published application interface or a published event. | v3 §7, §10 | P1 defect. Change is rejected, not patched. |
| MR-2 | **Acyclic dependencies.** A module may depend only on the commerce kernel and on modules in a strictly lower layer. Upward or same-layer notification travels by event only. | v3 §7, §37 | P1 defect. |
| MR-3 | **Deterministic financial authority.** Modules in the financial authority zone (§11) may not take a dependency on the AI Gateway, and no AI output may be the source of a monetary value, a financial state transition, or an authorisation decision. | v3 §38, v1 §3.4 | P0 defect. All progression stops. |
| MR-4 | **AI provider neutrality.** Only the AI Gateway kernel component may import, reference, or hold credentials for a model provider. Every other module addresses AI by task name. | v3 §29, §30 | P1 defect. |
| MR-5 | **Contract before code.** A module's contract (§6) is written and reviewed before its implementation task is delegated. | v3 §10, §45 | Task is returned unimplemented. |

---

## 2. Architectural shape — modular monolith

JAYA starts as a **bounded modular monolith**: a single deployable unit, a single primary database, and hard internal boundaries enforced by module ownership rather than by network calls (v1 §8 — "do NOT create premature microservice complexity"; v3 §7 — modularity is non-negotiable).

The boundary discipline is designed so that any module can later be extracted to a service without rewriting its business logic. That requires, from day one: module-owned schema namespaces, no cross-module joins, no shared mutable in-process state, and event-mediated reaction rather than direct invocation across layers.

```text
                        +----------------------------------------+
                        |            CLIENT CHANNELS             |
                        |  web . mobile . (later) voice, partner |
                        +--------------------+-------------------+
                                             |
                        +--------------------v-------------------+
                        |        API / CHANNEL GATEWAY           |
                        |  authn . rate limit . scoping . audit  |
                        +--------------------+-------------------+
                                             |
   +-----------------------------------------v-------------------------------------------+
   |                          BUSINESS MODULES (layered, acyclic)                          |
   |   cockpits . verticals . intelligence . fulfilment . commerce core . primitives       |
   +-----------------------------------------+-------------------------------------------+
                                             |  (published APIs downward, events upward)
   +-----------------------------------------v-------------------------------------------+
   |                                 COMMERCE KERNEL                                       |
   |  identity . accounts . authn . permissions . policy . config . events . AI gateway    |
   |  ledger foundation . audit . notifications . search foundation . flags . CU registry   |
   +-----------------------------------------+-------------------------------------------+
                                             |
   +-----------------------------------------v-------------------------------------------+
   |                              PLATFORM SUBSTRATE                                       |
   |  runtime . database . migrations . object storage . queue . logging . test harness    |
   +---------------------------------------------------------------------------------------+
```

Planned repository shape (created by a later task, **not** by DOC-001):

```text
/docs                  planning + contract documents (this baseline)
/platform              substrate: db, migrations, queue, storage, logging, config loader
/kernel                the commerce kernel components of §3 — one directory per component
/modules               independently owned business modules of §4 — one directory per module
/design-system         shared UI primitives (v3 §34)
/apps                  deployable surfaces composing modules (web, admin)
/tests                 cross-module integration, E2E, adversarial suites
```

---

## 3. The commerce kernel

The kernel is small, stable, and shared. It contains capability that is genuinely common to every commerce category. **Business rules do not live here** (v3 §8). If a proposed kernel change is motivated by one business module's need, that is evidence it belongs in the module, not the kernel.

| ID | Kernel component | Owned responsibility | Owned data | May depend on |
|---|---|---|---|---|
| K-01 | **Identity** | Person/organisation identity records, identifiers, linkage | identity, identity_document | substrate |
| K-02 | **Authentication** | Credentials, sessions, MFA, tokens | credential, session, mfa_factor | K-01 |
| K-03 | **Accounts** | The one universal JAYA Account and its profile core | account, account_profile | K-01 |
| K-04 | **Permissions** | RBAC/ABAC evaluation, role and grant storage, purpose-based staff access | role, grant, permission_check_log | K-01, K-03 |
| K-05 | **Configuration** | Environment and platform configuration resolution | config_entry | substrate |
| K-06 | **Policy Engine** | Versioned business policy storage and evaluation; every policy read returns a version id | policy, policy_version | K-05 |
| K-07 | **Feature Flags** | Flag definitions, targeting, rollout stages, kill switches | feature_flag_version, feature_flag_activation, feature_flag_lifecycle | K-05 |
| K-08 | **Event Infrastructure** | Durable publish/subscribe, idempotency keys, retries, dead-letter, replay | event, event_delivery, dead_letter | substrate |
| K-09 | **Audit Foundation** | Append-only audit trail of who did what, with what purpose | audit_event | K-01, K-04 |
| K-10 | **Ledger Foundation** | Double-entry primitives, accounts, entries, immutability guarantees | ledger_account, ledger_entry, ledger_txn | substrate |
| K-11 | **Commerce Unit Registry** | The `CommerceUnit` abstraction, unit-of-measure registry, category-adapter registration | commerce_unit_type, unit_of_measure, category_adapter | K-05 |
| K-12 | **Conversation Foundation** | Conversation, participant, message, attachment primitives | conversation, participant, message | K-01, K-03 |
| K-13 | **AI Gateway** | The single boundary to model providers: model registry runtime, task router, adapters, evaluation hooks, cost/latency capture, fallbacks | ai_task, ai_model_binding, ai_run | K-05, K-06, K-09 |
| K-14 | **Notifications** | Channel-neutral delivery of templated notifications | notification, notification_channel, delivery_attempt | K-03, K-08 |
| K-15 | **Search Foundation** | Index abstraction, query primitives, ranking hooks (weights themselves stay server-side and private, v3 §41) | search_index_doc | substrate |

**Kernel dependency rule:** the kernel is itself internally layered — `K-01 -> K-02/K-03 -> K-04` — and every other component sits on the substrate plus at most those. No kernel component may depend on a business module, ever. That single rule is what keeps the whole graph acyclic.

---

## 4. Independently owned business modules

Each module below is independently owned: one module owns its data, its API, its UI surfaces, its tests, and its release. "Independently owned" means a redesign of the module's internals must be possible without editing any other module's source (v3 §7).

Layers are numbered L1–L8. **A module may depend only on lower-numbered layers and on the kernel.**

### L1 — Account & capability

| ID | Module | Purpose | Owns |
|---|---|---|---|
| M-01 | Universal Account | Account capabilities (buyer, seller, host, provider, introducer, delivery, business purchaser) on one identity | account_capability, capability_state |
| M-02 | Capability & Verification | Progressive verification levels 0–5, evidence, jurisdiction-configurable tax/payout identifiers | verification_case, verification_evidence, verification_level |

### L2 — Commerce primitives

| ID | Module | Purpose | Owns |
|---|---|---|---|
| M-03 | Item / Commerce Request | The Request/Need object: multimodal capture, structured interpretation, lifecycle | request, request_item, request_media, request_interpretation |
| M-04 | Universal Listing | Listing lifecycle over every CommerceUnit type; AI-assisted creation flow | listing, listing_version, listing_media, listing_declaration |
| M-05 | Product Catalog | Canonical products, variants, attributes, identifiers | product, variant, attribute, inventory_snapshot |

### L3 — Discovery

| ID | Module | Purpose | Owns |
|---|---|---|---|
| M-06 | Search & Discovery | Query, facet, rank, and browse surfaces over listings and catalog | search_query_log, discovery_surface |
| M-07 | Matching | Request-to-supply matching and match explanation | match, match_explanation, match_run |

### L4 — Negotiation

| ID | Module | Purpose | Owns |
|---|---|---|---|
| M-08 | Offers | Direct seller offers against a request | offer, offer_line |
| M-09 | RFQ / Reverse Marketplace | Buyer-initiated RFQ, supplier invitation, privacy modes | rfq, rfq_invitation, rfq_policy |
| M-10 | Quotes | Supplier quotes, comparison, ranking inputs, split-fulfilment candidates | quote, quote_line, quote_evaluation |

### L5 — Financial core *(deterministic authority zone — see §11)*

| ID | Module | Purpose | Owns |
|---|---|---|---|
| M-11 | Orders | Order state machine, immutable commercial snapshot, buyer acceptance | order, order_item, order_snapshot, order_event |
| M-12 | Payments | Provider-neutral authorise/capture/refund with idempotency keys and webhook handling | payment, payment_attempt, refund, webhook_receipt |
| M-13 | Financial Ledger | Authoritative money movement built on K-10 primitives | ledger_journal, ledger_posting |
| M-14 | Commission Rules | Configuration-driven commission calculation; stores the policy version applied at purchase time | commission_rule, commission_charge |

### L6 — Settlement, payout, risk

| ID | Module | Purpose | Owns |
|---|---|---|---|
| M-15 | Settlements | Eligibility, milestones, release scheduling | settlement, settlement_milestone |
| M-16 | Seller Payouts | Held vs eligible proceeds, reserves, accelerated payout, payout execution | payout, payout_hold, reserve, security_instrument |
| M-17 | Seller Risk | Seller scoring, tiering, exposure limits | seller_risk_profile, risk_signal |
| M-18 | Listing Risk / Trust & Safety | Listing review pipeline, moderation queue, appeals, sampling | review_case, moderation_decision, sample_record |

### L7 — Fulfilment and resolution

| ID | Module | Purpose | Owns |
|---|---|---|---|
| M-19 | Logistics | Pickup, delivery, proof of delivery, failures, multi-stop foundations | delivery, delivery_stop, proof_of_delivery |
| M-20 | Returns | Return authorisation and movement | return_case, return_item |
| M-21 | Disputes | Dispute lifecycle, evidence, resolution | dispute, dispute_evidence, resolution |
| M-22 | Warranty / Buyer Protection | Protection eligibility, inspection windows, claims | protection_case, inspection |

### L8 — Verticals, incentives, intelligence, cockpits, governance

*All L8 modules depend downward only. No L8 module may be depended upon by L1–L7.*

| ID | Module | Purpose | Owns |
|---|---|---|---|
| M-23 | Accommodation | Property, room type, calendar, reservation, check-in/out — reusing shared identity, payment, ledger, disputes | property, room_type, availability, reservation |
| M-24 | Services | Service offering, scheduling, completion evidence | service_offering, service_booking, completion_record |
| M-25 | Used Goods Risk Pack | Pluggable evidence and declaration requirements for used goods | used_goods_requirement, used_goods_declaration |
| M-26 | Vehicle Risk Pack | VIN, title, mileage, inspection, security-interest checks | vehicle_record, vehicle_evidence |
| M-27 | Fashion / Luxury Risk Pack | Brand, serial, authenticity evidence | authenticity_case, authenticity_evidence |
| M-28 | Rewards | JAYA Points **ledger** — earn, redeem, expire, reverse, adjust (never a mutable balance) | points_entry, points_account, reward_rule |
| M-29 | Referrals | Introducer relationships and referral records | referral, introducer_link |
| M-30 | Attribution | Deterministic attribution of outcomes to referrers and campaigns | attribution_record, attribution_run |
| M-31 | Budgeting | User budgets: allocated, spent, committed, remaining | budget, budget_category, commitment |
| M-32 | User Intelligence | Permissioned personalisation and preference learning | user_signal, preference_profile |
| M-33 | Seller Market Intelligence | Demand, pricing, missed-opportunity and inventory insight cards | insight_card, insight_run |
| M-34 | Finance Provider Marketplace | Pluggable licensed finance providers and eligibility presentation | finance_provider, finance_offer, eligibility_result |
| M-35 | Conversation Supervision | Staff monitoring centre, escalation filters, human takeover, redaction | supervision_case, takeover_session, access_log |
| M-36 | User Cockpit | Buyer-facing composition surface | cockpit_layout, cockpit_preference |
| M-37 | Seller Cockpit | Seller operating dashboard | seller_cockpit_layout |
| M-38 | Operations Cockpit | Internal staff supervision surface | ops_view_config, ops_action_log |
| M-39 | AI Model Registry | Model catalogue, versions, shadow-mode candidates *(data owner; K-13 is the runtime boundary)* | ai_model_record, ai_model_version, shadow_run |
| M-40 | AI Routing / Control Plane | Task-to-model routing rules, thresholds, fallbacks, rollout of model changes | routing_rule, routing_version |
| M-41 | AI Decision Audit | Durable record of AI decisions, overrides, and outcomes | ai_decision_record, human_override |
| M-42 | AI Monitoring | Cost, latency, error, drift and disagreement monitoring | ai_metric, ai_alert |
| M-43 | Policy / Configuration Studio | Authoring and approval UI over K-06 policies | policy_draft, policy_approval |
| M-44 | Feature Flags / Rollouts UI | Authoring and rollout control over K-07 | rollout_plan |
| M-45 | Analytics / Platform Intelligence | Platform-level metrics and north-star reporting | metric_definition, metric_snapshot |
| M-46 | Admin Audit | Staff-facing audit search over K-09 | audit_query, audit_export |
| M-47 | Module Registry / Health | Module inventory, version, health, contract registry | module_record, module_health, contract_record |

---

## 5. Reconciliation with the v3 module list

v3 §9 lists fifty modules and permits refinement of boundaries where technically justified, provided modular isolation is preserved. Several entries on that list are realised as **kernel components** rather than business modules, because they are common capability shared by every category (v3 §8). Nothing is dropped.

| v3 §9 entry | Realised as | Note |
|---|---|---|
| 1. Identity & Authentication | K-01 + K-02 | Kernel: shared by every capability |
| 11. Commerce Unit Registry | K-11 | Kernel: named explicitly in v3 §8 |
| 40. Notifications | K-14 | Kernel: named explicitly in v3 §8 |
| 41. AI Gateway | K-13 | Kernel: named explicitly in v3 §8; the only provider boundary |
| 47. Feature Flags / Rollouts | K-07 (engine) + M-44 (authoring UI) | Engine is kernel; the staff-facing studio is a module |
| 46. Policy / Configuration Studio | K-06 (engine) + M-43 (authoring UI) | Same split as flags |
| 42. AI Model Registry | M-39 | Data and authoring module over the K-13 runtime |
| 2–10, 12–39, 43–45, 48–50 | M-01 … M-47 | Direct mapping, layer-assigned above |

**Additions beyond the v3 §9 list, and why:**
- **M-27 Fashion / Luxury Risk Pack** — v3 §16 defines a Fashion/Luxury risk pack alongside phones and vehicles; §9 named only the used-goods and vehicle packs. Added so the requirement is not silently lost (v3 §53).
- **M-30 Attribution** — v1 §36 defines a distinct attribution engine. Keeping it separate from M-29 Referrals preserves deterministic, auditable attribution independent of referral UX.

**Count:** 15 kernel components + 47 business modules = 62 owned units, covering all 50 v3 §9 entries plus the two additions and the kernel/UI splits.

---

## 6. Module contract standard

Every module publishes a contract document at `/docs/modules/<module-id>-<name>.md` before implementation begins. The contract carries all fields required by v3 §10:

```text
MODULE NAME:
MODULE ID:
LAYER:
BUSINESS PURPOSE:
OWNED DATA:              (tables/collections owned exclusively by this module)
PUBLIC API:              (the only sanctioned entry points for other modules)
EVENTS CONSUMED:
EVENTS EMITTED:
UI SURFACES:
PERMISSIONS:
CONFIGURATION:           (policy keys owned or read; no in-code business constants)
AI CAPABILITIES:         (task names only — never provider or model names)
DEPENDENCIES:            (kernel components + strictly lower-layer modules)
ERROR STATES:
RETRIES / IDEMPOTENCY:
TESTS:
OBSERVABILITY:
FEATURE FLAGS:
VERSION:
DEFINITION OF DONE:
```

**Status:** zero module contracts exist. All 62 are `NOT STARTED` and are tracked individually in [MASTER_IMPLEMENTATION_CHECKLIST.md](./MASTER_IMPLEMENTATION_CHECKLIST.md).

---

## 7. Ownership and contract register

Ownership answers one question: *when this behaviour is wrong, which module is edited?* Exactly one module owns each answer.

| Concern | Sole owner | Everyone else must |
|---|---|---|
| What a user is allowed to do | K-04 Permissions | ask; never re-derive |
| What a policy value is right now | K-06 Policy Engine | read with a version id, and store that id |
| What a price, total or commission is | M-11 Orders, M-14 Commission | read the computed value; never recompute |
| Where money actually is | M-13 Financial Ledger | read; never write balances |
| Whether a seller may be paid | M-16 Seller Payouts | read; never release funds |
| Whether a listing may be public | M-18 Listing Risk | read status; never publish directly |
| What a points balance is | M-28 Rewards (ledger-derived) | read; never store a mutable balance |
| Which model answers a task | K-13 AI Gateway + M-40 Routing | name a task, nothing more |
| What happened, for audit | K-09 Audit Foundation | write through the audit API |

**Contract change protocol.** A module's public API and emitted-event shape are a contract. A breaking change requires: a new contract version; a deprecation window during which both versions are served; a migration task for every consumer named in the dependency graph; and a regression run across those consumers. Non-breaking additions require only a version bump. Silent contract edits are a P1 defect.

---

## 8. Dependency graph

Edges point from dependent to dependency. **Every edge points downward.** There are no upward or lateral call edges anywhere in this graph; upward propagation happens exclusively through K-08 events.

```text
L8  COCKPITS / VERTICALS / INTELLIGENCE / GOVERNANCE
    M-36 User Cockpit    M-37 Seller Cockpit    M-38 Ops Cockpit
    M-23 Accommodation   M-24 Services          M-25/26/27 Risk Packs
    M-28 Rewards         M-29 Referrals         M-30 Attribution
    M-31 Budgeting       M-32 User Intel        M-33 Seller Intel
    M-34 Finance Mkt     M-35 Conv. Supervision
    M-39/40/41/42 AI Control Plane
    M-43/44/45/46/47 Governance & Platform Ops
         |
         v
L7  FULFILMENT & RESOLUTION
    M-19 Logistics   M-20 Returns   M-21 Disputes   M-22 Warranty
         |
         v
L6  SETTLEMENT / PAYOUT / RISK
    M-15 Settlements   M-16 Seller Payouts   M-17 Seller Risk   M-18 Listing Risk
         |
         v
L5  FINANCIAL CORE   <== deterministic authority zone (see section 11)
    M-11 Orders   M-12 Payments   M-13 Ledger   M-14 Commission
         |
         v
L4  NEGOTIATION
    M-08 Offers   M-09 RFQ   M-10 Quotes
         |
         v
L3  DISCOVERY
    M-06 Search & Discovery   M-07 Matching
         |
         v
L2  COMMERCE PRIMITIVES
    M-03 Request   M-04 Listing   M-05 Catalog
         |
         v
L1  ACCOUNT & CAPABILITY
    M-01 Universal Account   M-02 Capability & Verification
         |
         v
L0  COMMERCE KERNEL  (K-01 ... K-15)
         ^   every layer above may depend directly on the kernel
         |
         v
    PLATFORM SUBSTRATE (runtime . db . migrations . queue . storage . logging . tests)
```

### 8.1 Event flow — the only upward path

Lower layers never call upward. They emit; higher layers subscribe. Representative flows (event names from v3 §37, extended with v1 §56 detail where compatible):

| Emitter | Event | Subscribers (higher layer) |
|---|---|---|
| M-01 | `user.created` | M-36, M-45 |
| M-02 | `seller.verified` | M-16, M-17, M-37 |
| M-03 | `request.created`, `request.interpreted`, `request.matched` | M-07, M-35, M-45 |
| M-04 | `listing.created`, `listing.published` | M-06, M-18, M-33 |
| M-18 | `listing.reviewed` | M-04 *(via subscription — M-18 never writes listing rows)*, M-38 |
| M-11 | `order.created`, `order.confirmed`, `order.completed` | M-15, M-19, M-28, M-31, M-33, M-45 |
| M-12 | `payment.authorised`, `payment.captured`, `payment.refunded` | M-13, M-15, M-38 |
| M-14 | `commission.created` | M-13, M-45 |
| M-19 | `delivery.assigned`, `delivery.completed` | M-15, M-22, M-36 |
| M-23 | `stay.checked_out` | M-15, M-28 |
| M-24 | `service.completed` | M-15, M-28 |
| M-15 | `settlement.eligible`, `settlement.released` | M-16, M-37, M-38 |
| M-28 | `reward.earned` | M-31, M-36 |
| M-17, M-18 | `risk.escalated` | M-35, M-38 |

Note the M-18 to M-04 case: listing review lives one layer *above* listing. Review outcomes therefore travel as `listing.reviewed` events that M-04 consumes and applies to its own lifecycle state. M-18 never mutates a listing row. This is the pattern used wherever a control plane sits above the thing it controls.

### 8.2 Reliability requirements on every critical edge

Per v3 §37 and v1 §57, every event in the table above carries: an idempotency key, consumer-side deduplication, bounded retries, dead-letter capture, replay safety, and observability. Financial events additionally require crash-window safety — a capture that succeeds followed by an immediate process crash must never produce an invisible or unrecoverable order (v3 §38).

---

## 9. Build order

Build order follows the dependency graph, not feature appeal. Each numbered step is buildable only when every step it depends on already exists.

| Step | Scope | Maps to v3 phase |
|---|---|---|
| B-0 | Platform substrate: runtime, package manifest, lint/typecheck/build, test harness, CI | Phase 0 |
| B-1 | K-05 Configuration, K-08 Event Infrastructure — the kernel components whose only dependency is the substrate | Phase 0 |
| B-2 | K-01 Identity, K-02 Authentication, K-03 Accounts, K-04 Permissions, then K-09 Audit and K-07 Feature Flags | Phase 0 |
| B-3 | K-06 Policy Engine, K-11 Commerce Unit Registry, K-13 AI Gateway, K-15 Search Foundation, K-14 Notifications, K-12 Conversation Foundation, K-10 Ledger Foundation | Phase 0 |
| B-4 | Design system (v3 §34) | Phase 0 |
| B-5 | M-01, M-02, plus cockpit shells M-36 / M-37 / M-38 | Phase 1 |
| B-6 | M-03 Request | Phase 2 |
| B-7 | M-04 Listing, M-05 Catalog, M-18 Listing Risk | Phase 3 |
| B-8 | M-06 Search, M-07 Matching | Phase 4 |
| B-9 | M-08 Offers, M-09 RFQ, M-10 Quotes | Phase 5 |
| B-10 | M-11 Orders, M-12 Payments, M-13 Ledger, M-14 Commission | Phase 6 |
| B-11 | M-15 Settlements, M-16 Payouts, M-17 Seller Risk | Phase 7 |
| B-12 | M-19 Logistics, M-20 Returns, M-21 Disputes, M-22 Warranty | Phase 8 |
| B-13 | M-28 Rewards, M-29 Referrals, M-30 Attribution | Phase 9 |
| B-14 | M-25, M-26, M-27 risk packs | Phase 10 |
| B-15 | M-23 Accommodation | Phase 11 |
| B-16 | M-24 Services | Phase 11 |
| B-17 | M-31 Budgeting, M-32 User Intelligence | Phase 12 |
| B-18 | M-33 Seller Market Intelligence | Phase 13 |
| B-19 | M-34 Finance Provider Marketplace | Phase 14 |
| B-20 | M-39, M-40, M-41, M-42 AI control plane | Phase 15 |
| B-21 | M-35 Conversation Supervision (advanced), M-43, M-44 | Phase 16 |
| B-22 | M-45 Analytics, M-46 Admin Audit, M-47 Module Registry | Phase 16 |
| B-23 | Omnichannel channel adapters | Phase 17 |
| B-24 | Final hardening | Phase 18 |

**Build order must agree with declared dependencies.** A step may not contain a component whose declared dependencies (§3 for the kernel, §4 and §8 for modules) land in a later step. This is checkable against the tables in this document and is the first thing to verify when the build order is edited. Two specific consequences inside the kernel:

- **K-09 Audit depends on K-01 and K-04**, so it cannot precede them. It is sequenced in B-2, after the identity chain, not in B-1.
- **K-07 Feature Flags depends on K-05**, and sits in B-2. It was mapped as depending on K-03 as
  well, on the assumption that "selected accounts" meant resolving an account record. As built
  (FND-004e) it does not: a flag is evaluated at an **opaque scope handle** it never resolves, so it
  reads no account and imports nothing from K-03. That is strictly less coupling than the map
  planned, and the row above records what landed. K-05 is genuinely required, for one registered
  key — `platform.deployment.stage`, which is what v3 §36's "internal only" stage is a statement
  about.

This means audit and flags are not available to B-1. That is acceptable: B-1 delivers only K-05 Configuration and K-08 Event Infrastructure, neither of which requires an actor identity or a flag. Every component from B-2 onward has both.

**Ordering constraints that matter most:**
- B-2 before anything user-facing — no module may implement its own authorisation.
- B-3 (K-06 Policy) before B-10 — commission, hold and reserve values must be policy from the first financial line of code, never source constants (v3 §20, §35).
- B-10 before B-11 — settlement cannot precede an authoritative ledger.
- B-7 and B-18 both touch listing intelligence; M-33 reads listing data through M-04's public API only.
- M-23 Accommodation is deliberately late (B-15) *because* it must reuse identity, payments, ledger, settlement and disputes rather than fork a second platform (v3 §22). Building it early would create exactly the duplication v3 forbids.

---

## 10. Anti-cycle rules

These are the mechanical rules that make MR-2 checkable rather than aspirational.

1. **Downward-only imports.** A module's source may import from the kernel, from strictly lower layers, and from the design system. Any other import is a build failure.
2. **No upward calls, ever.** If a lower module needs a higher module to act, it emits an event. There is no exception for "just this once".
3. **No sibling calls within a layer.** Same-layer modules communicate by event. This prevents the pairwise tangles that later become cycles (for example M-20 Returns and M-21 Disputes).
4. **No shared tables.** Two modules never write the same table. Read access to another module's data goes through that module's public API, not a join.
5. **Control planes sit above their subject.** Review, risk, routing and supervision modules are always higher than what they govern, and act on it by event (§8.1).
6. **Kernel never depends on modules.** A kernel component that "needs" a business module is a mis-placed business rule; move the rule out of the kernel.
7. **Cockpits are terminal.** Nothing depends on M-36 / M-37 / M-38. They compose; they are never composed into.
8. **New module admission test.** Before a new module is added, name its layer, its owned data, and every edge. If any edge points sideways or upward, the boundary is wrong — redraw it before writing code.

---

## 11. Deterministic financial authority zone

v3 §38 and v1 §3.4 are absolute: **AI must never be the financial authority.** This map enforces that structurally rather than by convention.

**Zone membership:** K-10 Ledger Foundation, M-11 Orders, M-12 Payments, M-13 Financial Ledger, M-14 Commission Rules, M-15 Settlements, M-16 Seller Payouts, and the ledger core of M-28 Rewards.

| # | Rule |
|---|---|
| F-1 | **No AI Gateway dependency.** Zone modules may not depend on K-13. A zone module importing K-13 is a P0 defect. |
| F-2 | **No AI-sourced values.** Order totals, payment amounts, refunds, commissions, reward amounts, reserves, guarantee exposure and payout amounts are computed by deterministic code from stored inputs and versioned policy. |
| F-3 | **Policy, not constants.** The approximately 45-day standard hold, the approximately 24-hour accelerated payout, and the 50% initial security coverage target (v3 §20) are policy values read from K-06 with a version id. They must never appear as literals in source. |
| F-4 | **Version pinning.** Every financial record stores the policy version applied at the time of the transaction. Future policy changes must not rewrite historical economics (v3 §24, §35). |
| F-5 | **Append-only.** Ledger, points and audit records are append-only. Corrections are compensating entries, never mutations. |
| F-6 | **Idempotency at the boundary.** Every external payment operation carries an idempotency key; every financial event consumer deduplicates (v3 §38, §49). |
| F-7 | **Crash-window recoverability.** A crash between provider capture and local commit must be recoverable to a consistent, visible state. |
| F-8 | **AI may advise only.** AI may propose a price, flag an anomaly, or rank a quote. The proposal enters the zone as an ordinary input that a human or a deterministic rule accepts — never as an authoritative value. |
| F-9 | **Adversarial suite is a gate.** The v3 §49 financial adversarial scenarios are a release gate for every zone module, not an optional extra. |

---

## 12. AI provider neutrality

v3 §29: no business module may hardcode one AI provider.

```text
business module
    |  requests a TASK, e.g. "request.interpret", "listing.identify",
    |  "quote.rank", "risk.crosscheck" -- no provider, no model name
    v
K-13 AI GATEWAY   <== the only component that knows providers exist
    |
    +-- M-39 Model Registry       which models exist, which versions, which candidates
    +-- M-40 Task Router          task-to-model policy, thresholds, fallbacks
    +-- Provider Adapters         OpenAI . Anthropic . Google . Kimi . DeepSeek .
    |                             specialist . in-house / open-source
    +-- Evaluation & shadow mode  candidate sees the same permitted input, output logged
    |                             but not executed, promoted only after evaluation
    +-- M-41 Decision Audit       provider, model, version, prompt/policy version, task,
    |                             tools called, reference ids, confidence, latency, cost,
    |                             recommendation, human override, final outcome
    +-- M-42 Monitoring           cost, latency, error, drift, disagreement
```

| # | Rule |
|---|---|
| A-1 | Only K-13 may import a provider SDK or hold provider credentials. |
| A-2 | Modules address AI by task name; provider and model selection is a routing decision, not a code decision. |
| A-3 | Swapping or combining providers must require no change in any business module. |
| A-4 | Every AI run records the full v3 §31 decision metadata via M-41. |
| A-5 | New models enter through shadow mode; production behaviour changes only after evaluation and behind a flag (K-07). |
| A-6 | High-risk decisions support multi-model comparison; disagreement beyond the configured threshold escalates to human review (v3 §30). |
| A-7 | AI outputs entering the financial authority zone are advisory inputs only (F-8). |
| A-8 | Prompts, ranking weights, fraud rules and routing policy stay server-side and are never exposed to clients (v3 §41). |

---

## 13. Enforcement and verification

Boundary rules that are only written down get violated. Each rule below gets a mechanical check, delivered with the platform substrate in step B-0/B-1 and run in CI.

| Check | Enforces | Delivered in | State |
|---|---|---|---|
| `layer-direction` (layer and direction, plus unregistered units) | MR-1, MR-2, §10.1–10.3 | B-0 | **Enforced** — `npm run check:boundaries` |
| `kernel-purity` (kernel imports no module) | §10.6 | B-0 | **Enforced** |
| `financial-zone-ai` (zone imports no K-13) | MR-3, F-1 | B-0 | **Enforced** (P0) |
| `provider-import` (only K-13 imports provider SDKs) | MR-4, A-1 | B-0 | **Enforced** |
| Table-ownership check (one writer per table) | §10.4 | B-1 | Not built — needs a database schema to check |
| Policy-literal scan (no hardcoded rate, percentage or day constants in the zone) | F-3 | B-1 | Not built — needs policy values in source to scan |
| Contract-presence check (module has a contract doc before merge) | MR-5 | B-1 | Not built — needs module contracts to exist |
| Cycle detector over the declared dependency manifest | MR-2 | B-1 | Not built |

**Current state of enforcement: the four B-0 checks are executable; the four B-1 checks are not.**

The first four are implemented in `platform/checks/boundaries.ts`, driven by `platform/architecture/manifest.ts` — the machine-readable encoding of this document — and exposed as `npm run check:boundaries`, which exits 1 on any violation and runs inside `npm run verify`. Each has a committed planted-violation fixture under `tests/fixtures/` asserted to be rejected, because a check that cannot fail is a placeholder (v3 §54).

The remaining four wait on artefacts that do not exist yet: a database schema, policy values in source, and module contracts. Until B-1 delivers them, rules §10.4, F-3, MR-5 and cycle detection are enforced by review only. That residual gap is tracked as risk **R-02** in [CURRENT_IMPLEMENTATION_STATUS.md](./CURRENT_IMPLEMENTATION_STATUS.md#5-current-risks).

Two limits worth stating plainly. The checks read **static imports only** — runtime indirection (a service locator, dependency injection by name, or raw SQL reaching another module's table) is invisible to them. And the kernel is treated as **one layer**: its internal ordering (K-01 → K-02/K-03 → K-04) is not checked.

**When this document changes, `platform/architecture/manifest.ts` changes with it.** They are two representations of one decision; `tests/manifest.test.ts` guards the structural invariants, and an unregistered directory under `kernel/` or `modules/` fails the boundary check by design.
