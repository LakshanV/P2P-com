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

/**
 * Merge capability sets, keeping one of each pair.
 *
 * K-04 refuses a role that lists the same capability twice — rightly, because a duplicate hides
 * which of the two was meant — and the organisation roles below are built by combining sets that
 * genuinely overlap: a business that both buys and sells reads tenders for two different reasons.
 * Deduplicating here keeps the sets readable as the jobs they describe.
 */
function combine(
  ...sets: ReadonlyArray<ReadonlyArray<{ action: string; resourceType: string }>>
): ReadonlyArray<{ action: string; resourceType: string }> {
  const seen = new Set<string>();
  const merged: Array<{ action: string; resourceType: string }> = [];
  for (const set of sets) {
    for (const capability of set) {
      const key = `${capability.action}@${capability.resourceType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(capability);
    }
  }
  return Object.freeze(merged);
}

/** Read the route inventory and, through it, the shape of the API. Held by everybody who signs in. */
const READS_THE_API: ReadonlyArray<{ action: string; resourceType: string }> = [
  { action: 'read', resourceType: 'configuration' },
  { action: 'read', resourceType: 'account' },
];

/**
 * Taking on another role on the same identity.
 *
 * An update to the caller's **own** account, held by the two trading roles so that the person who
 * bought cement last week can register their hardware shop this week without becoming a second
 * person. The handler refuses every role that is not self-assumable, so this does not let anybody
 * make themselves a driver or a member of staff.
 */
const TAKES_ON_A_ROLE: ReadonlyArray<{ action: string; resourceType: string }> = [
  { action: 'update', resourceType: 'account' },
];

/**
 * What a business does when it **sells**: answers tenders, and progresses the orders that follow.
 *
 * Held inside the organisation's account, so the object-level check still limits it to that
 * business's own tenders and orders. `withdraw` and never `decide`: a supplier who could decide
 * would accept their own offer.
 */
const BUSINESS_SELLS: ReadonlyArray<{ action: string; resourceType: string }> = [
  { action: 'create', resourceType: 'supplier-directory-entry' },
  { action: 'read', resourceType: 'supplier-directory-entry' },
  { action: 'update', resourceType: 'supplier-directory-entry' },
  { action: 'read', resourceType: 'rfq' },
  { action: 'quote', resourceType: 'rfq' },
  { action: 'read', resourceType: 'quote' },
  { action: 'withdraw', resourceType: 'quote' },
  { action: 'read', resourceType: 'order' },
  { action: 'update', resourceType: 'order' },
  ...READS_THE_API,
];

/**
 * What a business does when it **buys**: states Needs, opens tenders, chooses between offers.
 *
 * A business is a customer too, and this is why: the shop that sells cement also buys pallets, and
 * a platform that made it register twice to do both would be a platform with two of every shop.
 */
const BUSINESS_BUYS: ReadonlyArray<{ action: string; resourceType: string }> = [
  { action: 'create', resourceType: 'commerce-request' },
  { action: 'read', resourceType: 'commerce-request' },
  { action: 'update', resourceType: 'commerce-request' },
  { action: 'read', resourceType: 'sourcing-run' },
  { action: 'create', resourceType: 'rfq' },
  { action: 'read', resourceType: 'rfq' },
  { action: 'update', resourceType: 'rfq' },
  { action: 'read', resourceType: 'quote' },
  { action: 'decide', resourceType: 'quote' },
  { action: 'create', resourceType: 'order' },
  { action: 'read', resourceType: 'order' },
  { action: 'update', resourceType: 'order' },
  ...READS_THE_API,
];

/** Taking money in, giving it back, and holding it. Deliberately separable from the two above. */
const BUSINESS_MONEY: ReadonlyArray<{ action: string; resourceType: string }> = [
  { action: 'create', resourceType: 'payment' },
  { action: 'read', resourceType: 'payment' },
  { action: 'update', resourceType: 'payment' },
  { action: 'capture', resourceType: 'payment' },
  { action: 'refund', resourceType: 'payment' },
  { action: 'create', resourceType: 'wallet' },
  { action: 'read', resourceType: 'wallet' },
  { action: 'update', resourceType: 'wallet' },
  { action: 'create', resourceType: 'value-plan' },
  { action: 'read', resourceType: 'value-plan' },
  { action: 'update', resourceType: 'value-plan' },
  ...READS_THE_API,
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
      // Reading a sourcing run is reading what the platform tried on their behalf. There is no
      // create: a run is started by sourcing a Need, which is an update to the Need.
      { action: 'read', resourceType: 'sourcing-run' },
      // Registering to trade, and looking somebody up to buy from. A customer holds this because
      // one identity holds several roles: the person who bought cement last week is the person who
      // registers their own hardware shop this week, and making them a different account would
      // split their history in two. `admit` is deliberately absent — see OPERATIONS.
      { action: 'create', resourceType: 'supplier-directory-entry' },
      { action: 'read', resourceType: 'supplier-directory-entry' },
      { action: 'update', resourceType: 'supplier-directory-entry' },
      // A tender is opened by the buyer, and only when the ladder could not answer.
      { action: 'create', resourceType: 'rfq' },
      { action: 'read', resourceType: 'rfq' },
      { action: 'update', resourceType: 'rfq' },
      // Reading the offers, and choosing between them. A customer never makes one, and never
      // withdraws one: both are the supplier's acts, and separate verbs are what keep them so.
      { action: 'read', resourceType: 'quote' },
      { action: 'decide', resourceType: 'quote' },
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
      ...TAKES_ON_A_ROLE,
      ...READS_THE_API,
    ]),
  },
  {
    role: 'SUPPLIER',
    capabilities: Object.freeze([
      // A tender they were invited to, and their own offers against it. `read rfq` is what makes an
      // invitation answerable; the object-level check limits it to tenders they were invited to,
      // and the handlers limit what they see of one to the requirement rather than the bidding.
      //
      // Their own directory entry comes first: what they deal in, where they trade from, whether
      // they are open this week. Not `admit`, which is why registering does not put them in the
      // market.
      { action: 'create', resourceType: 'supplier-directory-entry' },
      { action: 'read', resourceType: 'supplier-directory-entry' },
      { action: 'update', resourceType: 'supplier-directory-entry' },
      { action: 'read', resourceType: 'rfq' },
      { action: 'quote', resourceType: 'rfq' },
      { action: 'read', resourceType: 'quote' },
      // Withdrawing their own offer, and **not** deciding. A supplier who held `decide` could
      // accept their own offer, which is awarding themselves the order; M-10 refuses that too, and
      // the point of two verbs is that both layers do.
      { action: 'withdraw', resourceType: 'quote' },
      { action: 'read', resourceType: 'order' },
      { action: 'update', resourceType: 'order' },
      { action: 'read', resourceType: 'payment' },
      { action: 'capture', resourceType: 'payment' },
      { action: 'refund', resourceType: 'payment' },
      // A supplier holds earnings, so a supplier opens the wallet that holds them. Nobody else
      // can: the owner of a wallet is now the caller, so a wallet a supplier does not open is a
      // wallet that does not exist -- and a settlement with nowhere to land fails at the moment the
      // money should arrive.
      { action: 'create', resourceType: 'wallet' },
      { action: 'read', resourceType: 'wallet' },
      { action: 'read', resourceType: 'value-plan' },
      ...TAKES_ON_A_ROLE,
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
    // Who lets a party into the market, and who takes them out of it.
    //
    // `OPERATIONS` from K-04's role vocabulary, holding `admit` and nothing else that matters,
    // because the alternative shapes are both worse. Letting a supplier admit themselves makes
    // "registration is not activation" a comment rather than a rule, and the first tender would go
    // to whoever registered fastest. Giving it to ADMIN would put market admission next to
    // authority over authority, so the person who onboards a hardware shop could also grant
    // themselves anything.
    //
    // It is a **staff role**, so K-04 requires a purpose on every grant of it. That is the right
    // property: somebody admitting a business to the market is acting on another party's record,
    // and "why" belongs in the audit trail.
    //
    // It cannot read an order, a payment or a wallet. Somebody deciding whether a business may
    // trade does not need to see what anybody bought.
    role: 'OPERATIONS',
    capabilities: Object.freeze([
      { action: 'read', resourceType: 'supplier-directory-entry' },
      { action: 'admit', resourceType: 'supplier-directory-entry' },
      ...READS_THE_API,
    ]),
  },
  // ---------------------------------------------------------------------------
  // Organisation roles (D-053). What somebody does **for a business**, held in that business's own
  // account, and conferred by a membership rather than by anybody's say-so.
  //
  // Every one of these is evaluated inside the organisation's account, so the object-level
  // ownership check still applies on top: an ORG_SALES member of one business reaches that
  // business's tenders and nobody else's. The split between them is the ordinary one a business
  // makes — who quotes, who buys, who keeps the stock, who handles the money — and it exists so
  // that giving somebody the job of answering tenders does not also give them the bank details.
  // ---------------------------------------------------------------------------
  {
    // Runs the business. Everything it does, which is the point of ownership.
    role: 'ORG_OWNER',
    capabilities: combine(BUSINESS_SELLS, BUSINESS_BUYS, BUSINESS_MONEY),
  },
  {
    // Runs the business day to day. The same as an owner here, because the difference between them
    // is authority over *the business itself* — who may be a member, who may be an owner — and that
    // lives in M-49's membership rules rather than in a K-04 capability.
    role: 'ORG_ADMIN',
    capabilities: combine(BUSINESS_SELLS, BUSINESS_BUYS, BUSINESS_MONEY),
  },
  {
    // Runs the commercial side without the money.
    role: 'ORG_MANAGER',
    capabilities: combine(BUSINESS_SELLS, BUSINESS_BUYS),
  },
  {
    // Answers tenders. Cannot buy, cannot capture money, cannot change the directory entry.
    role: 'ORG_SALES',
    capabilities: combine(BUSINESS_SELLS),
  },
  {
    // Buys for the business: states Needs, opens tenders, chooses between offers.
    role: 'ORG_PROCUREMENT',
    capabilities: combine(BUSINESS_BUYS),
  },
  {
    // Keeps the stock and what the business says it deals in.
    role: 'ORG_INVENTORY',
    capabilities: Object.freeze([
      { action: 'read', resourceType: 'supplier-directory-entry' },
      { action: 'update', resourceType: 'supplier-directory-entry' },
      { action: 'read', resourceType: 'order' },
      { action: 'update', resourceType: 'order' },
      ...READS_THE_API,
    ]),
  },
  {
    // Handles the money, and nothing about what the business sells. Note that this is **not** the
    // platform's `FINANCE` role: this person reaches their own employer's books, which is why no
    // purpose is demanded of them and why the two are separate names.
    role: 'ORG_FINANCE',
    capabilities: combine(BUSINESS_MONEY, [{ action: 'read', resourceType: 'order' }]),
  },
  {
    // Gets orders out of the door.
    role: 'ORG_FULFILMENT',
    capabilities: Object.freeze([
      { action: 'read', resourceType: 'order' },
      { action: 'update', resourceType: 'order' },
      ...READS_THE_API,
    ]),
  },
  {
    // Will run the drivers, once logistics exists. Listed with the little it has rather than left
    // out, so adding logistics means widening an entry that exists rather than discovering the
    // role was never published.
    role: 'ORG_DRIVER_MANAGER',
    capabilities: Object.freeze([
      { action: 'read', resourceType: 'order' },
      { action: 'update', resourceType: 'order' },
      ...READS_THE_API,
    ]),
  },
  {
    // Sees what the business is doing and changes none of it. The role somebody gets while they are
    // being trained, or while somebody decides what they should actually do.
    role: 'ORG_READ_ONLY',
    capabilities: Object.freeze([
      { action: 'read', resourceType: 'supplier-directory-entry' },
      { action: 'read', resourceType: 'commerce-request' },
      { action: 'read', resourceType: 'sourcing-run' },
      { action: 'read', resourceType: 'rfq' },
      { action: 'read', resourceType: 'quote' },
      { action: 'read', resourceType: 'order' },
      { action: 'read', resourceType: 'payment' },
      { action: 'read', resourceType: 'wallet' },
      { action: 'read', resourceType: 'value-plan' },
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
