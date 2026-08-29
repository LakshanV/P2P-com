# K-15 Search Foundation — contract

**Status:** foundation implemented.
**Owner:** K-15, `kernel/search-foundation/`.
**Schema:** `kernel_search_foundation`, created by
[`0021_create_kernel_search_foundation_schema.up.sql`](../../db/migrations/0021_create_kernel_search_foundation_schema.up.sql).
**Depends on:** platform substrate, K-08 Event Infrastructure, K-09 Audit Foundation. No business
module, financial module, AI gateway or notification module.

---

## 1. What this component owns

Two primitives for search aggregation:

- **SearchDocument** (`kernel_search_foundation.document`) — an index abstraction carrying text,
  structured facets, optional embedding buckets and static ranking signals. Documents are keyed by
  `documentId` and replaced whole on re-index.
- **SearchQueryLog** (`kernel_search_foundation.query_log`) — one row per executed query, recording
  the text, filters and result count. Append-only.

It does **not** own:

- The entities the documents describe — listings, products, suppliers, needs, etc. belong to the
  business modules that create them.
- Template bodies or rendering — a future template service owns those.
- AI providers or embeddings — K-13 AI Gateway owns the boundary to model providers. K-15 stores
  vectors if a caller supplies them, but does not generate them.
- Money, orders, payments or notifications — those belong to their own components.

### What it does not own, and who does

| Concern | Owner |
|---|---|
| Identity subjects, party kinds | **K-01 Identity** |
| Credentials, sessions, tokens | **K-02 Authentication** |
| The universal account | **K-03 Accounts** |
| Roles, grants, permission evaluation | **K-04 Permissions** |
| Every monetary amount, balance, credit | **K-10 Ledger foundation** |
| Orders, listings, products, offers, quotes, payments | **Business modules** |
| AI provider selection, model routing, embeddings | **K-13 AI Gateway** |
| Notification delivery | **K-14 Notifications** |
| Name, email, phone, address, avatar, preferences | **The account profile core — separate, undelivered work** |

The full list, with a reason for each, is `FOREIGN_FIELDS` in `registry.ts`, and
`tests/search-foundation.test.ts` asserts that every entry names a real owner rather than a label.

---

## 2. Public contract

```ts
new SearchService(repository)

index(request): Promise<{ document, deduplicated }>
query(request): Promise<{ queryId, results, total, hasMore }>
remove(request): Promise<{ removed, deduplicated }>
```

### Guarantees

| Guarantee | Meaning |
|---|---|
| Opaque identifiers | Every K-15 identifier is judged by the same opacity rule set as K-01, re-raised in K-15's vocabulary |
| Idempotent indexing | A retry with the same idempotency key returns the original document **only when the whole logical record matches** |
| Upsert by `documentId` | A document with the same `documentId` and different content updates the stored document; older versions are not returned by queries |
| Append-only query log | A query log row is written once and never changed |
| Query logging | Every non-deduplicated `query` writes a `query_log` row |
| Keyword full-text search | The PostgreSQL adapter uses a generated `tsv` column and `ts_rank_cd` for text relevance |
| Filter by owner, scope, language and attributes | Queries may narrow results by `ownerType`, `scope`, `language` and JSON attribute equality |
| Pagination | `limit` and `offset` pagination, default limit 20, maximum 100 |
| Determinism | The caller supplies every identifier and instant; this component reads no clock and generates no randomness |
| Immutability in the process | Every record crossing a boundary is deep-frozen and severed from the caller's objects |
| Outbox per mutating operation | `index` and `remove` each emit one K-08 event and one K-09 audit record; `query` emits one K-08 event and one K-09 audit record |
| Transaction composition | `PostgresSearchRepository.enlist(client)` opens a search write inside a transaction the caller already owns |

### Refusals

| Code | Refused because |
|---|---|
| `malformed-identifier` | Not 8–128 characters of `[A-Za-z0-9._:-]` starting alphanumeric |
| `natural-identifier` | An identifier looks like an email, telephone number, document number, IBAN, URL, domain or personal name |
| `secret-bearing-input` | An identifier names or looks like a credential |
| `malformed-instant` | The instant is not a real UTC instant |
| `foreign-concern` | The request carried a field owned by another component or an unrecognised field |
| `idempotency-key-reuse` | The key was already used for a *different* record |
| `duplicate-query-id` | A query id already exists with different content |
| `nested-transaction` | An enlisted write tried to issue transaction control |
| `malformed-record` | A stored row, or a candidate record, is the wrong runtime shape |

---

## 3. Domain model

### SearchDocument

| Field | Meaning |
|---|---|
| `documentId` | Caller-supplied opaque handle. Never a natural key |
| `ownerType` | Search vocabulary owner type, e.g. `listing`, `product`, `supplier`, `need`. Not a foreign key |
| `ownerId` | Opaque identifier of the owning entity in its own component |
| `scope` | `public`, `buyer` or `seller` |
| `language` | `en`, `si`, `ta` or another language code |
| `title` | Searchable title |
| `description` | Searchable description |
| `keywords` | Searchable keyword list |
| `attributes` | JSON object of structured facets |
| `vectors` | JSON object of optional embedding buckets |
| `ranking` | JSON object of static ranking signals |
| `createdAt` | Canonical UTC instant when the document was first indexed |
| `updatedAt` | Canonical UTC instant when this version was written |
| `idempotencyKey` | Stable across retries of one logical index request |

### SearchQueryLog

| Field | Meaning |
|---|---|
| `queryId` | Caller-supplied opaque handle |
| `queryText` | The text the caller searched for |
| `filters` | JSON object of supplied filters |
| `resultCount` | Number of results returned |
| `executedAt` | Canonical UTC instant when the query was executed |
| `correlationId` | Correlates the query with the caller's trace |
| `idempotencyKey` | Stable across retries of one logical query |

---

## 4. Immutability and mutability

Query logs are append-only. Documents are replaced whole by `documentId` on re-index and removed
outright by `remove`; there is no partial update, no soft-delete and no relink. This is enforced at
three layers: no such operation in the service or port, no `UPDATE` or `DELETE` path on
`query_log` in the adapter, and a `BEFORE UPDATE OR DELETE` trigger on `query_log` in migration 0021.

---

## 5. Dependencies

K-15 depends only on the platform substrate, K-08 Event Infrastructure and K-09 Audit Foundation. It
has no dependency on K-01 Identity, K-03 Accounts, any business module, any financial module, K-13 AI
Gateway or K-14 Notifications. To keep that boundary real, K-15 carries its own copy of the opacity
identifier rule set; the copy is required to stay character-for-character identical to K-01's copy by
`tests/migrations.test.ts`.

---

## 6. Outbox

`index` publishes:

- Event `search.indexed` with payload `document_id`, `owner_type`, `owner_id`, `scope`, `language`,
  `updated_at`, `idempotency_key`
- Audit action `search.indexed` with authority `business-authoritative` and the same evidence

`remove` publishes:

- Event `search.removed` with payload `document_id`, `removed_at`, `idempotency_key`
- Audit action `search.removed` with authority `business-authoritative` and the same evidence

`query` publishes:

- Event `search.performed` with payload `query_id`, `query_text`, `result_count`, `executed_at`,
  `correlation_id`
- Audit action `search.performed` with authority `business-authoritative` and the same evidence

---

## 7. Text search

For the first slice, the PostgreSQL adapter uses a generated `tsv` column combining `title`,
`description` and `keywords`, indexed with GIN. Queries use `plainto_tsquery('english', $queryText)`
and rank with `ts_rank_cd`. The in-memory adapter uses a simple substring score across the same
fields. Both are replaceable behind the repository port.

---

## 8. Verification

```bash
npm run verify                                 # everything, including the tests below
npm run check:migrations                       # the FND-002a contract over db/migrations
node --test tests/search-foundation.test.ts              # contract, refusals, outbox
node --test tests/search-foundation-repository.test.ts   # port conformance, adapter, module contract
npm run test:integration                       # live PostgreSQL; skips without a database
```
