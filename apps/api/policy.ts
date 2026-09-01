/**
 * The first JAYA authorisation policy: what each role may do.
 *
 * K-04 holds no mapping from a role to an authority — deliberately, and its contract says so. What
 * a role means is **data**, published as a version, and this file is that data for V1. It lives in
 * `apps/` rather than in the kernel because it is a product decision about this platform, and a
 * different deployment of the same kernel would publish a different one.
 *
 * Three things this file is not.
 *
 * **It is not a grant.** Publishing a policy says "a CUSTOMER may read an order". It gives nobody
 * anything: somebody still has to be granted the role, scoped to their account, by an administrator
 * K-04 can name. A policy with every capability in it and no grants authorises nobody.
 *
 * **It is not derived from the route table.** It would be easy to walk `ACCESS_POLICY` and grant
 * every role every pair it contains, and the result would be a policy that automatically permits
 * whatever route somebody adds next. Authority is a decision. What *is* checked mechanically — by
 * `tests/api-access.test.ts` — is the other direction: that every pair the API serves is reachable
 * by at least one role, so no route is accidentally dead.
 *
 * **It is not the finished authority model.** The buyer/seller split below is real but coarse: a
 * seller's authority is over payments in their own account, which the object-level ownership check
 * enforces, rather than over "payments where they are the payee" as a condition inside the grant.
 * K-04 supports conditions; using them properly is backlog work and is recorded there rather than
 * pretended away here.
 *
 * Owned by: apps/api.
 */

import type { PublishPolicyRequest } from '../../kernel/permissions/index.ts';

/** One role's capabilities. */
export interface RoleCapabilities {
  readonly role: string;
  readonly capabilities: ReadonlyArray<{ readonly action: string; readonly resourceType: string }>;
}

/** Read the route inventory and, through it, the shape of the API. Held by everybody who signs in. */
const READS_THE_API: ReadonlyArray<{ action: string; resourceType: string }> = [
  { action: 'read', resourceType: 'configuration' },
  { action: 'read', resourceType: 'account' },
];

/**
 * The V1 roles.
 *
 * `CUSTOMER` is the person buying. They create orders and payments, hold wallets, and settle across
 * several kinds of value at once. They may **not** capture or refund: taking the money is the
 * seller's act, and a buyer who could refund themselves after a delivery would be a hole with a
 * business model.
 *
 * `SUPPLIER` is the party selling. They read and progress orders placed with them, and they capture
 * and refund. They cannot create an order or a payment on somebody else's behalf.
 *
 * `DRIVER` and `SERVICE_PROVIDER` are listed with the little they have today rather than left out,
 * so that adding logistics later means widening an entry that exists rather than discovering the
 * role was never published.
 */
export const JAYA_V1_ROLES: readonly RoleCapabilities[] = Object.freeze([
  {
    role: 'CUSTOMER',
    capabilities: Object.freeze([
      // A Need is the entry point of the product, so a customer creates, reads and corrects
      // their own. Nobody else reads one: a supplier sees a sourcing request derived from it,
      // never the words.
      { action: 'create', resourceType: 'commerce-request' },
      { action: 'read', resourceType: 'commerce-request' },
      { action: 'update', resourceType: 'commerce-request' },
      { action: 'create', resourceType: 'order' },
      { action: 'read', resourceType: 'order' },
      { action: 'update', resourceType: 'order' },
      { action: 'create', resourceType: 'payment' },
      { action: 'read', resourceType: 'payment' },
      // Authorising and cancelling their own payment. Capture and refund are the seller's.
      { action: 'update', resourceType: 'payment' },
      { action: 'create', resourceType: 'wallet' },
      { action: 'read', resourceType: 'wallet' },
      { action: 'update', resourceType: 'wallet' },
      { action: 'create', resourceType: 'value-plan' },
      { action: 'read', resourceType: 'value-plan' },
      { action: 'update', resourceType: 'value-plan' },
      ...READS_THE_API,
    ]),
  },
  {
    role: 'SUPPLIER',
    capabilities: Object.freeze([
      { action: 'read', resourceType: 'order' },
      { action: 'update', resourceType: 'order' },
      { action: 'read', resourceType: 'payment' },
      { action: 'capture', resourceType: 'payment' },
      { action: 'refund', resourceType: 'payment' },
      { action: 'read', resourceType: 'wallet' },
      { action: 'read', resourceType: 'value-plan' },
      ...READS_THE_API,
    ]),
  },
  {
    role: 'SERVICE_PROVIDER',
    capabilities: Object.freeze([
      { action: 'read', resourceType: 'order' },
      { action: 'update', resourceType: 'order' },
      ...READS_THE_API,
    ]),
  },
  {
    role: 'DRIVER',
    capabilities: Object.freeze([
      { action: 'read', resourceType: 'order' },
      { action: 'update', resourceType: 'order' },
      ...READS_THE_API,
    ]),
  },
  {
    role: 'SUPPORT',
    capabilities: Object.freeze([
      { action: 'read', resourceType: 'order' },
      { action: 'read', resourceType: 'payment' },
      { action: 'read', resourceType: 'conversation' },
      ...READS_THE_API,
    ]),
  },
  {
    role: 'FINANCE',
    capabilities: Object.freeze([
      { action: 'read', resourceType: 'ledger-entry' },
      { action: 'read', resourceType: 'wallet' },
      { action: 'read', resourceType: 'value-plan' },
      { action: 'read', resourceType: 'payment' },
      { action: 'approve', resourceType: 'payment' },
      ...READS_THE_API,
    ]),
  },
  {
    role: 'ADMIN',
    capabilities: Object.freeze([
      // Authority over authority, and nothing else. An ADMIN who could also read orders would be a
      // role that quietly grants itself whatever it likes and then uses it.
      { action: 'grant-permission', resourceType: 'permission' },
    ]),
  },
]);

/**
 * The publication request for the V1 policy.
 *
 * `policyVersionId` and `idempotencyKey` are supplied by the caller, because K-04 refuses to mint
 * either: an identifier the component invents is an identifier nobody outside it can converge on.
 */
export function jayaV1PolicyRequest(options: {
  readonly policyVersionId: string;
  readonly version: number;
  readonly idempotencyKey: string;
  /** The administrator publishing it. Omitted only for the very first, bootstrap publication. */
  readonly presentedToken?: string;
}): PublishPolicyRequest {
  const base = {
    policyVersionId: options.policyVersionId,
    version: options.version,
    roles: JAYA_V1_ROLES.map((entry) => ({
      role: entry.role,
      capabilities: [...entry.capabilities],
    })),
    idempotencyKey: options.idempotencyKey,
  } as PublishPolicyRequest;

  // Spelled as an absence rather than `presentedToken: undefined`, which K-04 reads as a caller who
  // meant to send one — and which is the difference between the bootstrap path and the ordinary one.
  return options.presentedToken === undefined
    ? base
    : { ...base, presentedToken: options.presentedToken, purpose: 'system-maintenance' };
}

/** Every capability any V1 role holds, as `action@resource-type`. Used by the coverage test. */
export function publishedCapabilities(): ReadonlySet<string> {
  const held = new Set<string>();
  for (const entry of JAYA_V1_ROLES) {
    for (const capability of entry.capabilities) {
      held.add(`${capability.action}@${capability.resourceType}`);
    }
  }
  return held;
}
