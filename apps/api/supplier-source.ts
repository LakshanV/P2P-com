/**
 * M-48, M-02 and M-11 as the supplier directory M-07's two middle rungs search.
 *
 * M-07 declares what it needs — a `SupplierProfile` with categories, capabilities, districts,
 * whether the party is verified, how reliably they have delivered, and what this buyer has bought
 * from them — and says nothing about where those facts live. They live in **three different
 * modules**, and that is precisely why this adapter is in `apps/`: M-48 holds what a supplier
 * claims, M-02 decides whether they are verified, and M-11 knows what was actually traded. Those
 * three are the same layer or below, they may not import one another, and the join belongs to the
 * application that deploys all three.
 *
 * **The separation this file exists to keep.** M-48 holds *claims*: a supplier saying they deal in
 * cement. M-02 and M-11 hold *facts*: somebody checked their licence, somebody paid them and the
 * order completed. The directory has no column for either and may never have one, because a copy
 * of a fact is the stale answer somebody sources against. So the claims are read from M-48 and the
 * facts are fetched alongside, per call, from the modules that own them.
 *
 * **The two rungs ask different questions, so this adapter runs two different queries.**
 * `findKnownSuppliers` starts from what this buyer has actually bought and keeps only the sellers
 * who are still in the directory for a category this Need is about — evidence first, directory
 * second. `findVerifiedSuppliers` starts from the directory, gated on category, and keeps only
 * those M-02 has verified. Neither is the other with a flag: one is a history query and the other
 * is a directory query, and collapsing them would make the `known` rung return strangers.
 *
 * **A failure here must propagate.** M-07 distinguishes "I looked and there is nothing" from "I
 * could not look", and gets that distinction from whether these throw. Catching a database error
 * and returning an empty array would report an absence of suppliers that nobody established, and
 * would quietly escalate every Need to a tender the week the database was slow — the exact
 * behaviour the ladder exists to prevent, arriving silently.
 *
 * Owned by: apps/api.
 */

import type {
  SourcingQuery,
  SupplierDirectory,
  SupplierProfile,
} from '../../modules/matching/index.ts';
import { readNeed } from '../../modules/matching/index.ts';
import { compareVerificationLevels } from '../../modules/capability-verification/index.ts';
import type {
  CapabilityVerificationService,
  VerificationLevel,
} from '../../modules/capability-verification/index.ts';
import type { Order, OrderService } from '../../modules/orders/index.ts';
import type { DirectoryProfile, DirectoryService } from '../../modules/supplier-directory/index.ts';

/**
 * The three reads this adapter makes, each as the narrowest port that expresses it.
 *
 * Narrow on purpose. A join written against three whole services is a join that can quietly start
 * doing something else — placing an order, deciding a verification — and nothing in its signature
 * would say so. `DirectoryService`, `CapabilityVerificationService` and `OrderService` each satisfy
 * their port structurally, so the composition root passes them directly and no adapter sits in
 * between.
 */
export interface DirectoryReader {
  getSupplierForAccount: DirectoryService['getSupplierForAccount'];
  getProfile: DirectoryService['getProfile'];
  findSuppliers: DirectoryService['findSuppliers'];
}

export interface VerificationReader {
  currentLevel: CapabilityVerificationService['currentLevel'];
}

export interface TradeHistoryReader {
  listOrdersByBuyer: OrderService['listOrdersByBuyer'];
}

export interface SupplierSourceOptions {
  readonly directory: DirectoryReader;
  readonly verification: VerificationReader;
  readonly orders: TradeHistoryReader;
  /**
   * How many directory entries one recall step reads.
   *
   * Bounded because the rung scores everything it is given, and an unbounded recall would make a
   * broad category — `hardware` — score the whole platform on every Need.
   */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 200;

/**
 * The M-02 level at which a party counts as verified for the `verified` rung.
 *
 * Expressed as a **floor compared with M-02's own ordering** rather than as a list of level names,
 * so a level added to M-02 later lands on the correct side of this line by itself. A list would
 * silently exclude any new level, and the symptom — verified suppliers quietly missing from the
 * rung — is one nobody would notice until a tender went out that should not have.
 *
 * `standard` and not `basic`: basic is the level a party reaches by existing, and a `verified` rung
 * that accepted it would be the `known` rung with extra steps and a misleading name.
 */
const VERIFIED_FLOOR: VerificationLevel = 'standard';

/** Order statuses that count as prior trade. An abandoned draft is not a relationship. */
const TRADED_STATUSES: readonly string[] = Object.freeze(['completed']);

export function supplierDirectoryFor(options: SupplierSourceOptions): SupplierDirectory {
  return {
    findKnownSuppliers: (query) => findKnown(options, query),
    findVerifiedSuppliers: (query) => findVerified(options, query),
  };
}

/**
 * Suppliers this buyer has actually bought this kind of thing from.
 *
 * History first. The set starts as the sellers on this buyer's completed orders, which is a fact
 * nothing in a profile outranks, and the directory is then asked whether each of them is still an
 * active party dealing in a category this Need is about. A supplier who has left the platform, been
 * suspended, or stopped dealing in the category is not a candidate however well the last order went.
 */
async function findKnown(
  options: SupplierSourceOptions,
  query: SourcingQuery,
): Promise<readonly SupplierProfile[]> {
  const wanted = readNeed(query.structured);
  if (wanted.categories.length === 0) return [];

  const history = await options.orders.listOrdersByBuyer(query.accountId);
  const traded = tradeBySeller(history);
  if (traded.size === 0) return [];

  const profiles: SupplierProfile[] = [];
  for (const [sellerAccountId, record] of traded) {
    const entry = await options.directory.getSupplierForAccount(sellerAccountId);
    if (entry === null) continue;

    const profile = await options.directory.getProfile(entry.supplierId);
    if (profile === null) continue;

    // The gate, applied here as well as in the rung. Not redundant: without it a buyer with a long
    // history would have every past seller read from M-02 on every Need, and the rung would then
    // exclude nearly all of them.
    if (!sharesCategory(profile, wanted.categories)) continue;

    profiles.push(
      await toProfile(options, profile, {
        priorOrdersForBuyer: record.orders,
        lastSuppliedAt: record.lastAt,
      }),
    );
  }
  return profiles;
}

/**
 * Verified suppliers for the category, whether or not this buyer knows them.
 *
 * Directory first, because there is no history to start from. The query is gated on category by
 * M-48 itself — it refuses an ungated one — and the result is then narrowed to parties M-02 has
 * actually verified. The narrowing happens here rather than in the rung because it is a fact from
 * another module, and a rung that had to fetch it would be a rung that imports M-02.
 */
async function findVerified(
  options: SupplierSourceOptions,
  query: SourcingQuery,
): Promise<readonly SupplierProfile[]> {
  const wanted = readNeed(query.structured);
  // M-48 refuses a query with no category, and it is right to: "every supplier on the platform" is
  // the commercial map. A Need whose categories could not be read is not a reason to ask for it, so
  // this returns empty — the rung reports that it looked and found nobody, which is true.
  if (wanted.categories.length === 0) return [];

  const found = await options.directory.findSuppliers({
    categories: wanted.categories,
    // A Need that named no district asks for suppliers anywhere. M-48 treats an absent district
    // list as "no restriction" rather than as "nowhere", which is the same reading it applies to a
    // supplier who declared none.
    ...(wanted.district === null ? {} : { districts: [wanted.district] }),
    limit: options.limit ?? DEFAULT_LIMIT,
  });

  const profiles: SupplierProfile[] = [];
  for (const profile of found) {
    const built = await toProfile(options, profile, {
      priorOrdersForBuyer: 0,
      lastSuppliedAt: null,
    });
    // The rung refuses an unverified supplier that came back anyway, and this is what makes that
    // check meaningful rather than a formality: the flag is M-02's answer, read per call.
    if (!built.verified) continue;
    profiles.push(built);
  }
  return profiles;
}

interface TradeRecord {
  readonly orders: number;
  readonly lastAt: string | null;
}

/**
 * What this buyer has actually completed, per seller.
 *
 * Counted from completed orders only. A placed order is a promise and a cancelled one is a
 * disappointment; neither is evidence that this supplier delivers, and counting them would make the
 * strongest signal on the platform the easiest to fake.
 */
function tradeBySeller(orders: readonly Order[]): ReadonlyMap<string, TradeRecord> {
  const bySeller = new Map<string, TradeRecord>();
  for (const order of orders) {
    if (!TRADED_STATUSES.includes(order.status)) continue;
    const seller = order.sellerAccountId;
    const previous = bySeller.get(seller);
    const at = order.updatedAt;
    bySeller.set(seller, {
      orders: (previous?.orders ?? 0) + 1,
      lastAt: later(previous?.lastAt ?? null, at),
    });
  }
  return bySeller;
}

/**
 * The later of two instants, as text.
 *
 * Both are the canonical UTC form this platform stores, which is fixed-width and lexicographically
 * ordered, so a string comparison is the right one. Parsing them into `Date` would round to the
 * millisecond and is exactly what the platform's timestamp rules exist to avoid.
 */
function later(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return right > left ? right : left;
}

function sharesCategory(profile: DirectoryProfile, wanted: readonly string[]): boolean {
  const declared = new Set(profile.categories.map((one) => one.toLowerCase()));
  return wanted.some((one) => declared.has(one.toLowerCase()));
}

interface TradeFacts {
  readonly priorOrdersForBuyer: number;
  readonly lastSuppliedAt: string | null;
}

/**
 * A directory profile plus the two facts the directory does not own.
 *
 * `reliabilityPerMille` is **null** and deliberately so: a delivery record is computed from what
 * happened in M-11, and nothing computes it yet. Null is not zero — M-07 scores an unknown record
 * at 600 rather than at 0 precisely so a platform with no history is still joinable — and inventing
 * a number here would be worse than admitting there is none. **Recorded as a gap**: until a real
 * reliability figure exists, the reliability weight at both rungs is doing nothing.
 */
async function toProfile(
  options: SupplierSourceOptions,
  profile: DirectoryProfile,
  trade: TradeFacts,
): Promise<SupplierProfile> {
  const level = await options.verification.currentLevel(profile.entry.accountId);
  return {
    supplierAccountId: profile.entry.accountId,
    categories: profile.categories,
    capabilities: profile.capabilities,
    districts: profile.districts,
    brands: profile.brands,
    verified: compareVerificationLevels(level, VERIFIED_FLOOR) >= 0,
    status: profile.entry.status,
    reliabilityPerMille: null,
    priorOrdersForBuyer: trade.priorOrdersForBuyer,
    lastSuppliedAt: trade.lastSuppliedAt,
  };
}
