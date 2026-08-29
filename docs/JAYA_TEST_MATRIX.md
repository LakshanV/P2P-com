# JAYA — Test Matrix

**Governing documents:** `docs/JAYA_MASTER_ARCHITECTURE.md`, `docs/JAYA_MODULE_MAP.md`

This document defines the testing strategy, mandatory scenarios, contract tests, and current status.

---

## 1. Testing Strategy

### 1.1 Levels

| Level | Purpose | Tools |
|---|---|---|
| Unit | Module logic in isolation with injected fakes | Node built-in test runner |
| Integration | Module + real PostgreSQL + cross-component wiring | Node built-in test runner + Docker Postgres |
| Contract | Verify a module's public interface independently of its internals | Node built-in test runner + fake adapters |
| End-to-end | Full user scenarios across modules | To be introduced when APIs exist |
| Adversarial | Security, abuse, failure, and financial edge cases | Node built-in test runner |

### 1.2 Isolation Rule

Every module must be testable without real external dependencies. Use mocks/fakes at every module boundary.

Examples:

- Inventory tests use a fake payment provider.
- Payment tests use a fake inventory implementation.
- RFQ tests run without logistics.
- AI tests use `MockAIProvider`.

### 1.3 Contract Tests

When a module is replaceable, it must have a contract test. Example:

```typescript
// tests/contracts/inventory.contract.test.ts
// InventoryModuleV2 must pass this test to be a valid replacement.
```

Mandatory contract suites:

- Inventory
- Payments
- AI provider
- Logistics
- Search
- Notifications
- Crypto provider

---

## 2. Existing Test Status

### 2.1 Unit / Fast Tests

```bash
npm test
```

| Result | Count |
|---|---|
| Total | 1,261 |
| Pass | 1,261 |
| Fail | 0 |
| Skip | 0 |

Coverage: kernel foundations, platform substrate, migration/fixture contracts, architecture boundary checks.

### 2.2 Integration Tests (Live PostgreSQL)

```bash
npm run test:integration
```

| Result | Count |
|---|---|
| Total | 49 |
| Pass | 0 |
| Fail | 0 |
| Skip | 49 (no DATABASE_URL) |

Files:

- `tests/integration/test-database-lifecycle.integration.ts`
- `tests/integration/migrations.integration.ts`
- `tests/integration/identity.integration.ts`
- `tests/integration/accounts.integration.ts`
- `tests/integration/authentication.integration.ts`
- `tests/integration/permissions.integration.ts`
- `tests/integration/policy-engine.integration.ts`
- `tests/integration/feature-flags.integration.ts`
- `tests/integration/audit.integration.ts`
- `tests/integration/fixtures.integration.ts`

---

## 3. Mandatory End-to-End Scenarios

These scenarios are release gates. Each must have an automated test once the relevant modules exist.

### SCENARIO 1 — Text Need → Stock → Order → Payment → Delivery → Settlement

**Modules involved:** M-03, M-04, M-06, M-07, M-11, M-12, M-13, M-14, M-15, M-19, K-08, K-09

**Steps:**

1. Customer creates Need from text.
2. Need is interpreted.
3. Search finds existing stock.
4. Match Engine ranks candidates.
5. Customer accepts offer.
6. Order created.
7. Payment authorised and captured.
8. Inventory reserved then committed.
9. Shipment created and driver assigned.
10. Delivery completed.
11. Ledger posts entries.
12. Commissions calculated.
13. Settlement released.
14. Seller payout scheduled.

**Verification points:**

- Order status transitions correctly.
- Payment idempotency key replay returns same result.
- Ledger balances are correct in minor units.
- Commission stored with policy version id.
- Events emitted at each major step.

---

### SCENARIO 2 — Image → Product Recognition → Supplier Search → RFQ → Quote → Order

**Modules involved:** M-03, M-10 Multimodal Understanding, M-11 Visual Search, M-05, M-06, M-09, M-10, M-11, K-13

**Steps:**

1. Customer uploads product image.
2. AI identifies product/category/brand/model with confidence.
3. Visual search finds catalogue candidates.
4. Supplier search runs.
5. RFQ created with privacy mode.
6. Suppliers invited.
7. Quotes submitted.
8. Quote scoring ranks options.
9. Customer accepts quote.
10. Order created.

**Verification points:**

- Confidence thresholds configurable.
- Human correction recorded.
- RFQ privacy mode enforced.
- Scoring explanation stored.

---

### SCENARIO 3 — Wholesale Request → Multiple Suppliers → Split Fulfilment

**Modules involved:** M-09/M-35 Wholesale, M-10, M-11, M-04, M-13, M-15

**Steps:**

1. Merchant creates wholesale Need.
2. Multiple suppliers receive RFQ.
3. Quotes received for partial quantities.
4. Split allocations computed.
5. Parent order created with child orders.
6. Payments captured per supplier.
7. Multiple deliveries tracked.
8. Settlements per supplier.

**Verification points:**

- Combined quantity equals required quantity.
- Customer sees unified order.
- Ledger splits correctly.

---

### SCENARIO 4 — Introducer Relationship → Genuine Transaction → Commission

**Modules involved:** M-29, M-30, M-14, M-13

**Steps:**

1. Introducer registers.
2. Introducer links customer or supplier.
3. Linked entity performs qualifying transaction.
4. Attribution records link.
5. Commission rule applies.
6. Commission accrued.
7. Commission settled.

**Verification points:**

- No commission for recruitment alone.
- Commission only on configured qualifying events.
- Privacy preserved in introducer dashboard.

---

### SCENARIO 5 — Merchant Demand Forecast → Suggested Procurement

**Modules involved:** M-33, M-34, M-09, M-10

**Steps:**

1. Demand intelligence analyses sales/search data.
2. Forecast predicts SKU demand.
3. Merchant receives stock-out warning.
4. System suggests supplier or RFQ.
5. Merchant approves procurement action.

**Verification points:**

- Forecast is explainable.
- Recommendations only; no auto-spend.

---

### SCENARIO 6 — Driver Dispatch → Pickup → Delivery

**Modules involved:** M-19, M-38 Driver Network, M-39 Vehicle Network, M-41 Dispatch Engine, M-43 Location

**Steps:**

1. Order ready for delivery.
2. Dispatch Engine scores available drivers/vehicles.
3. Driver assigned.
4. Pickup recorded with proof.
5. Route optimised.
6. Delivery recorded with proof.

**Verification points:**

- Dispatch algorithm replaceable.
- Vehicle compatibility checked (payload, refrigeration).
- GPS/location data recorded.

---

### SCENARIO 7 — Multi-Value Payment (Rewards + Fiat)

**Modules involved:** M-12, M-13, M-28, M-51 Value Router

**Steps:**

1. Order total: Rs 10,000.
2. Value Router proposes:
   - JAYA Cashback: Rs 1,500
   - Merchant Credit: Rs 500
   - LKR: Rs 8,000
3. Customer approves allocation.
4. Payment captured in multiple asset types.
5. Ledger posts entries per asset.

**Verification points:**

- Customer explicitly approves allocation.
- Restricted credits not treated as withdrawable money.
- Ledger balances correct per asset type.

---

### SCENARIO 8 — Customer Cockpit Shows Financial State

**Modules involved:** M-36, M-13, M-12, M-15, M-14, M-29

**Steps:**

1. Customer opens cockpit.
2. Cockpit projection loads:
   - balance
   - incoming
   - payments due
   - spending
   - commission
   - refunds
3. Data sourced from events/read models, not direct table joins.

**Verification points:**

- Projections are consistent with ledger.
- Privacy controls respected.

---

### SCENARIO 9 — Inventory Implementation Swap Does Not Break Orders

**Modules involved:** M-04, M-11

**Steps:**

1. Run orders with InventoryModuleV1.
2. Swap to InventoryModuleV2.
3. Run same order scenarios.

**Verification points:**

- Inventory contract test passes for V2.
- Orders still compile and pass integration tests.

---

### SCENARIO 10 — Payment Provider Swap Does Not Break Ledger

**Modules involved:** M-12, M-13

**Steps:**

1. Run payments with MockPaymentProvider.
2. Swap to another provider adapter.
3. Run same payment scenarios.

**Verification points:**

- Payment contract test passes.
- Ledger entries remain deterministic and correct.

---

## 4. Contract Test Inventory

| Module | Contract Test File | Public Interface Verified |
|---|---|---|
| Inventory | `tests/contracts/inventory.contract.test.ts` (planned) | `getAvailability`, `reserve`, `release`, `commit`, `receive`, `adjust`, `transfer` |
| Payments | `tests/contracts/payments.contract.test.ts` (planned) | `createPaymentIntent`, `authorize`, `capture`, `cancel`, `refund`, `getStatus` |
| AI Provider | `tests/contracts/ai.contract.test.ts` (planned) | `executeTask`, `estimateCost`, result shape, cost capture |
| Logistics | `tests/contracts/logistics.contract.test.ts` (planned) | `createShipment`, `assignDriver`, `recordPickup`, `recordDelivery` |
| Search | `tests/contracts/search.contract.test.ts` (planned) | `index`, `query`, `remove`, facet/suggest |
| Notifications | `tests/contracts/notifications.contract.test.ts` (planned) | `send`, `schedule`, status retrieval |
| Crypto | `tests/contracts/crypto.contract.test.ts` (planned) | balance, transfer, custody status |

---

## 5. Security / Adversarial Scenarios

| ID | Scenario | Modules |
|---|---|---|
| ADV-001 | Double-spend via replayed payment idempotency key | M-12 |
| ADV-002 | Negative balance via race on ledger entry | M-13, K-10 |
| ADV-003 | Privilege escalation via tampered permission decision | K-04 |
| ADV-004 | AI attempts to alter order total | M-11, K-13 |
| ADV-005 | Supplier creates fake inventory | M-04, M-18 |
| ADV-006 | Introducer claims commission without qualifying transaction | M-29, M-30 |
| ADV-007 | Refund fraud loop | M-12, M-13, M-21 |
| ADV-008 | Delivery fraud: mark delivered without proof | M-19 |
| ADV-009 | Cross-tenant data access | K-04, all modules |
| ADV-010 | SQL injection via user input | all repository layers |

---

## 6. Current Gaps

| Gap | Action |
|---|---|
| No contract tests exist | Add as modules are implemented |
| No E2E tests exist | Add when first API routes exist |
| Live integration tests skip | Start PostgreSQL and run `npm run test:integration` |
| No adversarial suite | Create with financial core (M-11/M-12/M-13) |
| No performance/load tests | Add in Phase 20 |
| No accessibility tests | Add when UI exists |

---

## 7. Running the Tests

```bash
# Static verification
npm run verify

# Unit tests only
npm test

# Integration tests (requires DATABASE_URL and running PostgreSQL)
cp .env.example .env
npm run db:up
npm run db:ready
npm run test:integration

# Single contract test (planned)
node --test tests/contracts/inventory.contract.test.ts
```
