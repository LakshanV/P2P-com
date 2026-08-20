# /kernel — the commerce kernel

The 15 kernel components defined in [`docs/MODULE_MAP.md`](../docs/MODULE_MAP.md) §3. One
directory per component, named by the `dir` slug registered in
[`platform/architecture/manifest.ts`](../platform/architecture/manifest.ts).

## What is implemented

**Eight components have implemented foundations, and build step B-2 is now covered.** K-05 and K-08
are B-1; K-01, K-02, K-03, K-04, K-07 and K-09 are B-2, and K-07 was the last of them unstarted. The kernel's internal chain is `K-01 → K-02/K-03 → K-04`, and **every
link of it now exists**: K-02 and K-03 each ask K-01 through its public contract whether the subject
they are about to act for exists, and K-04 asks K-02 who is asking and K-03 which account they hold.
What the chain still lacks is a caller — nothing outside the tests traverses it.

| Component | Directory | Contract | What exists |
|---|---|---|---|
| **K-01 Identity** | `identity/` | [`identity/CONTRACT.md`](./identity/CONTRACT.md) | Stable opaque internal handles for parties: a closed three-kind registry, caller-supplied ids and canonical UTC instants, immutable write-once creation records, exact idempotent retry with concurrent convergence, and deterministic lookup by id. Natural- and PII-shaped identifiers, credentials, AI-authored identities and any field belonging to K-02/K-03/K-04 are refused by name. Delivered by FND-004a. |
| **K-02 Authentication** | `authentication/` | [`authentication/CONTRACT.md`](./authentication/CONTRACT.md) | Authentication by *asking an injected verifier and checking its answer* — a request that states an outcome is refused by name. Append-only bindings and evidence, an assertion consumed exactly once, factor categories and assurance with a per-provider MFA floor that may be raised and never lowered, and sessions whose secret is presented once and stored only as a SHA-256. Absolute and idle expiry, guarded rotation and revocation where a stale caller loses rather than clobbering, and exact-idempotency convergence that hands a retry a spent token. **No verifier ships**, so nothing here can authenticate a real person yet. Delivered by FND-004c. |
| **K-03 Accounts** | `accounts/` | [`accounts/CONTRACT.md`](./accounts/CONTRACT.md) | One universal account per K-01 subject, and nothing else: no capability, role, verification level, profile field, credential or balance — each is refused by name with the component that owns it. Immutable subject linkage, exact idempotent retry with concurrent convergence, and a one-account-per-subject invariant enforced in the service, the reference repository and a `UNIQUE` constraint. The K-01 dependency is an injected lookup, with no foreign key or SQL reaching `kernel_identity`. Delivered by FND-004b. |
| **K-04 Permissions** | `permissions/` | [`permissions/CONTRACT.md`](./permissions/CONTRACT.md) | A deny-by-default authorisation core that **never asks the caller**: the subject comes from a K-02 session it re-checks itself, the account from K-03, and the authority from grants it stored. Immutable numbered policy versions, explicit allow and deny grants scoped to account, resource and action, deny precedence, temporal validity, append-only revocation, typed ABAC predicates over an allowlisted context, mandatory declared purpose for staff roles, and decision records carrying a deterministic explanation. `SUPER_ADMIN` confers nothing and `AI_AGENT` may hold only explicitly granted tool capabilities. **Nothing calls it**, and no audit record or event follows a decision. Delivered by FND-004d. |
| **K-07 Feature Flags** | `feature-flags/` | [`feature-flags/CONTRACT.md`](./feature-flags/CONTRACT.md) | Deployment control, and **nothing else**: a flag key naming authority, money, an entitlement, an experiment or AI autonomy is refused at publication, with the component that owns that decision named in the refusal. Immutable numbered definitions, a guarded append-only activation chain, an emergency kill switch that outranks every version, bounded activation windows, hierarchical supported scopes, deterministic percentage rollout over a hashed opaque subject key, and allowlisted typed targeting. Every uncertainty fails closed to *off*. Evaluation is pure and records nothing; administration is gated by an injected authority that **defaults to refusing**. **Nothing evaluates a flag**, and no audit record or event follows a kill. Delivered by FND-004e. |
| **K-05 Configuration** | `configuration/` | [`configuration/CONTRACT.md`](./configuration/CONTRACT.md) | Registered keys with explicit value schemas, immutable versions, draft-to-active lifecycle, effective-time resolution, optimistic concurrency, content-matched idempotent publication, scoped overrides, decision pinning. Delivered by FND-003a. |
| **K-08 Event Infrastructure** | `event-infrastructure/` | [`event-infrastructure/CONTRACT.md`](./event-infrastructure/CONTRACT.md) | Versioned event-type and subscription registries, an append-only log, at-least-once delivery with consumer receipts, deterministic bounded retry, terminal dead-lettering, operator-explicit replay, and an append path a caller can enlist in its own transaction. Delivered by FND-003b. |
| **K-09 Audit Foundation** | `audit-foundation/` | [`audit-foundation/CONTRACT.md`](./audit-foundation/CONTRACT.md) | An immutable audit-record contract with a registered action set, classified structured evidence, content fingerprinting, idempotent recording, and deterministic filtered retrieval with stable pagination. No update or delete exists at any layer, and the migration refuses both by trigger. Delivered by FND-003c. |

Each has an injected repository port with an in-memory reference implementation and a PostgreSQL
adapter, and each owns exactly one schema, derived from the manifest.

## What those foundations are not

A foundation is not a finished component, and the distinction is load-bearing — a reader who
mistakes one for the other will build on a guarantee that does not exist yet.

| Deferred | For all seven | Where it bites hardest |
|---|---|---|
| Administrative API and UI | An endpoint that changes configuration, publishes an event or creates an identity with nothing in front of it is a hole, not a feature. K-02 and K-04 now exist — but K-02 ships **no verifier**, so no real person can authenticate, and **nothing calls K-04**, so no path is actually guarded | K-01: an unauthenticated identity-creation endpoint is a way to fill the party table with anything |
| Enforced authority | Actors and authority levels are supplied by the caller and checked, never derived from a verified session. K-02 can issue and validate a session and K-04 can turn one into a decision — but **no unit asks either**, so every `origin` in this repository is still unverified | K-01's `origin` records who *says* they created a subject; nothing has verified it |
| Audit trail | There is nowhere the components themselves write who did what. **K-09** exists and none of the other six uses it | Creating an identity, opening an account and signing in are exactly the sort of actions K-09 was built to record, and none is |
| Real usage | **No module publishes or consumes an event, no unit records an audit record, no unit creates an identity subject or opens an account, no caller authenticates, and nothing asks K-04 whether it may act.** The event types, audit actions, verifiers and policies in the tests are fixtures | All six transaction-enlisted paths (K-01, K-02, K-03, K-04, K-08, K-09) exist as capabilities rather than integrations. K-02 → K-01, K-03 → K-01 and K-04 → K-02/K-03 are the exceptions that prove the point: real cross-component dependencies, exercised by tests, with no *caller* on any |
| Live execution | No schema has been applied to a running PostgreSQL server. No runtime is available to this repository, so all of the SQL is unproven | K-08's `FOR UPDATE SKIP LOCKED` claim, every write-once and append-only trigger, K-03's `UNIQUE (subject_id)` and K-04's purpose and AI constraints — the statements the central invariants rest on — have never executed |

K-05 publishes no events, nothing records an audit record, no caller creates an identity or opens an
account, and no caller signs in. These are *deferred integrations* rather than missing dependencies:
the components exist, and wiring consumers to them is separate, undelivered work. The registration
path K-03 makes possible — a K-01 subject and a K-03 account created in one transaction through both
enlisted paths — is the obvious next one, and is undelivered. K-02's own gap is different in kind and
larger: it is a complete authentication component with **no verifier behind it**, so the first
provider adapter is what turns it from a contract into a login.

**The remaining 7 components are unbuilt**, and every one of them is build step B-3 or later:
with K-07 delivered, B-1 and B-2 are both covered. Their
status is tracked in
[`docs/MASTER_IMPLEMENTATION_CHECKLIST.md`](../docs/MASTER_IMPLEMENTATION_CHECKLIST.md) §B.

`tests/kernel-overview.test.ts` reads this file and fails if it drifts out of step with what is
actually on disk — a README that under-reports the kernel is how a component gets built twice.

## Rules enforced here

Two are checked by `npm run check:boundaries`:

- **Kernel purity.** A kernel component may import only other kernel components and
  `platform/`. It may never depend on a business module, the design system or an app. A kernel
  component that "needs" a business module is a misplaced business rule — move the rule out of
  the kernel (MODULE_MAP §10.6).
- **Registration.** A directory here that is absent from the architecture manifest fails the
  check, because its layer is unknown and its imports therefore cannot be verified.

`kernel/ai-gateway` (K-13) is the single component permitted to import a model-provider SDK.
