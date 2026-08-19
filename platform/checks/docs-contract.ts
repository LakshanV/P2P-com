/**
 * The contributor-documentation contract (FND-001d).
 *
 * docs/CONTRIBUTING.md is the only place that tells a new contributor which Node to install,
 * which command decides whether a change is acceptable, and which architectural rules are
 * machine-enforced. Documentation rots quietly: a section gets trimmed, a rule gets softened, a
 * command gets renamed in package.json and the doc keeps naming the old one. None of that fails
 * a build on its own.
 *
 * This module states the guarantees the document must keep, checked against the repository's own
 * facts rather than against a hardcoded copy of them — the expected Node version comes from
 * .nvmrc, the verification commands come from the `verify` script, the boundary check ids come
 * from platform/checks/boundaries.ts. So when the repository changes, the contract follows, and
 * the document is the thing that has to catch up.
 *
 * Owned by: FND-001d (contributor documentation). Describes documentation; contains no business
 * logic.
 */

/** Repo-relative path of the document under contract. */
export const CONTRIBUTING_PATH = 'docs/CONTRIBUTING.md';

export type DocsContractId =
  | 'prerequisites'
  | 'clean-clone'
  | 'toolchain-pins'
  | 'verification-commands'
  | 'boundary-checks'
  | 'planted-fixtures'
  | 'module-ownership'
  | 'dependency-rules'
  | 'financial-ai-prohibition'
  | 'provider-import-restriction'
  | 'secrets-handling'
  | 'atomic-changes'
  | 'review'
  | 'branch-conventions'
  | 'database'
  | 'link-integrity';

/** Every guarantee this module enforces. The tests assert none is left unexercised. */
export const DOCS_CONTRACT_IDS: readonly DocsContractId[] = [
  'prerequisites',
  'clean-clone',
  'toolchain-pins',
  'verification-commands',
  'boundary-checks',
  'planted-fixtures',
  'module-ownership',
  'dependency-rules',
  'financial-ai-prohibition',
  'provider-import-restriction',
  'secrets-handling',
  'atomic-changes',
  'review',
  'branch-conventions',
  'database',
  'link-integrity',
];

export interface DocsViolation {
  readonly id: DocsContractId;
  readonly message: string;
}

export interface DocsExpectations {
  /** Exact Node version from .nvmrc. */
  readonly nodeVersion: string;
  /** Exact npm version from package.json#packageManager. */
  readonly npmVersion: string;
  /** Minimum versions from engines, digits only (e.g. '22.18.0'). */
  readonly engineMinimums: readonly string[];
  /** Every command chained by the `verify` script, plus `npm run verify` itself. */
  readonly verificationCommands: readonly string[];
  /** Boundary check ids from platform/checks/boundaries.ts. */
  readonly checkIds: readonly string[];
  /** Fixture directory names under tests/fixtures. */
  readonly fixtureDirs: readonly string[];
  /** Financial-zone path prefixes from the architecture manifest. */
  readonly financialZonePrefixes: readonly string[];
  /** The single path permitted to import provider SDKs. */
  readonly aiGatewayPath: string;
  /** The repository's default branch. */
  readonly defaultBranch: string;
  /** Schema-name prefixes owned by kernel components and business modules. */
  readonly schemaPrefixes: readonly string[];
  /** The PostgreSQL schema no unit may use for its data. */
  readonly forbiddenSchema: string;
  /**
   * Resolve a relative link target (already stripped of its anchor) against the document's own
   * directory. Returns true when the target exists on disk.
   */
  readonly resolveLink: (target: string) => boolean;
}

/** Strip fenced code blocks so a command quoted in an example cannot satisfy a prose guarantee. */
const withoutFences = (text: string): string => {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n');
};

/** Relative markdown link targets, anchors stripped, external and pure-anchor links excluded. */
const relativeLinks = (text: string): string[] => {
  const targets: string[] = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let found: RegExpExecArray | null = pattern.exec(text);
  while (found !== null) {
    const raw = found[1] ?? '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith('#')) {
      const target = raw.split('#')[0] ?? '';
      if (target !== '') targets.push(target);
    }
    found = pattern.exec(text);
  }
  return targets;
};

/**
 * Check the contributor documentation against every guarantee. Returns one violation per broken
 * guarantee; an empty array means the contract holds.
 */
export function checkDocsContract(text: string, expected: DocsExpectations): DocsViolation[] {
  const violations: DocsViolation[] = [];
  const report = (id: DocsContractId, message: string): void => {
    violations.push({ id, message });
  };

  const prose = withoutFences(text);
  const has = (needle: string): boolean => text.includes(needle);
  const proseHas = (needle: string): boolean => prose.includes(needle);
  const mentionsAny = (needles: readonly string[]): boolean => needles.some((n) => has(n));

  const require_ = (id: DocsContractId, needle: string, why: string): void => {
    if (!has(needle)) report(id, `${why} — "${needle}" no longer appears in the document`);
  };

  // --- prerequisites and setup ----------------------------------------------------------------
  require_(
    'prerequisites',
    expected.nodeVersion,
    'a contributor cannot install the right Node without the exact version',
  );
  require_(
    'prerequisites',
    expected.npmVersion,
    'a contributor cannot install the right npm without the exact version',
  );
  require_('prerequisites', '.nvmrc', 'the Node pin must be traceable to the file declaring it');
  require_(
    'prerequisites',
    'packageManager',
    'the npm pin must be traceable to the field declaring it',
  );

  require_('clean-clone', 'git clone', 'clean-clone setup must start from a clone');
  require_(
    'clean-clone',
    'npm ci',
    'setup must use npm ci, which honours the lockfile, rather than npm install',
  );

  for (const minimum of expected.engineMinimums) {
    if (!has(minimum)) {
      report(
        'toolchain-pins',
        `the supported-range minimum ${minimum} is not documented, so the difference between a ` +
          'pinned toolchain and a supported range is no longer explained',
      );
    }
  }
  require_(
    'toolchain-pins',
    'package-lock.json',
    'the lockfile is part of the pinned toolchain and must be documented as such',
  );

  // --- verification ---------------------------------------------------------------------------
  for (const command of expected.verificationCommands) {
    if (!has(command)) {
      report(
        'verification-commands',
        `\`${command}\` is part of the repository gate but is not documented — a contributor ` +
          'would not know to run it, or would not know it must pass',
      );
    }
  }
  require_(
    'verification-commands',
    'node docs/tools/validate-doc-links.mjs',
    'the documentation link validator must be documented',
  );
  require_(
    'verification-commands',
    'npm audit --audit-level=high',
    'the dependency audit threshold must be documented',
  );

  // --- architectural enforcement ---------------------------------------------------------------
  for (const id of expected.checkIds) {
    if (!has(id)) {
      report(
        'boundary-checks',
        `the \`${id}\` check is enforced by npm run verify but is not documented`,
      );
    }
  }

  require_(
    'planted-fixtures',
    'tests/fixtures',
    'the planted-violation fixtures must be documented, or they read as broken code',
  );
  for (const dir of expected.fixtureDirs) {
    if (!has(dir)) {
      report('planted-fixtures', `the \`${dir}\` fixture exists but is not documented`);
    }
  }
  if (!mentionsAny(['not broken code', 'evidence that each check can fail'])) {
    report(
      'planted-fixtures',
      'the document no longer explains that fixtures are evidence rather than defects — the next ' +
        'contributor will "fix" one and silently disable a rule',
    );
  }

  // --- ownership and dependency rules -----------------------------------------------------------
  if (!proseHas('MODULE_MAP.md')) {
    report('module-ownership', 'the document no longer points at the architecture of record');
  }
  require_('module-ownership', 'exactly one owner', 'the single-owner rule is no longer stated');
  require_('module-ownership', 'owns its data', 'the data-ownership rule is no longer stated');
  require_(
    'dependency-rules',
    'point downward only',
    'the downward-only dependency rule is no longer stated',
  );
  require_('dependency-rules', 'No cycles', 'the acyclicity rule is no longer stated');

  // --- the two non-negotiable AI rules ----------------------------------------------------------
  require_(
    'financial-ai-prohibition',
    'AI never decides money',
    'the prohibition on AI deciding financial outcomes is no longer stated in plain terms',
  );
  require_(
    'financial-ai-prohibition',
    'financial-zone-ai',
    'the check enforcing the financial-zone AI exclusion must be named',
  );
  for (const prefix of expected.financialZonePrefixes) {
    if (!has(prefix)) {
      report(
        'financial-ai-prohibition',
        `${prefix} is inside the deterministic financial authority zone but is not documented as ` +
          'being in it',
      );
    }
  }

  require_(
    'provider-import-restriction',
    expected.aiGatewayPath,
    'the sole permitted importer of provider SDKs must be named',
  );
  require_(
    'provider-import-restriction',
    'PROVIDER_PACKAGES',
    'the provider allowlist must be named, since an unlisted provider is an unenforced provider',
  );
  require_('provider-import-restriction', 'K-13', 'the owning kernel component is no longer named');

  // --- secrets ----------------------------------------------------------------------------------
  require_(
    'secrets-handling',
    'No secret is ever committed',
    'the prohibition on committing secrets is no longer stated',
  );
  require_('secrets-handling', '.env', 'the ignored environment files must be documented');
  require_(
    'secrets-handling',
    'Rotate it',
    'the instruction to rotate a leaked secret before removing it is no longer stated',
  );

  // --- change, review and branch conventions ----------------------------------------------------
  require_(
    'atomic-changes',
    'One bounded task per change',
    'the atomic-change convention is no longer stated',
  );
  require_(
    'atomic-changes',
    'without evidence',
    'the no-completion-without-evidence rule is no longer stated',
  );
  if (!/^#+ .*[Rr]eview\s*$/m.test(text)) {
    report('review', 'the document no longer has a review section');
  }
  require_(
    'review',
    'weakened',
    'review no longer asks whether a check, fixture or exclusion was weakened to fit the change',
  );

  require_(
    'branch-conventions',
    expected.defaultBranch,
    'the default branch must be named so contributors know what CI builds',
  );
  require_(
    'branch-conventions',
    'Conductor',
    'the document no longer explains that Git operations are Conductor-managed, so a contributor ' +
      'would run git commit inside a session and corrupt its record',
  );
  for (const forbidden of ['git commit', 'git push', 'git checkout', 'git branch']) {
    if (!has(forbidden)) {
      report(
        'branch-conventions',
        `the document no longer names \`${forbidden}\` among the operations Conductor owns`,
      );
    }
  }

  // --- database and migration contract ---------------------------------------------------------
  require_('database', 'PostgreSQL', 'the selected database must be named');
  for (const prefix of expected.schemaPrefixes) {
    if (!has(prefix)) {
      report('database', `the \`${prefix}\` schema-namespace prefix is no longer documented`);
    }
  }
  if (!has(expected.forbiddenSchema)) {
    report(
      'database',
      `the document no longer states that \`${expected.forbiddenSchema}\` is forbidden for unit ` +
        'data, which is the rule that keeps schema ownership meaningful',
    );
  }
  if (!mentionsAny(['Not delivered', 'not delivered'])) {
    report(
      'database',
      'the document no longer distinguishes what the data foundation delivers from what it does ' +
        'not — a reader would take provisioning and a migration runner to exist',
    );
  }
  if (!mentionsAny(['never been executed against a live server', 'opens no connection'])) {
    report(
      'database',
      'the document no longer states that the migrations are validated statically and have not ' +
        'been run against a live database',
    );
  }

  // --- link integrity ---------------------------------------------------------------------------
  for (const target of relativeLinks(text)) {
    if (!expected.resolveLink(target)) {
      report('link-integrity', `the relative link "${target}" does not resolve to a file on disk`);
    }
  }

  return violations;
}
