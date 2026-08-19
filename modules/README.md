# /modules — independently owned business modules

The 47 business modules defined in [`docs/MODULE_MAP.md`](../docs/MODULE_MAP.md) §4, in layers
L1–L8. One directory per module, named by the `dir` slug registered in
[`platform/architecture/manifest.ts`](../platform/architecture/manifest.ts).

**Nothing here is implemented.** Build steps B-5 onward populate this directory.

A module owns its data, its API, its UI surfaces, its tests and its release. Enforced by
`npm run check:boundaries`:

- **Downward imports only.** A module may import the kernel, the design system, `platform/`,
  and modules in strictly lower layers. Same-layer modules communicate by event, never by
  direct call (MODULE_MAP §10.1–10.3).
- **Financial authority zone.** `orders`, `payments`, `financial-ledger`, `commission-rules`,
  `settlements`, `seller-payouts` and `rewards/ledger` may not import the AI Gateway. A
  violation is a **P0** defect and stops all progression (MODULE_MAP §11, rule F-1).

Not machine-checked yet, and still binding: no module may read or write another module's
tables — read through the owning module's public API, never by joining to it (§10.4).
