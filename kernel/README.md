# /kernel — the commerce kernel

The 15 kernel components defined in [`docs/MODULE_MAP.md`](../docs/MODULE_MAP.md) §3. One
directory per component, named by the `dir` slug registered in
[`platform/architecture/manifest.ts`](../platform/architecture/manifest.ts).

## What is implemented

**Four components have implemented foundations.** K-05 and K-08 are build step B-1; K-01 and K-09
are B-2. K-01 is the head of the kernel's internal dependency chain (`K-01 → K-02/K-03 → K-04`) and
depends on nothing but the platform substrate, which is why it was buildable next:

| Component | Directory | Contract | What exists |
|---|---|---|---|
| **K-01 Identity** | `identity/` | [`identity/CONTRACT.md`](./identity/CONTRACT.md) | Stable opaque internal handles for parties: a closed three-kind registry, caller-supplied ids and canonical UTC instants, immutable write-once creation records, exact idempotent retry with concurrent convergence, and deterministic lookup by id. Natural- and PII-shaped identifiers, credentials, AI-authored identities and any field belonging to K-02/K-03/K-04 are refused by name. Delivered by FND-004a. |
| **K-05 Configuration** | `configuration/` | [`configuration/CONTRACT.md`](./configuration/CONTRACT.md) | Registered keys with explicit value schemas, immutable versions, draft-to-active lifecycle, effective-time resolution, optimistic concurrency, content-matched idempotent publication, scoped overrides, decision pinning. Delivered by FND-003a. |
| **K-08 Event Infrastructure** | `event-infrastructure/` | [`event-infrastructure/CONTRACT.md`](./event-infrastructure/CONTRACT.md) | Versioned event-type and subscription registries, an append-only log, at-least-once delivery with consumer receipts, deterministic bounded retry, terminal dead-lettering, operator-explicit replay, and an append path a caller can enlist in its own transaction. Delivered by FND-003b. |
| **K-09 Audit Foundation** | `audit-foundation/` | [`audit-foundation/CONTRACT.md`](./audit-foundation/CONTRACT.md) | An immutable audit-record contract with a registered action set, classified structured evidence, content fingerprinting, idempotent recording, and deterministic filtered retrieval with stable pagination. No update or delete exists at any layer, and the migration refuses both by trigger. Delivered by FND-003c. |

Each has an injected repository port with an in-memory reference implementation and a PostgreSQL
adapter, and each owns exactly one schema, derived from the manifest.

## What those foundations are not

A foundation is not a finished component, and the distinction is load-bearing — a reader who
mistakes one for the other will build on a guarantee that does not exist yet.

| Deferred | For all four | Where it bites hardest |
|---|---|---|
| Administrative API and UI | An endpoint that changes configuration, publishes an event or creates an identity before **K-02** Authentication and **K-04** Permissions exist is a hole, not a feature | K-01: an unauthenticated identity-creation endpoint is a way to fill the party table with anything |
| Enforced authority | Actors and authority levels are supplied by the caller and checked, never derived from a verified session. **K-02** and **K-04** will supply them | K-01's `origin` records who *says* they created a subject; nothing has verified it |
| Audit trail | There is nowhere the components themselves write who did what. **K-09** exists and none of the other three uses it | Creating an identity is exactly the sort of action K-09 was built to record, and does not |
| Real usage | **No module publishes or consumes an event, no unit records an audit record, and no unit creates an identity subject.** The event types and audit actions in the tests are fixtures | All three transaction-enlisted paths (K-01, K-08, K-09) exist as capabilities rather than integrations |
| Live execution | No schema has been applied to a running PostgreSQL server. No runtime is available to this repository, so all of the SQL is unproven | K-08's `FOR UPDATE SKIP LOCKED` claim, and K-09's and K-01's write-once triggers — the most important statement in each — have never executed |

K-05 publishes no events, nothing records an audit record, and nothing creates an identity. These
are *deferred integrations* rather than missing dependencies: K-01, K-08 and K-09 exist, and wiring
consumers to them is separate, undelivered work. **K-03 Accounts will be K-01's first consumer**,
through the transaction-enlisted path, so an account and its subject commit together.

**The remaining 11 components are unbuilt**; build steps B-1 through B-3 populate them. Their
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
