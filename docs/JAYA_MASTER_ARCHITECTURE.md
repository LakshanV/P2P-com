# JAYA — Master Architecture

**Version:** 1.0  
**Authority:** This document reconciles the user's 83-module master brief with the existing Claude-built 62-unit module map. Where they conflict, this document's reconciliation table is the binding source of truth.  
**Status:** BASELINE — updated as implementation progresses  
**Last updated:** 2026-08-24

---

## 1. Purpose

JAYA is an **AI-native peer-to-peer commerce, matching, transaction, procurement and mobility operating system**. Its core function is:

> **Connect DEMAND ↔ SUPPLY ↔ PAYMENT ↔ LOGISTICS ↔ SERVICES.**

The customer proposition is:

> **Tell JAYA what you need. JAYA finds the best way to get it.**

This architecture document defines the modular structure, boundary rules, communication patterns, and build order required to deliver that proposition without creating an unmaintainable monolith or premature microservices.

---

## 2. Guiding Principles

### 2.1 Modular Monolith First

- Start as a **single deployable unit** with clearly separated domain modules.
- Each module has its own domain models, public interfaces, commands, queries, events, tests, adapters, and configuration.
- Modules must not directly manipulate another module's internal tables.
- Modules communicate through:
  1. Public service interfaces (downward calls)
  2. Defined commands
  3. Domain events (upward notification)
  4. Approved read models / projections
- Any module may later become an independent service without rewriting business logic.

### 2.2 No Shared "God Service"

Forbidden:

- `JayaService.ts`
- Giant services spanning unrelated domains
- Service files that require reading the whole application to understand

### 2.3 Domain Event Bus

Every major state change emits an event. Initial transport is in-process via the modular monolith. Design it so the transport can later move to Redis, Kafka, NATS, or a cloud event bus without changing domain logic.

Use an **Outbox Pattern** for important transactional events.

Representative events:

```text
NeedCreated
NeedInterpreted
MatchFound
RFQCreated
QuoteSubmitted
QuoteAccepted
OrderCreated
PaymentRequested
PaymentCaptured
PaymentFailed
InventoryReserved
InventoryReleased
ShipmentCreated
DriverAssigned
DeliveryCompleted
DisputeOpened
CommissionAccrued
SettlementCompleted
RewardIssued
```

### 2.4 Adapter / Port Architecture

Every external dependency lives behind an interface. Examples:

```text
PaymentProvider
 ├── StripeAdapter
 ├── BankTransferAdapter
 ├── LocalPaymentAdapter
 └── MockPaymentAdapter

AIProvider
MapsProvider
MessagingProvider
CryptoProvider
SearchProvider
ObjectStorageProvider
NotificationProvider
LogisticsProvider
IdentityProvider
```

External SDK calls must not spread throughout the application.

### 2.5 AI Safety

LLM output must **never directly alter**:

- financial ledger
- settlement
- irreversible payment
- account permissions
- regulatory status

AI proposes structured commands. Deterministic application code validates and executes.

### 2.6 Deterministic Financial Authority Zone

The following modules may **never** depend on the AI Gateway, and no AI output may be the source of a monetary value, financial state transition, or authorisation decision:

- K-10 Ledger Foundation
- M-11 Orders
- M-12 Payments
- M-13 Financial Ledger
- M-14 Commission Rules
- M-15 Settlements
- M-16 Seller Payouts
- M-28 Rewards (ledger core)

Every financial record stores the policy version applied at the time of transaction.

### 2.7 Database Ownership

Every module conceptually owns its tables. Enforce ownership through repository architecture if separate schemas are impractical. No module may directly write another module's private tables.

Example namespaces:

```text
identity.*
accounts.*
permissions.*
payments.*
ledger.*
orders.*
inventory.*
rfq.*
catalogue.*
```

### 2.8 Versioned Public Contracts

Important module interfaces are versioned:

```text
InventoryServiceV1
PaymentServiceV1
MatchServiceV1
```

This allows V2 implementations later while preserving compatibility.

### 2.9 Feature Flags

Every experimental or advanced capability is feature-flagged:

- AI auto-RFQ
- automated procurement
- predictive shopping
- browser memory
- wearable capture
- crypto
- community credits
- living-cost adviser
- AI dispatch
- pooled buying

---

## 3. Architectural Layers

```text
┌─────────────────────────────────────────────────────────────┐
│  CLIENT CHANNELS                                            │
│  Web · Mobile · WhatsApp · Voice · Browser Extension ·      │
│  Wearables · Partner APIs                                   │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  API / CHANNEL GATEWAY                                      │
│  authn · rate limit · scoping · audit · request routing     │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  COCKPITS & INTELLIGENCE (L8)                               │
│  Universal Cockpit · Merchant Cockpit · Ops Cockpit ·       │
│  AI Advisers · Budgeting · Demand Intelligence · Analytics  │
└────────────────────┬────────────────────────────────────────┘
                     │ events upward / queries downward
┌────────────────────▼────────────────────────────────────────┐
│  VERTICALS, INCENTIVES & RESOLUTION (L7–L8)                 │
│  Services · Accommodation · Risk Packs · Rewards · Referrals  │
│  Disputes · Warranty · Returns · Community                  │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  FULFILMENT & LOGISTICS (L6–L7)                             │
│  Logistics · Driver Network · Vehicle Network · Dispatch ·  │
│  Route Optimisation · Location · Yaanadiri Connector        │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  SETTLEMENT, PAYOUT & RISK (L5–L6)                          │
│  Settlements · Seller Payouts · Seller Risk · Listing Risk  │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  FINANCIAL CORE — Deterministic Authority Zone (L5)         │
│  Orders · Payments · Financial Ledger · Commission Rules     │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  NEGOTIATION (L4)                                           │
│  Offers · RFQ / Tender · Quotes · Offer Scoring             │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  DISCOVERY (L3)                                             │
│  Search · Matching · Visual Search                          │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  COMMERCE PRIMITIVES (L2)                                 │
│  Need / Request · Product Catalogue · Universal Listing ·   │
│  Inventory Interface · Supply Offers                        │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  ACCOUNT & CAPABILITY (L1)                                  │
│  Universal Account · Capability & Verification ·              │
│  Supplier Network · Member Network · Merchant               │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  COMMERCE KERNEL (L0)                                       │
│  Identity · Authentication · Accounts · Permissions ·       │
│  Policy Engine · Feature Flags · Event Infrastructure ·      │
│  Audit Foundation · Ledger Foundation · Conversation ·       │
│  AI Gateway · Notifications · Search Foundation ·            │
│  Commerce Unit Registry                                    │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  PLATFORM SUBSTRATE                                         │
│  Runtime · Database · Migrations · Fixtures · Boundary     │
│  Checks · Object Storage · Queue · Logging · Test Harness   │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Module Reconciliation: 83-Module Brief ↔ Existing 62-Unit Map

The user's brief names 83 modules (01–83). The existing codebase uses a 62-unit map (15 kernel components K-01–K-15, 47 business modules M-01–M-47). The table below reconciles them.

| Brief # | Brief Name | Existing ID | Existing Name | Layer | Status |
|---|---|---|---|---|---|
| 01 | Identity | K-01 | Identity | L0 kernel | Foundation implemented |
| 02 | Organisations | K-03 | Accounts | L0 kernel | Foundation implemented; expand to org support |
| 03 | Roles & Permissions | K-04 | Permissions | L0 kernel | Foundation implemented |
| 04 | User Profile | M-01 / M-02 | Universal Account / Capability | L1 | Not started |
| 05 | Universal JAYA Cockpit | M-36 | User Cockpit | L8 | Not started |
| 06 | Cockpit Read-Model Engine | M-36 internals + projection layer |  | L8 | Not started |
| 07 | Conversations | K-12 | Conversation Foundation | L0 kernel | Not started |
| 08 | Messaging Content | K-12 | Conversation Foundation | L0 kernel | Not started |
| 09 | Need Engine | M-03 | Request / Item Commerce Request | L2 | Not started |
| 10 | Multimodal Understanding | K-13 | AI Gateway + M-40 AI Routing | L0/L8 | Not started |
| 11 | Visual Search | M-06 / M-07 | Search & Discovery + Matching | L3 | Not started |
| 12 | Product Catalogue | M-05 | Product Catalog | L2 | Not started |
| 13 | Search | M-06 / K-15 | Search & Discovery + Search Foundation | L3 | Not started |
| 14 | Match Engine | M-07 | Matching | L3 | Not started |
| 15 | Supply Offer | M-04 / M-08 | Universal Listing + Offers | L2/L4 | Not started |
| 16 | Sourcing Orchestrator | M-09 + orchestration logic | RFQ + sourcing ladder | L4 | Not started |
| 17 | RFQ / Tender Engine | M-09 | RFQ / Reverse Marketplace | L4 | Not started |
| 18 | Quotes & Offers | M-10 | Quotes | L4 | Not started |
| 19 | Offer Scoring | M-10 internals / K-13 | Quote evaluation | L4 | Not started |
| 20 | Orders | M-11 | Orders | L5 | Not started |
| 21 | Split Fulfilment | M-11 / M-10 | Orders + Quotes split logic | L5 | Not started |
| 22 | Inventory | M-04 / M-05 | Listing + Catalog inventory interface | L2 | Not started |
| 23 | Inventory Policy | M-04 / M-11 | Listing / Orders policy layer | L2/L5 | Not started |
| 24 | Virtual Inventory Graph | M-04 | Universal Listing network view | L2 | Not started |
| 25 | Merchant | M-37 / M-33 | Seller Cockpit + Seller Intel | L8 | Not started |
| 26 | Merchant Dashboard | M-37 | Seller Cockpit | L8 | Not started |
| 27 | Merchant AI Adviser | M-33 | Seller Market Intelligence | L8 | Not started |
| 28 | Supplier Network | M-02 / M-04 | Capability & Verification + Listing | L1/L2 | Not started |
| 29 | Member / Break-Bulk Network | M-02 / M-19 | Capability + Logistics | L1/L6 | Not started |
| 30 | Demand Intelligence | M-33 / M-45 | Seller Intel + Analytics | L8 | Not started |
| 31 | Demand Clouds | M-45 | Analytics (aggregated) | L8 | Not started |
| 32 | Predicted Needs | M-32 / M-33 | User Intelligence + Seller Intel | L8 | Not started |
| 33 | Demand Pooling | M-03 / M-07 | Request + Matching | L2/L3 | Not started |
| 34 | Procurement | M-09 / M-34 | RFQ + Finance Provider Marketplace | L4/L8 | Not started |
| 35 | Wholesale Exchange | M-09 / M-11 / M-34 | RFQ + Orders + Finance Providers | L4/L5/L8 | Not started |
| 36 | Singha Connector | Integration adapter under Procurement/Wholesale |  | L8 adapter | Not started |
| 37 | Logistics | M-19 | Logistics | L6 | Not started |
| 38 | Driver Network | M-19 internals | Logistics drivers | L6 | Not started |
| 39 | Vehicle Network | M-19 internals | Logistics vehicles | L6 | Not started |
| 40 | Yaanadiri Connector | Logistics provider adapter |  | L6 adapter | Not started |
| 41 | Dispatch Engine | M-19 internals / M-40 | Logistics dispatch + AI Routing | L6 | Not started |
| 42 | Route Optimisation | M-19 internals | Logistics routing | L6 | Not started |
| 43 | Location | Platform substrate + M-19 | Geospatial service | substrate/L6 | Not started |
| 44 | Payment Orchestration | M-12 | Payments | L5 | Not started |
| 45 | Payment Provider Adapters | M-12 adapters |  | L5 adapters | Not started |
| 46 | Digital Asset / Crypto Adapter | M-12 adapter + M-34 | Payment + Finance Provider | L5/L8 | Not started |
| 47 | Universal Value Ledger | M-13 + K-10 | Financial Ledger + Ledger Foundation | L5 | Not started |
| 48 | Asset Type Registry | M-13 / K-11 | Ledger + Commerce Unit Registry | L5/L0 | Not started |
| 49 | Double-Entry Ledger | K-10 + M-13 | Ledger Foundation + Financial Ledger | L5 | Not started |
| 50 | Balances | M-13 / M-28 | Financial Ledger + Rewards | L5/L8 | Not started |
| 51 | Value Router | M-12 / M-13 / M-28 | Payments + Ledger + Rewards | L5/L8 | Not started |
| 52 | Valuation Engine | M-13 / M-34 | Financial Ledger + Finance Provider | L5 | Not started |
| 53 | Commissions | M-14 | Commission Rules | L5 | Not started |
| 54 | Referral / Introducer | M-29 | Referrals | L8 | Not started |
| 55 | Introducer Dashboard | M-29 / M-37 | Referrals + Seller Cockpit | L8 | Not started |
| 56 | Rewards | M-28 | Rewards | L8 | Not started |
| 57 | Marketplace Reputation | M-17 / M-18 / M-33 | Seller Risk + Listing Risk + Intel | L6/L8 | Not started |
| 58 | Financial Cockpit | M-36 / M-37 / M-13 | Cockpit + Ledger | L8 | Not started |
| 59 | Life Budget | M-31 | Budgeting | L8 | Not started |
| 60 | Safe-to-Spend | M-31 | Budgeting | L8 | Not started |
| 61 | Cashflow Forecast | M-31 / M-32 | Budgeting + User Intelligence | L8 | Not started |
| 62 | Financial Wellbeing | M-31 / M-32 | Budgeting + User Intelligence | L8 | Not started |
| 63 | Living Cost / Living Wage Adviser | M-31 / M-32 | Budgeting + User Intelligence | L8 | Not started |
| 64 | Opportunity Engine | M-32 / M-33 | User Intelligence + Seller Intel | L8 | Not started |
| 65 | Services | M-24 | Services | L8 | Not started |
| 66 | Associated Services | M-24 internals | Services | L8 | Not started |
| 67 | Notifications | K-14 | Notifications | L0 kernel | Not started |
| 68 | Consent & Privacy | M-32 / K-09 | User Intelligence + Audit Foundation | L8/L0 | Not started |
| 69 | Browser Assistant | Channel adapter / M-03 | Need ingestion | L2 | Not started |
| 70 | Wearable / AI Glasses Gateway | Channel adapter / M-03 | Need ingestion | L2 | Not started |
| 71 | AI Gateway | K-13 | AI Gateway | L0 kernel | Not started |
| 72 | AI Router | M-40 | AI Routing / Control Plane | L8 | Not started |
| 73 | JAYA AI Orchestrator | M-73 | Specialist agent orchestration | L8 | Not started |
| 74 | Specialist AI Agents | M-73 / K-13 | Agent definitions | L8 | Not started |
| 75 | AI Action Policy | M-41 / K-13 | AI Decision Audit + Gateway | L8/L0 | Not started |
| 76 | Risk | M-17 / M-18 | Seller Risk + Listing Risk | L6 | Not started |
| 77 | Disputes | M-21 | Disputes | L7 | Not started |
| 78 | Quality | M-22 | Warranty / Buyer Protection | L7 | Not started |
| 79 | Audit | K-09 | Audit Foundation | L0 kernel | Foundation implemented |
| 80 | Analytics | M-45 | Analytics / Platform Intelligence | L8 | Not started |
| 81 | Internal JAYA Control Tower | M-38 | Operations Cockpit | L8 | Not started |
| 82 | Internal AI Operations Manager | M-38 / M-41 / K-13 | Ops Cockpit + AI Decision Audit | L8 | Not started |
| 83 | Feature Flags | K-07 | Feature Flags | L0 kernel | Foundation implemented |

---

## 5. Communication Patterns

### 5.1 Downward Calls

A higher-layer module may call a lower-layer module's public API:

```text
M-11 Orders -> M-12 Payments.createPaymentIntent()
M-11 Orders -> M-04 Listing.getAvailability()
M-06 Search -> K-15 Search Foundation.query()
```

### 5.2 Upward Events

A lower-layer module emits events; higher layers subscribe:

```text
PaymentModule
      │
      │ emits PaymentCaptured
      ▼
      ├── OrderModule reacts
      ├── LedgerModule reacts
      ├── NotificationModule reacts
      └── FulfilmentModule reacts
```

### 5.3 Read Models

Cockpits and analytics consume read models built from events. The Cockpit Read-Model Engine owns projections such as:

- financial summary
- active orders
- income
- due payments
- needs
- expected deliveries
- commissions
- recommendations

---

## 6. Build Order

Phases align with the user brief, mapped to existing build steps.

| Phase | User Brief Phase | Scope | Existing Build Step |
|---|---|---|---|
| 0 | Existing project audit | Audit, docs, foundation verification | B-0 complete |
| 1 | Modular foundation | Event bus outbox, adapter interfaces, DI, feature flags | B-0/B-1 complete; wire events/audit |
| 2 | Identity + cockpit shell | Identity, roles, orgs, conversations, adaptive cockpit shell | B-2 partial; complete K-12, M-01, M-02, M-36 shell |
| 3 | Need + catalogue + search | First end-to-end request creation | B-3 partial; K-15, M-03, M-05 |
| 4 | Supply + matching | Merchants, suppliers, inventory interface, supply offers, match engine | M-04, M-07, M-28 Supplier Network |
| 5 | Sourcing + RFQ | Sourcing ladder | M-09, M-10 |
| 6 | Order engine | Orders and split fulfilment | M-11 |
| 7 | Payment + multi-value ledger | Payment API, adapters, ledger, asset registry, balances, commissions | K-10, M-12, M-13, M-14 |
| 8 | Universal financial cockpit | Balances, spending, income, receivables, settlements | M-36/M-37 financial views |
| 9 | Introducer / rewards | Referrals, attribution, rewards | M-29, M-30, M-28 |
| 10 | Logistics / Yaanadiri | Modular mobility | K-14, M-19, Yaanadiri adapter |
| 11 | Merchant + supplier intelligence | Dashboards and AI advisers | M-33, M-37 |
| 12 | Member / break-bulk | Local distribution network | M-02/M-19 |
| 13 | Demand clouds + procurement | Predictions and wholesale intelligence | M-33, M-34, M-45 |
| 14 | Multimodal AI | Images, voice, links, documents | K-13 mature adapters |
| 15 | Services | Secondary services marketplace | M-24 |
| 16 | Life / financial wellbeing | Budget, safe-to-spend, cashflow, goals | M-31, M-32 |
| 17 | Contextual commerce | Browser assistant, location, wearables | Channel adapters |
| 18 | Control tower | Internal AI operations management | M-38, M-41 |
| 19 | Advanced autonomy | AI authority behind policy controls | M-41, M-75 |
| 20 | Hardening | Security, performance, failure recovery, load tests, accessibility, observability, deployment | B-24 |

---

## 7. Changeability Test

Periodically ask:

> *Could we replace this module without rewriting unrelated JAYA modules?*

If any of these answers become "no", refactor the boundary before continuing:

- Replace Inventory → must not rebuild payments, profiles, RFQ, chat, rewards.
- Replace Payments → must not rebuild catalogue, inventory, merchant AI, logistics.
- Replace AI Provider → must not rewrite business logic.
- Replace Dispatch Algorithm → must not redesign Orders.

---

## 8. Security, Privacy, Performance

### 8.1 Security

- Least privilege
- RBAC + object-level permissions
- Rate limits
- MFA-ready architecture
- Webhook signatures
- Idempotency
- Secure uploads
- Secrets management
- CSRF protection where applicable
- XSS protection
- SQL injection protection (parameterised queries only)
- Audit logs
- Private object storage
- PII protection

### 8.2 Privacy

- Granular consent
- Data deletion
- Data export
- Retention rules
- Browser/wearable/location/recommendation permissions
- Aggregation before supplier-facing data

### 8.3 Performance and Cost

- Cache deterministic results
- Use inexpensive models for routine classification
- Batch AI calls
- Use expensive models only when value justifies cost
- Track AI cost per task / user / workflow / module

---

## 9. Deployment Target

Development must provide:

- repeatable environment setup
- staging configuration
- production configuration
- migrations
- seed/demo data
- monitoring
- backups
- health checks

Do not make production deployment dependent on a developer's personal machine.

---

## 10. Document Map

| Document | Purpose |
|---|---|
| `JAYA_MASTER_ARCHITECTURE.md` | This file — high-level architecture and reconciliation |
| `JAYA_MODULE_MAP.md` | Detailed module inventory and dependency graph |
| `JAYA_AUTONOMOUS_STATUS.md` | Current phase, completed/in-progress modules, blockers |
| `JAYA_DECISION_LOG.md` | Architectural and product decisions |
| `JAYA_INTEGRATION_REGISTRY.md` | External integrations, adapters, mock providers |
| `JAYA_TEST_MATRIX.md` | Scenarios and contract tests |
| `JAYA_MIGRATION_PLAN.md` | Migration of existing components into modules |
| `JAYA_EXISTING_SYSTEM_AUDIT.md` | Audit of Claude's existing work |

---

## 11. References

- `.conductor/brief/JAYA_MASTER_AUTONOMOUS_DEV_GUIDE_v3.md`
- `.conductor/brief/JAYA___Autonomous_Build_Master_Development_Guide___Completion_Checklist_v1.0.md`
- `docs/CURRENT_IMPLEMENTATION_STATUS.md`
- `docs/MASTER_IMPLEMENTATION_CHECKLIST.md`
- `docs/MODULE_MAP.md`
- `platform/architecture/manifest.ts`
