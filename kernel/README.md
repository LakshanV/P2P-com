# /kernel — the commerce kernel

The 15 kernel components defined in [`docs/MODULE_MAP.md`](../docs/MODULE_MAP.md) §3. One
directory per component, named by the `dir` slug registered in
[`platform/architecture/manifest.ts`](../platform/architecture/manifest.ts).

## What is implemented

**Three components have implemented foundations.** K-05 and K-08 are build step B-1; K-09 is
scheduled for B-2 but depends only on the platform substrate today, which is what made its
foundation buildable now:

| Component | Directory | Contract | What exists |
|---|---|---|---|
| **K-05 Configuration** | `configuration/` | [`configuration/CONTRACT.md`](./configuration/CONTRACT.md) | Registered keys with explicit value schemas, immutable versions, draft-to-active lifecycle, effective-time resolution, optimistic concurrency, content-matched idempotent publication, scoped overrides, decision pinning. Delivered by FND-003a. |
| **K-08 Event Infrastructure** | `event-infrastructure/` | [`event-infrastructure/CONTRACT.md`](./event-infrastructure/CONTRACT.md) | Versioned event-type and subscription registries, an append-only log, at-least-once delivery with consumer receipts, deterministic bounded retry, terminal dead-lettering, operator-explicit replay, and an append path a caller can enlist in its own transaction. Delivered by FND-003b. |
| **K-09 Audit Foundation** | `audit-foundation/` | [`audit-foundation/CONTRACT.md`](./audit-foundation/CONTRACT.md) | An immutable audit-record contract with a registered action set, classified structured evidence, content fingerprinting, idempotent recording, and deterministic filtered retrieval with stable pagination. No update or delete exists at any layer, and the migration refuses both by trigger. Delivered by FND-003c. |

Each has an injected repository port with an in-memory reference implementation and a PostgreSQL
adapter, and each owns exactly one schema, derived from the manifest.

## What those foundations are not

A foundation is not a finished component, and the distinction is load-bearing — a reader who
mistakes one for the other will build on a guarantee that does not exist yet.

| Deferred | For both | Specific to K-08 |
|---|---|---|
| Administrative API and UI | An endpoint that changes configuration or publishes an event before **K-02** Authentication and **K-04** Permissions exist is a hole, not a feature | — |
| Enforced authority | `authorityLevel` and `Actor` are supplied by the caller and checked. **K-04** will supply them from a session | — |
| Audit trail | Origin and publication instants are recorded, but there is nowhere durable to write who did what until **K-09** | Replay records its operator and reason on the delivery; nothing audits it |
| Real usage | — | **No module publishes or consumes an event, and no unit records an audit record.** The event types and audit actions in the tests are fixtures; K-08 has no producer and no consumer, and K-09 has no producer, so both transaction-enlisted paths exist as capabilities rather than integrations |
| Live execution | No schema has been applied to a running PostgreSQL server. No runtime is available to this repository, so all of the SQL is unproven | K-08's `FOR UPDATE SKIP LOCKED` claim statement and K-09's append-only trigger — the most important statement in each component — have never executed |

K-05 publishes no events, and nothing records an audit record. Both are *deferred integrations*
rather than missing dependencies: K-08 and K-09 exist, and wiring producers to them is separate,
undelivered work.

**The remaining 12 components are unbuilt**; build steps B-1 through B-3 populate them. Their
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
