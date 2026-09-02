/**
 * Machine-readable encoding of docs/MODULE_MAP.md.
 *
 * This file is the single source of truth for the boundary checks in
 * platform/checks/boundaries.ts. When MODULE_MAP.md changes, this file changes with it — they
 * are two representations of one decision, and tests/manifest.test.ts asserts the structural
 * invariants that keep them honest.
 *
 * Owned by: FND-001b (platform substrate). Describes the architecture; contains no business
 * logic and no runtime behaviour beyond that description.
 */

/** Top-level source roots of the modular monolith (MODULE_MAP.md §2). */
export type Zone = 'platform' | 'kernel' | 'design-system' | 'module' | 'app';

/** Business-module layers L1–L8 (MODULE_MAP.md §4). */
export type ModuleLayer = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8';

export interface KernelComponent {
  readonly id: string;
  readonly name: string;
  /** Directory slug under /kernel. */
  readonly dir: string;
}

export interface BusinessModule {
  readonly id: string;
  readonly name: string;
  /** Directory slug under /modules. */
  readonly dir: string;
  readonly layer: ModuleLayer;
}

/**
 * Depth ordering used by the layer-direction check. A unit may import only units of strictly
 * lower depth, plus the universally importable zones (MODULE_MAP.md §10.1–10.3).
 */
export const ZONE_DEPTH = {
  platform: 0,
  kernel: 1,
  'design-system': 2,
} as const;

export const MODULE_LAYER_DEPTH: Readonly<Record<ModuleLayer, number>> = {
  L1: 3,
  L2: 4,
  L3: 5,
  L4: 6,
  L5: 7,
  L6: 8,
  L7: 9,
  L8: 10,
};

export const APP_DEPTH = 11;

/**
 * The applications: assemblies of modules, above every layer.
 *
 * Registered here because an application legitimately **owns** things the kernel validates — an
 * event subscription, above all. The consumers that join two modules of the same layer cannot live
 * in either module, so they live in an application, and K-08 refuses a subscription whose owner it
 * cannot find in this file. Until this list existed those two subscriptions could be written but
 * never registered, which is exactly as useful as not writing them.
 *
 * An application is an id here and nothing more. It owns no schema and no migration: everything it
 * persists belongs to a module.
 */
export const APPLICATIONS: readonly string[] = ['apps/api'];

/** The 15 commerce kernel components (MODULE_MAP.md §3). */
export const KERNEL_COMPONENTS: readonly KernelComponent[] = [
  { id: 'K-01', name: 'Identity', dir: 'identity' },
  { id: 'K-02', name: 'Authentication', dir: 'authentication' },
  { id: 'K-03', name: 'Accounts', dir: 'accounts' },
  { id: 'K-04', name: 'Permissions', dir: 'permissions' },
  { id: 'K-05', name: 'Configuration', dir: 'configuration' },
  { id: 'K-06', name: 'Policy Engine', dir: 'policy-engine' },
  { id: 'K-07', name: 'Feature Flags', dir: 'feature-flags' },
  { id: 'K-08', name: 'Event Infrastructure', dir: 'event-infrastructure' },
  { id: 'K-09', name: 'Audit Foundation', dir: 'audit-foundation' },
  { id: 'K-10', name: 'Ledger Foundation', dir: 'ledger-foundation' },
  { id: 'K-11', name: 'Commerce Unit Registry', dir: 'commerce-unit-registry' },
  { id: 'K-12', name: 'Conversation Foundation', dir: 'conversation-foundation' },
  { id: 'K-13', name: 'AI Gateway', dir: 'ai-gateway' },
  { id: 'K-14', name: 'Notifications', dir: 'notifications' },
  { id: 'K-15', name: 'Search Foundation', dir: 'search-foundation' },
];

/** The independently owned business modules (MODULE_MAP.md §4). */
export const BUSINESS_MODULES: readonly BusinessModule[] = [
  { id: 'M-01', name: 'Universal Account', dir: 'universal-account', layer: 'L1' },
  { id: 'M-02', name: 'Capability & Verification', dir: 'capability-verification', layer: 'L1' },
  { id: 'M-03', name: 'Item / Commerce Request', dir: 'commerce-request', layer: 'L2' },
  { id: 'M-04', name: 'Universal Listing', dir: 'universal-listing', layer: 'L2' },
  { id: 'M-05', name: 'Product Catalog', dir: 'product-catalog', layer: 'L2' },
  { id: 'M-06', name: 'Search & Discovery', dir: 'search-discovery', layer: 'L3' },
  { id: 'M-07', name: 'Matching', dir: 'matching', layer: 'L3' },
  { id: 'M-08', name: 'Offers', dir: 'offers', layer: 'L4' },
  { id: 'M-09', name: 'RFQ / Reverse Marketplace', dir: 'rfq', layer: 'L4' },
  { id: 'M-10', name: 'Quotes', dir: 'quotes', layer: 'L4' },
  { id: 'M-11', name: 'Orders', dir: 'orders', layer: 'L5' },
  { id: 'M-12', name: 'Payments', dir: 'payments', layer: 'L5' },
  { id: 'M-13', name: 'Financial Ledger', dir: 'financial-ledger', layer: 'L5' },
  { id: 'M-14', name: 'Commission Rules', dir: 'commission-rules', layer: 'L5' },
  { id: 'M-15', name: 'Settlements', dir: 'settlements', layer: 'L6' },
  { id: 'M-16', name: 'Seller Payouts', dir: 'seller-payouts', layer: 'L6' },
  { id: 'M-17', name: 'Seller Risk', dir: 'seller-risk', layer: 'L6' },
  { id: 'M-18', name: 'Listing Risk / Trust & Safety', dir: 'listing-risk', layer: 'L6' },
  { id: 'M-19', name: 'Logistics', dir: 'logistics', layer: 'L7' },
  { id: 'M-20', name: 'Returns', dir: 'returns', layer: 'L7' },
  { id: 'M-21', name: 'Disputes', dir: 'disputes', layer: 'L7' },
  {
    id: 'M-22',
    name: 'Warranty / Buyer Protection',
    dir: 'warranty-buyer-protection',
    layer: 'L7',
  },
  { id: 'M-23', name: 'Accommodation', dir: 'accommodation', layer: 'L8' },
  { id: 'M-24', name: 'Services', dir: 'services', layer: 'L8' },
  { id: 'M-25', name: 'Used Goods Risk Pack', dir: 'used-goods-risk-pack', layer: 'L8' },
  { id: 'M-26', name: 'Vehicle Risk Pack', dir: 'vehicle-risk-pack', layer: 'L8' },
  { id: 'M-27', name: 'Fashion / Luxury Risk Pack', dir: 'fashion-luxury-risk-pack', layer: 'L8' },
  { id: 'M-28', name: 'Rewards', dir: 'rewards', layer: 'L8' },
  { id: 'M-29', name: 'Referrals', dir: 'referrals', layer: 'L8' },
  { id: 'M-30', name: 'Attribution', dir: 'attribution', layer: 'L8' },
  { id: 'M-31', name: 'Budgeting', dir: 'budgeting', layer: 'L8' },
  { id: 'M-32', name: 'User Intelligence', dir: 'user-intelligence', layer: 'L8' },
  {
    id: 'M-33',
    name: 'Seller Market Intelligence',
    dir: 'seller-market-intelligence',
    layer: 'L8',
  },
  {
    id: 'M-34',
    name: 'Finance Provider Marketplace',
    dir: 'finance-provider-marketplace',
    layer: 'L8',
  },
  { id: 'M-35', name: 'Conversation Supervision', dir: 'conversation-supervision', layer: 'L8' },
  { id: 'M-36', name: 'User Cockpit', dir: 'user-cockpit', layer: 'L8' },
  { id: 'M-37', name: 'Seller Cockpit', dir: 'seller-cockpit', layer: 'L8' },
  { id: 'M-38', name: 'Operations Cockpit', dir: 'operations-cockpit', layer: 'L8' },
  { id: 'M-39', name: 'AI Model Registry', dir: 'ai-model-registry', layer: 'L8' },
  { id: 'M-40', name: 'AI Routing / Control Plane', dir: 'ai-routing', layer: 'L8' },
  { id: 'M-41', name: 'AI Decision Audit', dir: 'ai-decision-audit', layer: 'L8' },
  { id: 'M-42', name: 'AI Monitoring', dir: 'ai-monitoring', layer: 'L8' },
  { id: 'M-43', name: 'Policy / Configuration Studio', dir: 'policy-studio', layer: 'L8' },
  { id: 'M-44', name: 'Feature Flags / Rollouts UI', dir: 'feature-flags-ui', layer: 'L8' },
  { id: 'M-45', name: 'Analytics / Platform Intelligence', dir: 'analytics', layer: 'L8' },
  { id: 'M-46', name: 'Admin Audit', dir: 'admin-audit', layer: 'L8' },
  { id: 'M-47', name: 'Module Registry / Health', dir: 'module-registry', layer: 'L8' },
  /**
   * The 48th, added after the sourcing ladder was built and had nothing to search.
   *
   * M-07's two supplier rungs read a directory of who supplies what, where, and how well it has
   * gone before. Nothing in the original 47 owned that. M-01 owns which **roles** an account holds
   * and M-02 owns whether it has been **verified**; neither is a trading profile, and putting
   * categories, service areas and capacity into either would make an L1 identity component
   * responsible for what a business sells. So it is its own module, at L2 with the other commerce
   * primitives, depending on M-05 for the category and brand vocabularies.
   */
  { id: 'M-48', name: 'Supplier & Merchant Directory', dir: 'supplier-directory', layer: 'L2' },

  /**
   * M-49 exists because every commercial record in this platform names an **account**, and until it
   * existed that account was always a person's. That is true of a sole trader and false of every
   * business with two people in it: the first shop that wants somebody to answer tenders while
   * somebody else keeps the stock has nowhere to put the second person.
   *
   * It sits at **L1**, with the identity components, because a membership is about *who somebody
   * is to a business* rather than about what the business sells — and because M-48 at L2 and every
   * commerce module above it must be able to belong to an organisation without importing one.
   *
   * An organisation is a K-03 account of its own, so nothing above this module changes: a listing,
   * an order and a wallet already name an account, and now that account can be a business.
   */
  { id: 'M-49', name: 'Organisations', dir: 'organisations', layer: 'L1' },
];

/** K-13. The sole permitted boundary to model providers (MODULE_MAP.md §12, rule A-1). */
export const AI_GATEWAY_PATH = 'kernel/ai-gateway';

/**
 * Deterministic financial authority zone (MODULE_MAP.md §11).
 *
 * Entries are repo-relative path prefixes rather than whole modules, so the Rewards entry can
 * name the ledger core specifically — which is what §11 places in the zone — instead of
 * restricting all of M-28.
 */
export const FINANCIAL_ZONE_PREFIXES: readonly string[] = [
  'kernel/ledger-foundation',
  'modules/orders',
  'modules/payments',
  'modules/financial-ledger',
  'modules/commission-rules',
  'modules/settlements',
  'modules/seller-payouts',
  'modules/rewards/ledger',
];

/**
 * Package names that constitute a model-provider SDK. Only AI_GATEWAY_PATH may import these
 * (MODULE_MAP.md §12, rule A-1). Extend this list when a provider is adopted — an unlisted
 * provider is an unenforced provider.
 */
export const PROVIDER_PACKAGES: readonly string[] = [
  'openai',
  'cohere-ai',
  'groq-sdk',
  'replicate',
  'ollama',
  'deepseek',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@google/genai',
  '@google-cloud/aiplatform',
  '@azure/openai',
  '@aws-sdk/client-bedrock-runtime',
  '@mistralai/mistralai',
  '@huggingface/inference',
];

/** Scopes treated as provider SDKs regardless of the package leaf name. */
export const PROVIDER_SCOPES: readonly string[] = [
  '@anthropic-ai/',
  '@mistralai/',
  '@huggingface/',
];

export const KERNEL_DIRS: ReadonlySet<string> = new Set(KERNEL_COMPONENTS.map((c) => c.dir));

export const MODULE_BY_DIR: ReadonlyMap<string, BusinessModule> = new Map(
  BUSINESS_MODULES.map((m) => [m.dir, m]),
);

/** True when the specifier names a model-provider SDK, including a subpath import. */
export function isProviderPackage(specifier: string): boolean {
  if (PROVIDER_SCOPES.some((scope) => specifier.startsWith(scope))) return true;
  return PROVIDER_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
}

/** True when a repo-relative path sits inside the deterministic financial authority zone. */
export function isInFinancialZone(repoRelativePath: string): boolean {
  return FINANCIAL_ZONE_PREFIXES.some(
    (prefix) => repoRelativePath === prefix || repoRelativePath.startsWith(`${prefix}/`),
  );
}
