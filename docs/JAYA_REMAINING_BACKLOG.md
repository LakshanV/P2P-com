# JAYA — Remaining Backlog

**Derived from** `JAYA_REQUIREMENTS_TRACEABILITY_MATRIX.md`, last reconciled at commit `e0b7761`.  
**Status:** this is the authoritative development backlog. Work proceeds down it in order unless the
owner says otherwise.

Struck-through rows are done and are **kept rather than deleted**, so the list stays a record of what
was decided as well as what remains. An item is struck only when it has named implementation files
and a named test that passes.

Complexity: **S** ≤ 1 slice · **M** 2–3 slices · **L** 4–8 slices · **XL** a module plus its schema,
adapter, contract suite and integration proof.

"Slice" means one vertical unit that leaves every gate green and is committed on its own — the unit
this repository has used throughout.

---

## Ordering principle

Three rules decide the order, in this precedence:

1. **Nothing user-facing is built on an open door.** Authentication and authorisation came first
   because every screen and every route built before them would have had to be revisited afterwards.
   That is now done; what remains of it is rate limiting and a durable credential store, which stay
   at the top for the same reason.
2. **Close the spine before widening it.** The transaction path exists in pieces that have never been
   joined. Joining them is cheaper than building the next module, and it is what turns proven
   mechanisms into a working product.
3. **Prefer work that unblocks several things** over work that finishes one.

---

## P0 — Blocking, in order

| # | Module | Requirement | Deps | Complexity | Parallel? | Deploy-blocking | UI-blocking | External dep | Notes |
|---|---|---|---|---|---|---|---|---|---|
| ~~1~~ | K-02 | ~~**A real authentication verifier**~~ | — | L | — | — | — | No | **DONE.** `kernel/authentication/verifiers/password-hash.ts` and `password-verifier.ts`: scrypt at OWASP interactive parameters, parameters stored with the hash, timing-safe comparison, decoy hash so an unknown account costs the same as a wrong password. 20 tests. The owner decision was not needed after all — a password needs no third party, and OTP or OIDC can still be added behind the same port |
| ~~2~~ | apps/api | ~~**Authenticate every request**~~ | — | M | — | — | — | No | **DONE.** `PipelineOptions.authorize` runs after routing and before every handler; `apps/api/access.ts` resolves the session through K-02 and the account through K-03 |
| ~~3~~ | apps/api + K-04 | ~~**Authorise every route**~~ | — | L | — | — | — | No | **DONE.** `apps/api/policy.ts` is the published V1 policy; `ACCESS_POLICY` is exhaustive and fails closed, with a test that makes an unguarded route a failing build. Closed AC-03, AC-04, AC-05 and AC-06. 18 tests in `tests/api-access.test.ts` |
| ~~3a~~ | apps/api | ~~**Verify webhook signatures**~~ | — | M | — | — | — | No | **DONE, and it was not on this list.** Found while doing #3: the route read `signatureVerified` out of the request body, so anybody could post a delivery claiming a payment had been captured. Now HMAC-SHA256 over the raw bytes with the timestamp inside the signed payload. Closed AC-12 |
| **4** | apps/api | **Rate limits** | — | M | Yes | **Yes** | No | No | **Now the first item, and more urgent than when it was written.** Sign-in is reachable and scrypt is expensive by design, so an unthrottled login endpoint is both a credential-stuffing surface and a way to exhaust the server with work that looks legitimate. Per-principal and per-IP; PostgreSQL is an adequate store at first |
| **4a** | K-02 | **A durable password credential store** | — | M | Yes | **Yes** | No | No | Passwords are in memory, so a restart locks everyone out; `main.ts` refuses to start in production because of it, with no acknowledgement flag. Needs a schema of its own — K-02's own migration promises that a dump of `kernel_authentication` yields nobody's credential, and that promise is worth keeping |
| 5 | platform/db | **Backup and restore, proven by a restore test** | — | M | Yes | **Yes** | No | No | An untested restore is not a backup. Script + a test that restores into a scratch database and reads a row back |
| 6 | — | **Consumer: `payment.captured` → `settleExternalLeg`** | — | S | Yes | No | No | No | **The single highest value item in this table.** Every piece exists; nothing joins them. Turns the mixed-value proof into a real settlement |
| 7 | M-11 + M-04 | **Reserve inventory when an order is placed** | — | M | Yes | No | No | No | Both sides exist and are integration tested; nothing calls across. Same shape as #6 |
| 8 | M-03 | **Need: free text, preserved verbatim** | — | XL | Yes | No | **Yes** | No | The entry point of the product. Append-only raw input, structured interpretation as a separate record so the original is never overwritten |
| 9 | M-05 | **Catalogue and category** | — | L | Yes | No | **Yes** | No | Unblocks search, matching and RFQ routing |
| 10 | M-07 | **Need → existing stock matching** | 8, 9 | L | No | No | No | No | First rung of the sourcing ladder. Consumes M-04 inventory, which exists |
| 11 | M-09 | **RFQ: private, bid, award** | 8, 9, O-01 | XL | No | No | **Yes** | No | Largest unbuilt area. G-01, G-05, G-06, G-11 |
| 12 | M-10 | **Quote → order** | 11 | M | No | No | No | No | M-11 is ready to receive it |
| 13 | O | **Supplier onboarding and categories** | 9 | L | Yes | No | **Yes** | No | RFQ has nobody to send to without it |

---

## P1 — Needed for a launchable V1

| # | Module | Requirement | Deps | Complexity | Parallel? | Deploy-blocking | UI-blocking | External |
|---|---|---|---|---|---|---|---|---|
| 14 | design-system | Component foundations, tokens, states | 3 | L | Yes | No | — | No |
| 15 | apps/web | Customer app: Need, order, pay, MY MONEY | 3, 8, 14 | XL | No | **Yes** | — | No |
| 16 | M-36 | Role-adaptive cockpit; NOW section | 3 | L | Yes | No | **Yes** | No |
| 17 | K-13 | One live model adapter behind the port | — | M | Yes | No | No | **Yes — API key** |
| 18 | M-03 + K-13 | Need Agent: structured interpretation, confidence, correction | 8, 17 | L | No | No | No | Yes |
| 19 | M-03 | Image Need: upload, storage, reference | 8, obj storage | L | Yes | No | Yes | Yes (storage) |
| 20 | C | Visual identification: OCR, brand/model, embeddings | 19, 17 | XL | No | No | No | Yes |
| 21 | M-06 | Search: index listings into K-15; structured search | 9 | M | Yes | No | Yes | No |
| 22 | M-19 | Logistics: requirement, driver, pickup, delivery, evidence | 12 | XL | Yes | No | Yes | No |
| 23 | M-14 | Commission rules, versioned by K-06 | — | L | Yes | No | No | No |
| 24 | M-15 | Settlements | 23 | L | No | No | No | No |
| 25 | M-16 | Seller payouts | 24 | L | No | No | Yes | Yes (payout rail) |
| 26 | M-29/M-30 | Introducer attribution and commission | 23 | L | Yes | No | Yes | No |
| 27 | M-38 | Operations control tower | 3 | XL | Yes | No | Yes | No |
| 28 | M-21 | Dispute workflow with evidence | 22 | L | Yes | No | Yes | No |
| 29 | M-17/M-18 | Risk and fraud flags | — | L | Yes | No | No | No |
| 30 | K-10/M-13 | Receivable and payable positions | — | M | Yes | No | Yes | No |
| 31 | M-13 | Restriction enforcement (K-27) | — | M | Yes | No | No | No |
| 32 | AB | Consent model, data export, deletion | 3 | L | Yes | **Yes** | Yes | No |
| 33 | AG | Staging, monitoring, runbook, smoke tests | 3 | L | Yes | **Yes** | No | Yes (infra) |
| 34 | platform | E2E harness and first journey test | 15 | M | No | No | No | No |
| 35 | N | Merchant platform | 9, 13 | XL | Yes | No | Yes | No |
| 36 | P | Member / break-bulk network | 22 | XL | Yes | No | Yes | No |
| 37 | M-24 | Services | 8 | L | Yes | No | Yes | No |
| 38 | M-37 | Seller cockpit | 13, 16 | L | Yes | No | Yes | No |
| 39 | K-14 | A live notification provider | — | M | Yes | No | No | **Yes** |
| 40 | M-31 | Financial wellbeing V1 (advisory, user-controlled) | 30 | XL | Yes | No | Yes | No |
| 41 | Y | Community credits: issuance and spending rules | 23 | L | Yes | No | Yes | No |
| 42 | Q | Wholesale layer over M-11 split | 11 | L | Yes | No | Yes | No |
| 43 | S/T | Demand intelligence and procurement V1 | 9, 21 | XL | Yes | No | Yes | No |

---

## P2 — Milestone 3, explicitly not V1

Listed so it is visible that nothing from V1 has been hidden here.

Advanced Demand Clouds and pooled community pricing · deep forecasting · autonomous procurement ·
AI glasses ingestion · browser assistant · route optimisation with multi-pickup, multi-drop and
consolidation · the remaining specialist agents beyond the first three or four · advanced
living-wage intelligence · external supplier discovery and lead acquisition · virtual inventory
graph · Singha and Yaanadiri connectors.

---

## Externally blocked — cannot proceed without the owner

| Item | Blocker | What is needed | Consequence today |
|---|---|---|---|
| Live payment gateway (J-20) | **BL-05** | Sandbox credentials for a Sri Lankan processor | Every capture succeeds against nothing. The platform can take an order and never take the money |
| CI (AG-13) | **BL-10** | Workflows permission on the repository credential | Every gate passes locally and none runs automatically |
| Live AI adapter (Z-03…Z-05) | — | An API key for Kimi, Claude or OpenAI | No model has ever been called; every AI capability is a mock |
| ~~Authentication method (AC-01)~~ | — | ~~A decision: password, OTP or OIDC~~ | **Resolved by building.** A password verifier needs no third party and no decision from anybody, so it shipped; OTP and OIDC remain available behind the same port whenever the owner wants them |
| Notification provider (39) | — | Email/SMS/WhatsApp credentials | Only the in-app provider ships |
| Object storage (19) | — | A bucket and credentials | No image, document or evidence can be stored |

---

## Milestones

### Milestone 1 — Transaction spine

Need → sourcing → RFQ → quote → order → payment → ledger → fulfilment → settlement.

**Items:** 1–13, plus 22 (fulfilment) and 23–24 (settlement).

**Already done and reusable:** order (H), payment (J), ledger and value routing (K, L), inventory
(I), the relay, the API substrate.

**Honest position:** the two ends are missing. Need and sourcing do not exist; settlement does not
exist. The middle — order, payment, ledger — is the strongest part of the repository and is proven
against a real database.

### Milestone 2 — Full launchable JAYA V1

Everything in P0 and P1: customer, merchant, supplier, member and introducer flows; logistics;
cockpit and financial cockpit; a working AI V1; risk and disputes; the control tower; a real UI;
security; deployment.

**Nothing that belongs in V1 has been deferred to Milestone 3.** The P2 list above is genuinely
advanced work.

### Milestone 3 — Advanced JAYA

The P2 list.

---

## The completion rule, from here

No item moves to done without:

- named implementation files, **and**
- a named test that passes.

For anything on the transaction spine, additionally an integration or E2E proof.

A README statement is not proof. An interface is not proof. A mock alone is not proof. A generated
test that has never passed is not proof. A statement by an agent — including me — is not proof.
