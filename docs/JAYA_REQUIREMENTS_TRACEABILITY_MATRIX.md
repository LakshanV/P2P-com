# JAYA — Requirements Traceability Matrix

**Produced:** 2026-09-01. **Against:** commit `6a129c3`.  
**Method:** every row was checked against the repository as it stands. Nothing here is taken from a
README, a contract, a checklist or an earlier claim. Where a row says a test proves something, that
test file exists and passes; where it says nothing implements something, the directory is empty or
absent.

---

## 0. How to read this

**A note on columns.** The requested column set was seventeen wide. A seventeen-column Markdown table
is not readable, and an unreadable audit is not an audit. `Original Intent` is folded into
`Requirement` where the two would say the same thing, and `Notes` appears only where it adds
something the other columns do not. Everything else is present. If a column is genuinely wanted
separately, say so and it will be split out.

### Status vocabulary

| Status | Means |
|---|---|
| `NOT STARTED` | No file implements it. The directory is empty or absent. |
| `ARCHITECTURE ONLY` | Named in the manifest or MODULE_MAP. No types, no code. |
| `CONTRACT ONLY` | Types and a written contract exist. No behaviour. |
| `PARTIAL` | Some of the requirement works and is tested; a named part does not exist. |
| `IMPLEMENTATION COMPLETE` | The behaviour exists in code. Says nothing about tests. |
| `TESTED` | Unit tests exist **and pass**. |
| `INTEGRATION TESTED` | Proven against live PostgreSQL. |
| `E2E VERIFIED` | A user journey proven end to end through the real surface. **Nothing in this repository holds this status.** |
| `UI-READY` | A screen could be built on it. Backend shape settled, API served. |
| `PRODUCTION-READY` | Could be deployed and used by a real person. **Nothing holds this status.** |
| `EXTERNALLY BLOCKED` | Cannot progress without a credential or a decision the platform cannot make for itself. |

### The proof rule, applied

A row is only marked `TESTED` if a named test file exists and the suite passes. `INTEGRATION TESTED`
additionally requires a `tests/integration/*.integration.ts` that ran against a real server.

**No row is marked `E2E VERIFIED`.** There is no end-to-end harness in this repository: no
`tests/e2e/`, no browser driver, no user-journey test. `tests/integration/api.integration.ts` drives
the real HTTP surface over a real socket against a real database, which is the closest thing that
exists — and it is an API test, not a journey. Calling it E2E would be exactly the inflation this
audit is for.

### Evidence base

- 97 unit test files, **1,989 tests, all passing**.
- 27 integration suites, **42 tests against live PostgreSQL 16.10**.
- 0 E2E tests. 0 UI files. `design-system/` contains one README.
- 94 migration files (47 forward, 47 rollback).
- Gates green: `typecheck`, `lint`, `format:check`, `check:boundaries` (259 files, 1,030 imports, 0
  violations), `check:migrations`, `check:fixtures`.

### A correction to the premise

The instruction was to continue M-12 Payments alongside this audit. **M-12 was completed before this
audit began** — `IMPLEMENTATION COMPLETE / TESTED / INTEGRATION TESTED` at commit `dbe828d`, with 59
unit tests, 12 provider-contract tests and 11 live-PostgreSQL tests. So are M-13, the outbox relay
worker, the HTTP API and M-36. There was no in-flight payments work to run in parallel with. The
audit is therefore the current work, and §14 is what follows it.

---

## A. Universal JAYA experience

| ID | Requirement | Owning Module | Implementation | Persistence | API | UI | Unit Tests | Integration | E2E | Status | % | Missing Work | Priority | Blocks Deploy? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A-01 | Conversation-first interaction | K-12 Conversation Foundation | `kernel/conversation-foundation/` | migration 0018 | — | — | `tests/conversation-foundation.test.ts` | `conversation-foundation.integration.ts` | — | `PARTIAL` | 20% | Nothing creates a conversation. No message routing, no AI turn, no surface | P1 | No |
| A-02 | Telegram-like mental model, not a visual clone | — | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Whole interaction model | P1 | No |
| A-03 | Universal cockpit | M-36 | `modules/user-cockpit/` | none by design | 3 routes | — | `tests/user-cockpit.test.ts` (15) | — | — | `PARTIAL` | 12% | 5 of 8 sections absent (§V) | P1 | No |
| A-04 | Role-adaptive cockpit | M-36 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Cockpit does not know what role is viewing | P1 | No |
| A-05 | One account, many roles | M-01 | `modules/universal-account/` | migration 0024 | — | — | `tests/universal-account.test.ts` | `universal-account.integration.ts` | — | `INTEGRATION TESTED` | 70% | Capability vocabulary exists and is enforced; **nothing calls it**, no API | P0 | No |
| A-06 | Customer role | M-01 | capability vocabulary | 0024 | — | — | ✓ | ✓ | — | `PARTIAL` | 25% | Role exists as a value; no customer behaviour anywhere | P0 | No |
| A-07 | Merchant role | M-01 | capability vocabulary | 0024 | — | — | ✓ | ✓ | — | `PARTIAL` | 10% | §N entirely absent | P1 | No |
| A-08 | Supplier role | M-01 | capability vocabulary | 0024 | — | — | ✓ | ✓ | — | `PARTIAL` | 10% | §O entirely absent | P1 | No |
| A-09 | Member role | M-01 | capability vocabulary | 0024 | — | — | ✓ | ✓ | — | `PARTIAL` | 10% | §P entirely absent | P2 | No |
| A-10 | Introducer role | M-01 | capability vocabulary | 0024 | — | — | ✓ | ✓ | — | `PARTIAL` | 10% | §M entirely absent | P2 | No |
| A-11 | Driver role | M-01 | capability vocabulary | 0024 | — | — | ✓ | ✓ | — | `PARTIAL` | 5% | §R entirely absent | P2 | No |
| A-12 | Business buyer role | M-01 | capability vocabulary | 0024 | — | — | ✓ | ✓ | — | `PARTIAL` | 10% | No organisation model, no B2B terms | P2 | No |
| A-13 | Internal operations user | M-38 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | §AE entirely absent | P1 | No |

---

## B. Need / intent engine

**Owning module M-03 (Item / Commerce Request) is registered in the manifest and contains no code.**
The entire section is unbuilt.

| ID | Requirement | Owning Module | Implementation | Persistence | API | UI | Unit Tests | Integration | E2E | Status | % | Missing Work | Priority | Blocks Deploy? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B-01 | Free-text Need | M-03 | none | none | — | — | — | — | — | `ARCHITECTURE ONLY` | 0% | The whole module | **P0** | No |
| B-02 | Voice Need (architecture) | M-03 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Ingestion port, transcription adapter | P2 | No |
| B-03 | Image Need | M-03 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Upload, storage, reference | **P0** | No |
| B-04 | Screenshot Need | M-03 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | As B-03 plus OCR path | P1 | No |
| B-05 | Video Need (architecture) | M-03 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Ingestion port only | P3 | No |
| B-06 | Barcode / QR | M-03 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Decoder, catalogue lookup | P2 | No |
| B-07 | URL / product-link ingestion | M-03 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Fetch, parse, extract | P2 | No |
| B-08 | Document / specification ingestion | M-03 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Parser, extraction | P2 | No |
| B-09 | GPS / location-aware Need | M-03 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Location model, consent (§AB) | P1 | No |
| B-10 | Browser assistant | — | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Extension, auth bridge | P3 | No |
| B-11 | Wearable / AI glasses ingestion | — | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Milestone 3 | P3 | No |
| B-12 | Original input preserved verbatim | M-03 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Append-only raw-input store | **P0** | No |
| B-13 | AI structured interpretation | M-03 + K-13 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Need Agent (§AA), live model adapter | **P0** | No |
| B-14 | Interpretation confidence | M-03 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Score, threshold, escalation | P1 | No |
| B-15 | User correction of interpretation | M-03 | none | — | — | — | — | — | — | `NOT STARTED` | 0% | Correction record, feedback loop | P1 | No |

---

## C. Visual product identification

Every row: **`NOT STARTED`, 0%.** No file in the repository performs OCR, extracts a part number,
computes an embedding, or scores a visual match. Owning module would be M-03/M-07; neither has code.

| ID | Requirement | Status | Missing Work | Priority |
|---|---|---|---|---|
| C-01 | OCR | `NOT STARTED` | Provider port, adapter, storage of extracted text | **P0** |
| C-02 | Visible brand / model extraction | `NOT STARTED` | Vision model call, structured output | **P0** |
| C-03 | Part number extraction | `NOT STARTED` | Pattern library, confidence | P1 |
| C-04 | Visual embeddings | `NOT STARTED` | Embedding provider, vector storage (**no pgvector**) | **P0** |
| C-05 | Catalogue similarity | `NOT STARTED` | Requires C-04 and a catalogue (§D) | **P0** |
| C-06 | Historical similarity | `NOT STARTED` | Requires C-04 plus Need history | P1 |
| C-07 | Substitute identification | `NOT STARTED` | Equivalence model | P1 |
| C-08 | Confidence scoring | `NOT STARTED` | — | P1 |
| C-09 | Correction feedback | `NOT STARTED` | Feedback store, retraining path | P2 |

---

## D. Product / catalogue / search

| ID | Requirement | Owning Module | Implementation | Persistence | API | Tests | Integration | Status | % | Missing Work | Priority |
|---|---|---|---|---|---|---|---|---|---|---|---|
| D-01 | Catalogue | M-05 | none | — | — | — | — | `ARCHITECTURE ONLY` | 0% | The whole module | **P0** |
| D-02 | Listing (a seller's offer) | M-04 | `modules/universal-listing/` | 0026, 0027 | — | `universal-listing.test.ts` | `universal-listing.integration.ts` | `INTEGRATION TESTED` | 65% | Versioned, immutable, media, declarations. **No API, no caller** | **P0** |
| D-03 | SKU / variant | M-05 | none | — | — | — | — | `NOT STARTED` | 0% | — | P1 |
| D-04 | Category | M-05 | none | — | — | — | — | `NOT STARTED` | 0% | Taxonomy, assignment | **P0** |
| D-05 | Brand | M-05 | none | — | — | — | — | `NOT STARTED` | 0% | — | P1 |
| D-06 | Keyword search | K-15 | `kernel/search-foundation/` | 0021 (`tsv` tsvector) | — | `search-foundation.test.ts` | `search-foundation.integration.ts` | `INTEGRATION TESTED` | 60% | Works. **Nothing indexes anything into it** | **P0** |
| D-07 | Structured search | K-15/M-06 | none | — | — | — | — | `NOT STARTED` | 0% | Facets, filters | P1 |
| D-08 | Semantic search | M-06 | none | — | — | — | — | `NOT STARTED` | 0% | Embeddings, vector index | P1 |
| D-09 | Visual search | M-06 | none | — | — | — | — | `NOT STARTED` | 0% | Requires §C | P1 |
| D-10 | Supplier search | M-06 | none | — | — | — | — | `NOT STARTED` | 0% | Requires §O | P1 |
| D-11 | Hybrid ranking | M-06 | none | — | — | — | — | `NOT STARTED` | 0% | Ranking model, explainability | P1 |

---

## E. Matching / sourcing

Owning module M-07 Matching is registered and empty. **Every row `NOT STARTED`, 0%.**

| ID | Requirement | Status | Missing Work | Priority |
|---|---|---|---|---|
| E-01 | Need → existing stock | `NOT STARTED` | M-07; would consume M-04 inventory, which exists | **P0** |
| E-02 | Need → probable supplier | `NOT STARTED` | Supplier model (§O) | **P0** |
| E-03 | Need → verified supplier network | `NOT STARTED` | Verification (M-02 exists) plus supplier model | P1 |
| E-04 | External supplier discovery | `NOT STARTED` | — | P2 |
| E-05 | Supplier lead acquisition | `NOT STARTED` | — | P2 |
| E-06 | Strict sourcing ladder | `NOT STARTED` | The ordering rule itself, and its policy version | **P0** |
| E-07 | No unnecessary public RFQ | `NOT STARTED` | Consequence of E-06 | **P0** |
| E-08 | Explainable Match Score | `NOT STARTED` | Score, and the reasons behind it | P1 |

---

## F. Reverse marketplace

| ID | Requirement | Owning Module | Status | % | Missing Work | Priority |
|---|---|---|---|---|---|---|
| F-01 | SupplyOffer | M-08 Offers | `ARCHITECTURE ONLY` | 0% | The whole module | P1 |
| F-02 | Supplier declares available stock | M-08 | `NOT STARTED` | 0% | — | P1 |
| F-03 | AI matches SupplyOffers to Needs | M-07 + K-13 | `NOT STARTED` | 0% | Requires §B, §E | P1 |
| F-04 | Demand marketplace | M-09 | `NOT STARTED` | 0% | — | P1 |
| F-05 | Supply marketplace | M-08 | `NOT STARTED` | 0% | — | P1 |

---

## G. RFQ / tender engine

Owning modules M-09 (RFQ / Reverse Marketplace) and M-10 (Quotes) are registered and empty.
**Every row `NOT STARTED`, 0%.** This is the largest single unbuilt area of the original vision.

| ID | Requirement | Status | Priority | Notes |
|---|---|---|---|---|
| G-01 | Private RFQ | `NOT STARTED` | **P0** | Milestone 1 spine |
| G-02 | Category supplier RFQ | `NOT STARTED` | P1 | Needs §D-04 |
| G-03 | Public verified-network RFQ | `NOT STARTED` | P1 | Needs M-02 verification, which exists |
| G-04 | Supplier clarification | `NOT STARTED` | P1 | Needs K-12, which exists |
| G-05 | Full bid | `NOT STARTED` | **P0** | |
| G-06 | Partial bid | `NOT STARTED` | **P0** | Feeds M-11 split fulfilment, which exists |
| G-07 | Alternative offer | `NOT STARTED` | P1 | |
| G-08 | Deadline / closing | `NOT STARTED` | **P0** | Needs a scheduler; none exists |
| G-09 | Attachments / evidence | `NOT STARTED` | P1 | Needs object storage; none exists |
| G-10 | Ranking | `NOT STARTED` | P1 | |
| G-11 | Award | `NOT STARTED` | **P0** | |
| G-12 | Conversion to order | `NOT STARTED` | **P0** | M-11 is ready to receive this |

---

## H. Orders — the strongest area

| ID | Requirement | Implementation | Persistence | API | Unit Tests | Integration | Status | % | Notes |
|---|---|---|---|---|---|---|---|---|---|
| H-01 | Standard order | `modules/orders/service.ts` | 0028 | `POST /v1/orders` | `tests/orders.test.ts` (26) | `orders.integration.ts` (8) | `INTEGRATION TESTED` | 90% | |
| H-02 | Quote → order | none | — | — | — | — | `NOT STARTED` | 0% | Blocked on §G |
| H-03 | State machine | `ORDER_TRANSITIONS` table | CHECK constraints | 5 transition routes | ✓ | ✓ | `INTEGRATION TESTED` | 95% | Declared table, not scattered conditionals |
| H-04 | Cancellation | `cancelOrder` | `order_header_cancelled_at_matches_status` | `POST …/cancellation` | ✓ | ✓ | `INTEGRATION TESTED` | 95% | |
| H-05 | Cancellation reason | `CANCELLATION_REASONS` | CHECK | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 100% | Vocabulary **and** free text; a defect found in review |
| H-06 | Parent / child orders | migration 0029 | `fulfilment_role`, `parent_order_id` | `POST …/split` | `orders-split-fulfilment.test.ts` (16) | `orders-split-fulfilment.integration.ts` (6) | `INTEGRATION TESTED` | 90% | |
| H-07 | Split supplier fulfilment | `splitOrder` | 0029 | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 90% | `allocation-mismatch` refuses any split that does not sum |
| H-08 | Partial fulfilment | `getFulfilmentSummary` | derived | `GET …/fulfilment` | ✓ | ✓ | `INTEGRATION TESTED` | 90% | **Derived quantity, not a status** — nothing stores a ratio that drifts |
| H-09 | Child failure | `nothing-fulfilled` refusal | — | ✓ | ✓ | ✓ | `TESTED` | 85% | An order where nothing arrived is cancelled, not completed |
| H-10 | Concurrent split protection | `updateOrderIfRole` | conditional `UPDATE` | — | ✓ | ✓ | `INTEGRATION TESTED` | 95% | Found by test: both splits used to succeed |
| H-11 | Idempotency | `orderEquals` + key | `UNIQUE (idempotency_key)` | `Idempotency-Key` required | ✓ | `api.integration.ts` | `INTEGRATION TESTED` | 90% | Defect found by live test: instant and correlation id were compared, so every real retry conflicted |
| H-12 | PostgreSQL persistence | `postgres-repository.ts` | 0028, 0029 | — | — | ✓ | `INTEGRATION TESTED` | 100% | |

**Not complete:** no inventory reservation is actually taken from M-04 when an order is placed; no
authorisation; no consumer of the seven order events.

---

## I. Inventory

| ID | Requirement | Implementation | Persistence | API | Tests | Integration | Status | % | Missing |
|---|---|---|---|---|---|---|---|---|---|
| I-01 | Public Inventory contract | `tests/contracts/inventory.contract.test.ts` | — | — | ✓ parameterised | — | `TESTED` | 90% | |
| I-02 | Availability | `getAvailability` | 0027 snapshot | — | ✓ | `universal-listing-inventory.integration.ts` | `INTEGRATION TESTED` | 85% | No API route |
| I-03 | Reserve | `reserveInventory` | movement + snapshot | — | ✓ | ✓ | `INTEGRATION TESTED` | 85% | Not called by M-11 |
| I-04 | Release | `releaseInventory` | ✓ | — | ✓ | ✓ | `INTEGRATION TESTED` | 85% | |
| I-05 | Commit | `commitInventory` | ✓ | — | ✓ | ✓ | `INTEGRATION TESTED` | 85% | |
| I-06 | Receive | `receiveInventory` | ✓ | — | ✓ | ✓ | `INTEGRATION TESTED` | 85% | |
| I-07 | Adjust | `adjustInventory` | ✓ | — | ✓ | ✓ | `INTEGRATION TESTED` | 85% | |
| I-08 | Transfer | none | — | — | — | — | `NOT STARTED` | 0% | Between locations |
| I-09 | Distributed inventory | none | — | — | — | — | `NOT STARTED` | 0% | No location model |
| I-10 | Virtual inventory graph | none | — | — | — | — | `NOT STARTED` | 0% | |
| I-11 | Lots / batches | none | — | — | — | — | `NOT STARTED` | 0% | |
| I-12 | Expiry | none | — | — | — | — | `NOT STARTED` | 0% | |
| I-13 | Reservation expiry | none | — | — | — | — | `NOT STARTED` | 0% | **Needs a scheduler. None exists** |
| I-14 | Oversell protection | `reserved <= on_hand` CHECK | 0027 | — | ✓ | ✓ | `INTEGRATION TESTED` | 100% | A database rule. A delta-upsert bug here was found only by the live suite |
| I-15 | Future replaceability | contract suite | — | — | ✓ | — | `TESTED` | 90% | |

---

## J. Payments

| ID | Requirement | Implementation | Persistence | API | Tests | Integration | Status | % | Notes |
|---|---|---|---|---|---|---|---|---|---|
| J-01 | PaymentProvider port | `modules/payments/provider.ts` | — | — | `tests/contracts/payment-provider.contract.test.ts` (12) | — | `TESTED` | 100% | A replacement adapter is valid exactly when it passes the suite |
| J-02 | External payment assets, not fiat-only | `assertSettlementAsset` | `payment_asset_code_well_formed` | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 100% | `LKR`, `USD`, `BTC`, `USDC` all accepted |
| J-03 | Card | `PAYMENT_RAILS` | CHECK | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 90% | Rail vocabulary; **no live adapter** |
| J-04 | Bank transfer | ✓ | CHECK | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 90% | As above |
| J-05 | External wallet | ✓ | CHECK | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 90% | As above |
| J-06 | Digital-asset provider | ✓ | CHECK | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 90% | As above |
| J-07 | Cash on delivery | ✓ | CHECK | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 80% | Needs §R to confirm collection |
| J-08 | Authorise | `authorisePayment` | 0030 | `POST …/authorisation` | ✓ | ✓ | `INTEGRATION TESTED` | 95% | |
| J-09 | Capture | `capturePayment` | `payment_captured_within_authorised` | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 95% | |
| J-10 | Cancel | `cancelPayment` | ✓ | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 95% | Captured payments are refunded, not cancelled |
| J-11 | Refund | `refundPayment` | `payment_refunded_within_captured` | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 95% | Partial and full |
| J-12 | Status | `PAYMENT_TRANSITIONS` | CHECK | `GET /v1/payments/:id` | ✓ | ✓ | `INTEGRATION TESTED` | 100% | |
| J-13 | Idempotency | attempt keys | `UNIQUE` | header | ✓ | ✓ | `INTEGRATION TESTED` | 95% | Duplicate capture takes the money once |
| J-14 | Timeout recovery | `INDETERMINATE_FAILURES` | — | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 100% | **A timeout is not a decline.** The payment stays where it was and the retry is safe |
| J-15 | Webhook | `recordWebhook` | `webhook_receipt` | `POST …/webhooks/:provider` | ✓ | ✓ | `INTEGRATION TESTED` | 90% | Signature verification is the transport's; M-12 refuses unverified |
| J-16 | Replay handling | `UNIQUE (provider, provider_event_id)` | 0030 | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 100% | Out-of-order delivery is stale, not an error |
| J-17 | Reconciliation | `payment_attempt` trail | 0030 append-only | `GET …/attempts` | ✓ | ✓ | `PARTIAL` | 60% | The trail exists. **No reconciliation job compares it to a provider's record** |
| J-18 | No PAN/CVV persistence | `FOREIGN_FIELDS`, `payment_instrument_token_opaque` | CHECK | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 100% | Refused in TypeScript **and** in SQL; proven by inserting a card number |
| J-19 | Provider replaceability | contract suite | — | — | ✓ | — | `TESTED` | 100% | |
| J-20 | Live gateway adapter | none | — | — | — | — | `EXTERNALLY BLOCKED` | 0% | **BL-05: no payment sandbox credentials.** Only `MockPaymentProvider` ships |

---

## K. Universal multi-value ledger

| ID | Requirement | Implementation | Persistence | Tests | Integration | Status | % | Notes |
|---|---|---|---|---|---|---|---|---|
| K-01 | AssetType registry | `kernel/ledger-foundation/` | 0017, 0022, 0031 | `ledger-foundation.test.ts` | `ledger-foundation.integration.ts` | `INTEGRATION TESTED` | 90% | 10 attributes: issuer, unit, redeemable, convertible, expiry, restrictions, custodian, jurisdiction, transferability, withdrawability |
| K-02 | Fiat | asset class `fiat` | CHECK | ✓ | ✓ | `INTEGRATION TESTED` | 90% | |
| K-03 | Digital assets | asset class `digital_asset` | CHECK | ✓ | ✓ | `INTEGRATION TESTED` | 85% | No custody integration |
| K-04 | JAYA rewards | asset class `reward` | CHECK + 0031 (precision 0) | ✓ | ✓ | `INTEGRATION TESTED` | 80% | **Nothing issues them** — §M absent |
| K-05 | Cashback | asset type | ✓ | ✓ | ✓ | `PARTIAL` | 40% | Representable; no issuance rule |
| K-06 | Merchant credit | asset type | ✓ | ✓ | ✓ | `PARTIAL` | 40% | Representable; proven in the mixed-value test |
| K-07 | Promotional credit | asset type | ✓ | — | — | `PARTIAL` | 35% | Representable only |
| K-08 | Delivery credit | asset type | ✓ | — | — | `PARTIAL` | 35% | Representable only |
| K-09 | Introducer commission | none | — | — | — | `NOT STARTED` | 0% | §M |
| K-10 | Supplier introduction commission | none | — | — | — | `NOT STARTED` | 0% | §M |
| K-11 | Seller proceeds | wallet purpose `earnings` | 0032 | ✓ | ✓ | `PARTIAL` | 50% | The position exists; no payout (M-16) |
| K-12 | Driver earnings | wallet purpose | 0032 | — | — | `PARTIAL` | 25% | §R absent |
| K-13 | Member earnings | wallet purpose | 0032 | — | — | `PARTIAL` | 25% | §P absent |
| K-14 | Merchant / supplier earnings | wallet purpose | 0032 | ✓ | ✓ | `PARTIAL` | 40% | |
| K-15 | Community / social credits | asset class `community` | CHECK | — | — | `PARTIAL` | 30% | Representable; §Y absent |
| K-16 | Available | `getBalance` | derived from entries | ✓ | ✓ | `INTEGRATION TESTED` | 100% | |
| K-17 | Pending | ✓ | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 100% | |
| K-18 | Locked | ✓ | ✓ | ✓ | ✓ | `INTEGRATION TESTED` | 100% | Reservation is a journal entry, not a mutation |
| K-19 | Receivable | none | — | — | — | `NOT STARTED` | 0% | Not a K-10 position; needs a model |
| K-20 | Payable | none | — | — | — | `NOT STARTED` | 0% | As above |
| K-21 | Double entry | balanced-transaction rule | CHECK + service | ✓ | ✓ | `INTEGRATION TESTED` | 100% | Debits must equal credits |
| K-22 | Reversals | `cancelPlan` compensating transactions | append-only | ✓ | ✓ | `INTEGRATION TESTED` | 90% | Never a deletion |
| K-23 | Settlement | M-15 | none | — | — | `ARCHITECTURE ONLY` | 0% | Registered, empty |
| K-24 | Mixed-value transaction | `allocatePlan` / `commitPlan` | 0032 deferred trigger | `financial-ledger.test.ts` | `financial-ledger.integration.ts` | `INTEGRATION TESTED` | 95% | See §L |
| K-25 | Mixed-value refund | `cancelPlan` from `settled` | ✓ | ✓ | ✓ | `TESTED` | 75% | Full reversal only; **partial return needs a new opposite plan and is not built** |
| K-26 | Valuation | `valuationSource` attribute | 0017 | ✓ | ✓ | `PARTIAL` | 30% | Recorded; nothing values anything |
| K-27 | Restrictions | `restrictions` JSONB | 0022 | ✓ | ✓ | `PARTIAL` | 25% | **Recorded and enforced by nobody.** K-10 stores; no module reads |

---

## L. Value routing — the worked example

**Requirement:** LKR 10,000 = 1,500 JAYA rewards + 500 merchant credit + 8,000 external payment.

| ID | Requirement | Proof | Status | % |
|---|---|---|---|---|
| L-01 | Three-way mixed-value allocation | `tests/financial-ledger.test.ts` → *"a purchase of LKR 10,000 is paid with rewards, merchant credit and a card"* | `TESTED` | 100% |
| L-02 | Each leg in its own unit, its own journal transaction | Same test; asserts balances **in each unit separately** against a real K-10 | `TESTED` | 100% |
| L-03 | Legs sum to the obligation exactly | `assertAllocationAddsUp`; and `value_plan_legs_sum_to_target`, a **deferred constraint trigger** proven in `financial-ledger.integration.ts` by watching a COMMIT fail | `INTEGRATION TESTED` | 100% |
| L-04 | No rounding anywhere | Rates are integer pairs; `value_leg_rate_is_exact` is a cross-multiplication CHECK. 7 points at 3-per-2 is refused, 8 is accepted | `INTEGRATION TESTED` | 100% |
| L-05 | External leg settles separately | `settleExternalLeg`; plan waits at `committed` | `INTEGRATION TESTED` | 95% |
| L-06 | Internal value never sent to a gateway | `internal-value-not-settleable`, in the validator, the provider contract **and** `payment_asset_is_externally_settleable` | `INTEGRATION TESTED` | 100% |
| L-07 | Driven end to end by a real purchase | — | **`NOT STARTED`** | 0% | Nothing consumes `payment.captured` to call `settleExternalLeg`. The mechanism is proven; **no real purchase has ever flowed through it** |

**This is the single most complete requirement in the original vision, and it is still not wired to a
real order.**

---

## M. Introducer / peer marketing

Owning modules M-29 Referrals and M-30 Attribution: registered, empty. **Every row `NOT STARTED`,
0%.**

| ID | Requirement | Priority | Notes |
|---|---|---|---|
| M-01 | Customer introducer | P2 | |
| M-02 | Supplier introducer | P2 | |
| M-03 | Persistent attribution | P2 | Needs an attribution model that survives account changes |
| M-04 | Genuine transaction-based commission | P2 | Would consume M-11 `order.completed` |
| M-05 | **No payment for recruitment alone** | P2 | A design rule to encode, not a feature. Must be a refusal in code |
| M-06 | Versioned commission policy | P2 | K-06 Policy Engine exists and nothing publishes a policy |
| M-07 | Accrued / pending / paid | P2 | Maps to M-13 wallet purposes |
| M-08 | Reversal | P2 | M-13 supports compensating transactions |
| M-09 | Anti-abuse | P1 | §AD |
| M-10 | Privacy-safe dashboard | P2 | Must not expose who introduced whom |

---

## N–P. Merchant, supplier and member platforms

**All three sections: `NOT STARTED`, 0%.** No onboarding, no branches, no capacity model, no staff
model, no storage model, no break-bulk, no cockpits, no advisers.

| Section | Rows | Status | Priority | Blocking |
|---|---|---|---|---|
| N. Merchant platform (12 requirements) | onboarding, branches, catalogue, inventory, orders, staff, sales, margins, demand, procurement, AI adviser, financial cockpit | `NOT STARTED` 0% | P1 | Milestone 2 |
| O. Supplier platform (9 requirements) | onboarding, categories, capacity, locations, RFQs, quotes, stock evidence, performance, earnings, cockpit | `NOT STARTED` 0% | **P0** (RFQ depends on it) | Milestone 1–2 |
| P. Member / break-bulk (10 requirements) | onboarding, capacity, storage, stock, break bulk, packing, fulfilment, distribution, earnings, AI recommendations | `NOT STARTED` 0% | P2 | Milestone 2 |

M-37 Seller Cockpit is registered and empty. M-04 Universal Listing is the only supplier-adjacent
thing that exists.

---

## Q. Wholesale / Singha

| ID | Requirement | Status | % | Notes | Priority |
|---|---|---|---|---|---|
| Q-01 | Wholesale Need | `NOT STARTED` | 0% | Depends on §B | P2 |
| Q-02 | Wholesale RFQ | `NOT STARTED` | 0% | Depends on §G | P2 |
| Q-03 | Bulk supplier bids | `NOT STARTED` | 0% | | P2 |
| Q-04 | Split allocation | `PARTIAL` | 40% | **M-11 split fulfilment already does this** and is integration tested. The wholesale-specific layer is absent | P2 |
| Q-05 | Wholesale fee | `NOT STARTED` | 0% | M-14 Commission Rules registered, empty | P2 |
| Q-06 | Singha connector | `NOT STARTED` | 0% | No connector, no credentials | P3 |
| Q-07 | Singha not mandatory | `IMPLEMENTATION COMPLETE` | 100% | **Trivially satisfied**: nothing references Singha anywhere in the repository. The modularity is real because the coupling was never created | P3 |

---

## R. Logistics / Yaanadiri

M-19 Logistics: registered, empty. **Every row `NOT STARTED`, 0%.** 17 requirements, none begun.

Includes: logistics requirement, drivers, vehicles, Yaanadiri connector, third-party logistics,
merchant drivers, courier providers, dispatch scoring, capability matching, pickup, tracking,
delivery, evidence, reassignment, route optimisation, multi-pickup, multi-drop, consolidation.

**Priority P2 for Milestone 2**, except that cash-on-delivery (J-07) cannot complete without at
least pickup/delivery/evidence.

---

## S–U. Demand intelligence, procurement, services

**All `NOT STARTED`, 0%.**

| Section | Requirements | Owning | Priority |
|---|---|---|---|
| S. Demand intelligence | predicted Needs, reorder probability, depletion, SKU/category/geographic demand, shortages, excess stock, Demand Clouds, heatmaps, pooled demand, community price (12) | M-32, M-45 | P2 / Milestone 3 for the advanced parts |
| T. Procurement | reorder recommendation, supplier recommendation, AI RFQ preparation, quote comparison, recommended allocation, wholesale intelligence (6) | — | P2 |
| U. Services | service Need, providers, offers, assignment, payment, completion, associated service after goods (7) | M-24 | P2 |

---

## V. Universal cockpit — backend read-model support

| ID | Section | Implementation | API | Tests | Status | % | Missing |
|---|---|---|---|---|---|---|---|
| V-01 | NOW | none | — | — | `NOT STARTED` | 0% | No attention model, no aggregation |
| V-02 | MY COMMERCE | partial | `GET /v1/accounts/:id/orders` | ✓ | `PARTIAL` | 25% | Orders only. No Needs, RFQs, listings |
| V-03 | **MY MONEY** | `modules/user-cockpit/service.ts` | `GET /v1/accounts/:id/money` | `user-cockpit.test.ts` | `TESTED` | 70% | Balances per asset type with attributes. **Never one total** — see §W |
| V-04 | MY LIFE | none | — | — | `NOT STARTED` | 0% | §X |
| V-05 | MY BUSINESS | none | — | — | `NOT STARTED` | 0% | §N, §O |
| V-06 | MY DELIVERIES | none | — | — | `NOT STARTED` | 0% | §R |
| V-07 | MY COMMUNITY | none | — | — | `NOT STARTED` | 0% | §Y |
| V-08 | JAYA AI / what needs my attention | none | — | — | `NOT STARTED` | 0% | Needs §Z, §AA |

---

## W. Financial cockpit

| ID | Requirement | Status | % | Notes |
|---|---|---|---|---|
| W-01 | All balances | `TESTED` | 80% | `myMoney` lists every wallet position |
| W-02 | Fiat | `TESTED` | 85% | |
| W-03 | Crypto / digital assets | `PARTIAL` | 50% | Representable and displayable; no custody |
| W-04 | Rewards | `TESTED` | 70% | Shown with `withdrawable: false` beside the number |
| W-05 | Credits | `TESTED` | 70% | |
| W-06 | Earnings | `PARTIAL` | 50% | The `earnings` purpose is shown; nothing credits it |
| W-07 | Incoming | `NOT STARTED` | 0% | |
| W-08 | Receivable | `NOT STARTED` | 0% | K-19 |
| W-09 | Payable | `NOT STARTED` | 0% | K-20 |
| W-10 | Payments due | `NOT STARTED` | 0% | |
| W-11 | Refunds | `PARTIAL` | 40% | Visible on an order; not aggregated |
| W-12 | Commissions | `NOT STARTED` | 0% | §M |
| W-13 | Settlements | `NOT STARTED` | 0% | M-15 |
| W-14 | Income | `NOT STARTED` | 0% | |
| W-15 | Spending | `NOT STARTED` | 0% | |
| W-16 | Recurring obligations | `NOT STARTED` | 0% | |
| W-17 | **Optional consolidated value** | `IMPLEMENTATION COMPLETE` | 100% | Deliberately **refused by default**. A test asserts `MoneyView` has no `total` field: 1,500 points plus LKR 8,000 is not 9,500 of anything. If a consolidated figure is wanted it must be an explicit, valued, opt-in view — not the default |

---

## X. Life / financial wellbeing

M-31 Budgeting: registered, empty. **Every row `NOT STARTED`, 0%.** 13 requirements.

Category budgets, actual vs target, monthly suggestions, user override, safe-to-spend, savings,
emergency buffer, 7/30/90-day and 12-month cashflow, essential living cost, current lifestyle cost,
sustainable target income, opportunity engine.

**Note on the design constraint** ("keep advisory and user controlled"): nothing has been built that
violates it, because nothing has been built. When it is, the constraint needs to be a refusal in
code — a budget the platform can set without the user's agreement is the thing to make impossible.

---

## Y. Social / community value

| ID | Requirement | Status | % | Notes |
|---|---|---|---|---|
| Y-01 | Spendable community credits | `PARTIAL` | 25% | K-10 asset class `community` exists; nothing issues or spends |
| Y-02 | Separate from trust/reputation | `IMPLEMENTATION COMPLETE` | 100% | Satisfied by construction: no reputation model exists, so no coupling was created. **Must stay true when one is built** |
| Y-03 | Configurable rules | `NOT STARTED` | 0% | K-06 Policy Engine exists and nothing publishes a policy |
| Y-04 | **No punitive universal social-credit system** | `IMPLEMENTATION COMPLETE` | 100% | Nothing scores a person. This is a rule to keep, not a feature to build |
| Y-05 | **No sensitive-attribute marketplace restriction** | `IMPLEMENTATION COMPLETE` | 100% | No sensitive attribute is collected anywhere. K-01's opacity rule actively refuses identifiers that look like national ids, and it is enforced in SQL in every schema |

---

## Z. AI architecture

| ID | Requirement | Implementation | Persistence | Tests | Integration | Status | % | Notes |
|---|---|---|---|---|---|---|---|---|
| Z-01 | AI Gateway | `kernel/ai-gateway/` | 0019, 0023 | `ai-gateway.test.ts` | `ai-gateway.integration.ts` | `INTEGRATION TESTED` | 70% | Task definitions, model bindings, runs, decisions |
| Z-02 | Provider abstraction | `adapters/ai-provider.ts` | — | ✓ | — | `TESTED` | 90% | The port is real |
| Z-03 | Kimi adapter | none | — | — | — | `EXTERNALLY BLOCKED` | 0% | No credentials |
| Z-04 | Claude adapter | none | — | — | — | `EXTERNALLY BLOCKED` | 0% | No credentials |
| Z-05 | OpenAI-ready adapter | none | — | — | — | `EXTERNALLY BLOCKED` | 0% | No credentials |
| Z-06 | Other-model adapter | `adapters/mock-ai-provider.ts` | — | ✓ | — | `TESTED` | 100% | **Deterministic mock only.** No live model has ever been called |
| Z-07 | Model routing | `registerModel` binding | 0019 | ✓ | ✓ | `PARTIAL` | 40% | Binding exists; no routing policy, no fallback chain |
| Z-08 | Cost tracking | none | — | — | — | `NOT STARTED` | 0% | M-42 registered, empty |
| Z-09 | Latency tracking | none | — | — | — | `NOT STARTED` | 0% | |
| Z-10 | Fallback | none | — | — | — | `NOT STARTED` | 0% | |
| Z-11 | Structured output | `ExecuteTaskResult` | 0019 | ✓ | ✓ | `PARTIAL` | 50% | Shape exists; no schema enforcement against a live model |
| Z-12 | Authority policies | `task_authority`, 0–4 ceiling | 0023 | ✓ | ✓ | `INTEGRATION TESTED` | 85% | Append-only version history with a required rationale |
| Z-13 | **Kill switch** | `suspended` flag | 0023 | ✓ | ✓ | `INTEGRATION TESTED` | 95% | A suspended task is refused **at every level including observe** |

**The financial-zone rule holds:** `check:boundaries` proves no module in the financial authority
zone can import the AI gateway. 259 files, 1,030 imports, 0 violations.

---

## AA. Specialist agents

**All sixteen: `NOT STARTED`, 0%.** No agent exists — not as a contract, not as a stub. K-13 provides
the substrate an agent would run on (task registration, authority, kill switch); nothing has been
registered as a task.

Need, Visual, Search, Matching, Customer, Merchant, Demand, Procurement, Logistics, RFQ, Quality,
Risk, Community, Financial, Cockpit, Orchestrator.

**Distinction the audit was asked for:** none of the sixteen is contract-only. All sixteen are
absent. What exists is the gateway they would be registered with.

---

## AB. Privacy / consent

**All `NOT STARTED`, 0%** — with one exception.

| ID | Requirement | Status | Notes |
|---|---|---|---|
| AB-01…AB-05 | Location, browser, camera, microphone, wearable permissions | `NOT STARTED` | No consent model exists |
| AB-06 | Recommendation controls | `NOT STARTED` | |
| AB-07 | Marketing consent | `NOT STARTED` | |
| AB-08 | Data export | `NOT STARTED` | **Regulatory exposure** |
| AB-09 | Deletion | `NOT STARTED` | **Regulatory exposure.** Note the tension with append-only ledgers: a deletion design must be written before it is needed |
| AB-10 | Retention | `NOT STARTED` | |
| AB-11 | Privacy-safe supplier analytics | `NOT STARTED` | |
| AB-12 | **No natural keys in identifiers** | `INTEGRATION TESTED` | The one privacy control that is real and enforced: `is_opaque_identifier` refuses emails, phone numbers, national ids, IBANs and credentials — in TypeScript and byte-identically in **every** schema, checked by test |

---

## AC. Security — the deployment blocker

| ID | Requirement | Status | % | Notes |
|---|---|---|---|---|
| AC-01 | Authentication | `INTEGRATION TESTED` | 80% | K-02 ships a real verifier: scrypt at OWASP's interactive parameters, the parameters stored **with** the hash so the cost can be raised without invalidating a credential, timing-safe comparison, and a decoy hash so an unknown account costs the same as a wrong password. A person signs in and calls the API in `tests/api-access.test.ts`. **Not higher:** the credential store is in memory — K-02's schema deliberately holds no credential, so a durable one needs a schema of its own — and `main.ts` refuses to start in production because of it |
| AC-02 | MFA readiness | `PARTIAL` | 55% | Factor categories and a per-provider floor that may be raised and never lowered exist and are tested. The password verifier reports `single-factor` honestly rather than claiming more, which is what keeps the floor meaningful. No second factor ships |
| AC-03 | RBAC | `INTEGRATION TESTED` | 85% | `apps/api/access.ts` calls `authorize` before every handler; `apps/api/policy.ts` is the published V1 policy. A buyer cannot capture or refund, a seller cannot create an order, and a session holding no grant reaches nothing. **Not higher:** grant *conditions* are unused, so a seller's authority is bounded by object ownership rather than by a predicate inside the grant |
| AC-04 | Object-level permissions | `INTEGRATION TESTED` | 90% | The `OWNERS` table resolves who may reach each object, by resource type. K-04 structurally cannot do this — who owns order X is M-11's fact — so without it a legitimate "you may read orders" grant read everybody's. `GET /v1/accounts/{anyone}/money` now answers only that account |
| AC-05 | Organisation isolation | `INTEGRATION TESTED` | 75% | The **account** is the isolation boundary: K-04 grants never span accounts, the account is resolved from the session and never read from the request, and `cross-account-access` is refused before any grant is loaded. Proven at the HTTP edge. **Not higher:** there is still no multi-member organisation model — one subject, one account |
| AC-06 | IDOR protection | `INTEGRATION TESTED` | 90% | Absent and forbidden are answered identically, and a test asserts the two responses are indistinguishable — a 403 for one and a 404 for the other is an oracle for enumerating identifiers. Every route that names an object is covered |
| AC-07 | CSRF | `NOT STARTED` | 0% | No cookies yet, so no surface yet |
| AC-08 | XSS | `NOT STARTED` | 0% | No UI yet |
| AC-09 | SQL injection | `IMPLEMENTATION COMPLETE` | 95% | Every statement is parameterised. Table names are constants, never interpolated from input |
| AC-10 | Rate limits | `NOT STARTED` | 0% | **Deployment blocking, and now the highest security gap.** Sign-in is reachable and scrypt is expensive *by design*, so an unthrottled login endpoint is both a credential-stuffing surface and a way to exhaust the server with legitimate-looking work |
| AC-11 | Private uploads | `NOT STARTED` | 0% | No object storage at all |
| AC-12 | Webhook verification | `INTEGRATION TESTED` | 90% | **A real defect, found and closed.** The route read `signatureVerified` out of the request body, so anybody who could reach the port could post a delivery claiming a payment had been captured — M-12 refused correctly, but the caller was supplying the answer. It is now HMAC-SHA256 over the raw bytes, the timestamp inside the signed payload so it cannot be moved forward, a five-minute window each way, timing-safe comparison, and a body that still claims the field refused by name. **Not higher:** no live provider's scheme has been implemented against (BL-05) |
| AC-13 | Replay protection | `INTEGRATION TESTED` | 100% | `UNIQUE (provider, provider_event_id)` |
| AC-14 | Secrets | `PARTIAL` | 40% | Connection strings are redacted in driver errors and tested. No secret manager, no rotation |
| AC-15 | PII in logs | `PARTIAL` | 60% | Unclassified errors go to the observer and a **generic** message to the client; a test asserts a leaked key does not reach a response. No systematic PII scrubbing |

---

## AD. Risk / disputes / quality

M-17, M-18, M-20, M-21 registered, empty. **Every row `NOT STARTED`, 0%.** 10 requirements.

Fraud flags, fake supply, referral abuse, payment abuse, delivery abuse, dispute workflow, evidence,
refund adjustment, quality evidence, AI quality support.

---

## AE. Internal control tower

M-38 Operations Cockpit: registered, empty. **Every row `NOT STARTED`, 0%.** 19 areas.

**One thing exists that a control tower would need:** the outbox relay can report dead-lettered rows
(`PostgresOutboxSource.deadLettered`), integration tested. Nothing reads it.

---

## AF. UI / UX

**Every row: `NOT STARTED`, 0%.**

`design-system/` contains one README and no code. `apps/` contains only `apps/api`. There is no
component, no screen, no stylesheet, no build for a front end, and no placeholder — which at least
means there is nothing that could be mistaken for progress.

Customer app, merchant cockpit, supplier cockpit, member cockpit, introducer cockpit, driver mode,
internal control tower, mobile, tablet, desktop, realtime states, loading/empty/error/success states:
**none exist.**

---

## AG. Deployment / operations

| ID | Requirement | Status | % | Evidence / gap |
|---|---|---|---|---|
| AG-01 | Clean DB migration | `INTEGRATION TESTED` | 95% | 47 forward + 47 rollback, checksum reconciliation, advisory locking, per-migration atomicity. Every module's rollback is proven to leave no trace |
| AG-02 | Staging environment | `NOT STARTED` | 0% | None exists |
| AG-03 | Production configuration | `PARTIAL` | 25% | `main.ts` reads `DATABASE_URL`, `PORT`, `JAYA_ENV`; **refuses to start in production with the mock payment provider** unless explicitly acknowledged. No config management |
| AG-04 | Health endpoints | `TESTED` | 60% | `GET /v1/health` answers without touching a module. **No readiness probe, no dependency check** |
| AG-05 | Logs | `PARTIAL` | 55% | One structured JSON line per request with method, path, status, correlation id and code. No aggregation, no shipping |
| AG-06 | Monitoring | `NOT STARTED` | 0% | No metrics, no traces, no alerts |
| AG-07 | Backups | `NOT STARTED` | 0% | **Deployment blocking for a financial system** |
| AG-08 | Restore | `NOT STARTED` | 0% | **Deployment blocking.** An untested restore is not a backup |
| AG-09 | Rollback | `PARTIAL` | 50% | Migration rollback is proven per module. No application rollback procedure |
| AG-10 | Runbook | `NOT STARTED` | 0% | |
| AG-11 | Environment docs | `PARTIAL` | 30% | `compose.yaml` pins PostgreSQL 16.10; `CONTRIBUTING.md` under executable contract. No environment matrix |
| AG-12 | Deployment smoke tests | `NOT STARTED` | 0% | |
| AG-13 | CI | `EXTERNALLY BLOCKED` | 0% | **BL-10: the repository credential lacks the Workflows permission**, so nothing touching `.github/workflows/` can reach the remote. Every gate runs locally and passes; none runs automatically |

---

## 5. Completion scores

Weighted toward core user functionality, as instructed. Architecture and contracts are cheap;
working software is not, and the two are scored separately so the first cannot flatter the second.

| Dimension | Score | Basis |
|---|---|---|
| **Architecture** | **85%** | Manifest, 8-layer model, 4 executable boundary checks with planted-violation fixtures, financial-zone isolation, schema-namespace ownership. Genuinely enforced, not aspirational |
| **Contracts** | **45%** | 21 of 62 units have a written contract. Those that exist are precise and executable |
| **Backend implementation** | **17%** | 7 of 47 business modules; 14 of 15 kernel components. The 7 are the transaction spine and are strong. 40 modules have no code |
| **Integration testing** | **32%** | 42 live-PostgreSQL tests covering everything that exists, thoroughly. Nothing covering what does not |
| **E2E functionality** | **2%** | **No E2E harness exists.** The API integration suite is the closest thing and is not a user journey |
| **AI functionality** | **6%** | Gateway, authority ceiling and kill switch are real and tested. Zero live adapters, zero of sixteen agents, nothing has ever called a model |
| **Financial functionality** | **58%** | The strongest area. Multi-value ledger, three positions, double entry, mixed-value routing with no rounding, payments with timeout discipline, database-enforced invariants. Missing: settlement, payout, commission, receivable/payable, restriction enforcement |
| **Logistics** | **0%** | Nothing |
| **Cockpit backend** | **12%** | 3 of 8 sections, buyer only, no role adaptation |
| **Final UI/UX** | **0%** | Nothing. One README |
| **Security** | **58%** | Was not scored separately before, and should have been — it is the dimension that decides whether anything else may be deployed. Authentication, authorisation, object-level access, account isolation, IDOR and webhook verification are all real and tested at the HTTP edge. Rate limits, secret management, backups and consent are not |
| **Deployment readiness** | **22%** | Migrations, health and now a closed front door are real. No CI, no rate limits, no monitoring, no backups, no staging, and passwords are not yet durable |
| **Overall original JAYA vision** | **≈ 15%** | See below |

### Why 15% and not 40%

A naive average of the rows above gives something near 25%. That would be dishonest, for three
reasons:

1. **The bulk of the original vision is the Need → sourcing → RFQ → quote path**, and none of it
   exists. That is not one requirement; it is five sections and the reason the platform is
   differentiated.
2. **Nothing is reachable by a person who is not a developer.** There is now authentication and
   authorisation, so a real user *could* be signed in — but there is no UI, no registration route,
   and no durable password store, so in practice every capability above is still reached only by a
   test.
3. **Contracts and architecture were weighted down deliberately.** They are 85% and 45% complete and
   they are worth having, but a customer cannot buy anything with a boundary check.

The movement from 13% to 15% is two points and no more, and the reason is worth being explicit
about: closing the front door does not add a feature. It converts a system that could not be
deployed at all into one that could be deployed to people it does not yet have anything to show. It
was still the right thing to do first, because every screen and every route built before it would
have had to be revisited afterwards.

What *is* worth stating plainly: the 15% that exists is unusually solid. The financial core has
invariants enforced in the database, not just in code; the concurrency cases are proven against a
real server; and several defects — the webhook that trusted its caller among them — were caught by
tests that a less careful suite would have missed.

---

## 6. Deployment blockers

In order.

**Closed since the last revision, and no longer blocking:**

- ~~AC-01 Authentication~~ — a real scrypt verifier ships and a person signs in.
- ~~AC-03/AC-04/AC-05/AC-06 Authorisation~~ — every route is guarded, every object is checked
  against its owner, and a test makes an unguarded route a failing build.
- ~~AC-12 Webhook verification~~ — the route no longer takes the caller's word for it.

**Still blocking:**

1. **AC-10 Rate limits** — none. The most urgent of these, and more urgent than it was: sign-in is
   now reachable, and scrypt is deliberately expensive, so an unthrottled login endpoint is a
   credential-stuffing surface *and* a way to exhaust the server with work that looks legitimate.
2. **A durable password store** — passwords are held in memory, so a restart locks everyone out.
   `main.ts` refuses to start in production for this reason, with no acknowledgement flag.
3. **AG-07/AG-08 Backups and restore** — none. Unacceptable for a system holding a ledger.
4. **J-20 Live payment gateway** — `EXTERNALLY BLOCKED` on BL-05. The platform can take an order and
   never take the money.
5. **AG-13 CI** — `EXTERNALLY BLOCKED` on BL-10.
6. **AG-02 Staging** — none.
7. **AF UI** — nothing to deploy for a user.

---

## 7. What is genuinely working

Stated precisely, because the point of this audit is that the list is short and true.

- **An order** can be created, filled, placed, confirmed, fulfilled, completed, cancelled and split
  across suppliers, with the arithmetic enforced by the database and concurrent splits refused.
- **A payment** can be requested, authorised, captured, cancelled and refunded against a mock
  gateway, with duplicate captures, double refunds, provider timeouts, out-of-order webhooks and
  redelivered webhooks all handled correctly and proven against PostgreSQL.
- **A mixed-value purchase** — rewards plus merchant credit plus card — allocates across three
  units, posts three balanced journal transactions, and the database itself refuses a plan whose
  legs do not sum to the obligation.
- **The outbox relay** claims rows with `FOR UPDATE SKIP LOCKED`, so two relays partition work
  rather than publishing every fact twice; failures back off and are eventually dead-lettered.
- **The HTTP API** serves 37 routes with idempotency, correlation and problem-details errors that
  keep each module's own refusal code.
- **MY MONEY** shows a holder's positions per asset type, with withdrawability and issuer beside the
  number, and refuses to invent a single total.
- **A person can sign in** with a password verified against a scrypt hash, and every subsequent
  request is authenticated, authorised against a published policy, and checked against the object it
  names. One customer cannot read another's order, balance or payment; a buyer cannot capture or
  refund; a session holding no grant reaches nothing at all.

Everything else in this document is either partial, absent, or blocked.

---

## 8. Current critical path

1. ~~Authentication and authorisation~~ — **done.** Every other user-facing thing was going to be
   built on an open door, and now is not.
2. Rate limits, then a durable password store — the two things that stand between the front door
   being closed and its being safe to open to the public.
3. Wire the spine end to end: order → inventory reservation → payment → `payment.captured` →
   `settleExternalLeg` → fulfilment → completion. Every piece of that chain exists except the
   consumers that join them, which is why it is the cheapest large gain available.
4. The Need engine (§B) — the entry point of the original product.
5. Sourcing and RFQ (§E, §G) — the differentiated middle.
6. A first UI, once the journey above is proven end to end and not before.

See `JAYA_REMAINING_BACKLOG.md` for the ordered work.
