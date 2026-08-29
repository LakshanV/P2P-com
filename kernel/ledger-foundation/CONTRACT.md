# K-10 Ledger Foundation — contract

**Status:** foundation delivered. **Not complete** — see §7.  
**Owner:** K-10, `kernel/ledger-foundation/`.  
**Schema:** `kernel_ledger_foundation`, created by [`0017_create_kernel_ledger_schema.up.sql`](../../db/migrations/0017_create_kernel_ledger_schema.up.sql) and extended by [`0022_extend_kernel_ledger_value_model.up.sql`](../../db/migrations/0022_extend_kernel_ledger_value_model.up.sql).  
**Depends on:** platform substrate only. No business-module or AI-gateway dependencies.

---

## 1. What this component owns

Every amount in the platform:

| Concern | Owned here |
|---|---|
| The unit of account (asset type), and what kind of value it is | `asset_type` |
| A position in one asset type | `ledger_account` |
| A balanced movement between accounts and between positions | `ledger_transaction` + `ledger_entry` |
| The three derived positions of an account | `getBalance(accountId)` |

What it does **not** own:

| Concern | Owner |
|---|---|
| **Enforcing** an asset type's restrictions | The module spending the value; K-10 stores restrictions and interprets none of them |
| **Enforcing** an expiry | The module that issued the value; K-10 records `expiryDays` and expires nothing on its own |
| Whether an account may go negative in a position | The posting module; K-10 is a journal, not a spending limit |
| Prices, listings, orders | Business modules (M-03, M-04, M-05, …) |
| Payments, payouts, rewards | Payments, Seller Payouts, Rewards modules |
| Who may move money | K-04 Permissions (when it exists) |
| Authentication of the operator | K-02 Authentication (when it exists) |

---

## 2. Public contract

```ts
new LedgerService(repository)

registerAssetType(request): Promise<{ assetType, deduplicated }>
createAccount(request): Promise<{ account, deduplicated }>
postTransaction(request): Promise<{ transaction, deduplicated }>
getBalance(accountId): Promise<AccountBalance>
findAccount(accountId): Promise<LedgerAccount | null>
findTransaction(transactionId): Promise<LedgerTransaction | null>
```

All amounts are integer **minor units** (`bigint`). Floating point is never used for money.

### Guarantees

| Guarantee | Meaning |
|---|---|
| Asset type vocabulary | Asset type ids are `^[a-z][a-z0-9_]*$`; symbols are upper-case like `LKR` |
| One account per id | A duplicate `accountId` is refused; the same `idempotencyKey` with the same content returns the original account |
| One transaction per id | A duplicate `transactionId` is refused; the same `idempotencyKey` with the same content returns the original transaction |
| Balanced journal | Every transaction must have at least one debit and one credit, and total debits must equal total credits |
| Single asset type per transaction | Every line references an account denominated in the transaction's `assetTypeId` |
| Non-negative amounts | Line amounts are `>= 0` minor units |
| Derived balances | `getBalance` sums every entry for the account; no balance column can disagree |
| Three positions per account | Every account holds `available`, `pending` and `locked` positions. Each is summed independently and signed by the account's normal balance; `total` is their sum |
| Reservation is a journal entry | Locking value is an ordinary balanced transaction that debits one position and credits another on the same account. The total does not change when spendability does, and nothing is mutated |
| One line per position | A transaction may move each `(account, position)` pair at most once. Debiting and crediting one position in one movement nets to nothing and hides what was meant |
| Position defaults to available | An entry that does not name a position moves `available` value. Nothing silently invents a reservation |
| Value types are describable | An asset type states its issuer, unit, redeemability, convertibility, transferability, withdrawability, expiry, restrictions, custodian and jurisdiction. A reward point is not storable as if it were cash |
| Asset types are never redefined | Re-registering an id with any different attribute — including an expiry or a restriction — is refused, because it would change what every balance denominated in it is worth |
| Append-only history | No service operation updates or deletes `asset_type`, `ledger_account`, `ledger_transaction` or `ledger_entry`; the database enforces the same with triggers |
| Atomic outbox | A posted transaction writes the transaction, its entries, and two outbox rows in one transaction |
| Determinism | The caller supplies every identifier and every instant; the service reads no clock and generates no randomness |

### Refusals

| Code | Refused because |
|---|---|
| `malformed-asset-type-id` | The asset type id is not lower_snake_case |
| `malformed-symbol` | The symbol is not an upper-case token |
| `unsupported-asset-class` | The asset class is not one of `fiat`, `reward`, `digital_asset`, `community` |
| `invalid-precision` | Precision is not a positive integer |
| `malformed-issuer` | An asset type gave no issuer. Value nobody stands behind is not a value type |
| `malformed-unit` | The minor-unit name is not lower_snake_case |
| `malformed-jurisdiction` | The jurisdiction is not ISO 3166-1 alpha-2 or `GLOBAL` |
| `invalid-expiry` | `expiryDays` is not a positive whole number of days, and is not null |
| `invalid-balance-state` | A line named a position that is not `available`, `pending` or `locked` |
| `duplicate-asset-type-id` | An asset type id already exists with different properties |
| `malformed-identifier` | An opaque identifier is not 8–128 characters of `[A-Za-z0-9._:-]` |
| `natural-identifier` | An identifier looks like an email, telephone, document, IBAN, URL, domain or personal name |
| `secret-bearing-input` | An identifier looks like a credential |
| `malformed-instant` | An instant is not a valid UTC instant |
| `unknown-asset-type` | The account or transaction references an unregistered asset type |
| `duplicate-account-id` | An account id already exists |
| `idempotency-key-reuse` | An idempotency key was used for a different account or transaction |
| `duplicate-transaction-id` | A transaction id already exists |
| `unbalanced-transaction` | Debits do not equal credits, or the transaction has no entries |
| `negative-amount` | A line amount is negative or not an integer |
| `unknown-account` | A transaction references an account that does not exist |
| `mixed-asset-type` | A transaction line references an account in a different asset type |
| `no-such-account` | `getBalance` names no account |
| `nested-transaction` | An enlisted write tried to issue transaction control |
| `malformed-record` | A stored row is not what this component writes |
| `foreign-concern` | A request carried a field belonging to another component |

---

## 3. Architecture boundary

K-10 is in the deterministic financial authority zone (MODULE_MAP.md §11). It imports only:

- platform substrate (`platform/time/instant`, `platform/outbox/*`, `platform/db/*`)
- K-09 Audit Foundation **types** for the audit action definition (`kernel/audit-foundation/registry.ts`)
- K-08 Event Infrastructure **types** for the event type definition (`kernel/event-infrastructure/registry.ts`)

It does **not** import the AI gateway, K-13, or any business module.

---

## 4. Persistence

Three implementations of the `LedgerRepository` port:

- `InMemoryLedgerRepository` — reference implementation, enforces the same uniqueness and balance rules as PostgreSQL.
- `PostgresLedgerRepository` — owns the `kernel_ledger_foundation` schema.
- `EnlistedLedgerRepository` — for a caller that already owns a transaction.

Timestamps are projected as UTC text through `to_char`; amounts are stored as `bigint` and read as strings, then converted back to `bigint`.

The migration creates:

- `asset_type` (with the eight value attributes added by 0022), `ledger_account`, `ledger_transaction`, `ledger_entry` (with `balance_state`, and a primary key of `(transaction_id, account_id, side, balance_state)`)
- `outbox` with the same columns as migrations 0013–0016
- Primary keys, unique constraints, `CHECK` constraints, foreign keys within the schema
- A deferred trigger on `ledger_entry` that refuses unbalanced, empty or mixed-asset-type transactions
- Append-only triggers on the business tables
- An unprocessed outbox index

No statement names another module's schema; no foreign key leaves `kernel_ledger_foundation`.

---

## 5. Outbox

Every posted transaction appends two rows to `kernel_ledger_foundation.outbox` inside the same transaction:

- `ledger.transaction_posted` event — a K-08 `EventEnvelope` whose payload contains the transaction id, idempotency key, posted at, asset type id, debit/credit totals and entry count.
- `ledger.transaction_posted` audit record — a K-09 `AuditRecord` with the same evidence.

Amounts in the outbox payloads are decimal strings so they survive JSON serialization without floating point.

---

## 6. Verification

```bash
npm run verify                                   # everything, including the tests below
node --test tests/ledger-foundation.test.ts      # contract, refusals, balances, outbox
node --test tests/ledger-foundation-repository.test.ts  # port conformance, adapter, migration contract
node --test tests/ledger-foundation-multi-value.test.ts # value attributes, three positions, reservation
npm run test:integration                          # live PostgreSQL; skips without a database
```

`npm run verify` is the gate. The live suite skips with a stated reason when no database is configured.

---

## 7. Deliberately deferred

- No authentication or authorisation (K-02, K-04).
- No business-module integrations — orders, payments, rewards, payouts post here later.
- No price or valuation logic beyond the asset type's `valuationSource` string. No conversion between asset types.
- **No enforcement of an asset type's own attributes.** K-10 records that a reward expires in 180 days, may not be withdrawn and is redeemable only against a named merchant; it does not expire it, block a withdrawal or check a basket. Those are decisions belonging to the module spending the value, which is the only unit that knows what it is being spent on. The attributes exist so that module has something true to decide from.
- **No overdraft protection.** A position may go negative. K-10 reports it accurately rather than clamping it, so a caller can detect it.
- No chart-of-accounts hierarchy, sub-ledgers or closing/period-end logic.
- No relay wiring — the outbox rows are written; a relay dispatches them.
- No listing, search or reporting over ledger data.
