/**
 * Anti-erosion tests for the contributor documentation (FND-001d).
 *
 * Asserting only that docs/CONTRIBUTING.md currently satisfies its contract would be a check that
 * cannot fail — it would pass just as happily against a contract module that accepted anything.
 * So each case below deletes or softens one specific guarantee in a copy of the real document and
 * asserts the contract catches it: the Node pin, the clean-clone command, a boundary check, a
 * fixture, the financial-AI prohibition, the provider confinement, the secrets rule, the branch
 * conventions.
 *
 * The expectations are read from the repository rather than restated here — .nvmrc, the `verify`
 * script, the boundary check ids, the manifest, the fixture directory. When the repository
 * changes, this contract follows it and the document is what has to catch up.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AI_GATEWAY_PATH, FINANCIAL_ZONE_PREFIXES } from '../platform/architecture/manifest.ts';
import { CHECK_IDS } from '../platform/checks/boundaries.ts';
import {
  FORBIDDEN_SCHEMA,
  KERNEL_SCHEMA_PREFIX,
  MODULE_SCHEMA_PREFIX,
} from '../platform/db/schema-namespaces.ts';
import {
  CONTRIBUTING_PATH,
  DOCS_CONTRACT_IDS,
  checkDocsContract,
} from '../platform/checks/docs-contract.ts';
import type { DocsContractId, DocsExpectations } from '../platform/checks/docs-contract.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC_DIR = path.dirname(path.join(REPO_ROOT, CONTRIBUTING_PATH));

/**
 * The repository's default branch. Stated here rather than read from the document under test,
 * which would make the assertion vacuous. Cross-checked against origin/HEAD below where that ref
 * is available.
 */
const DEFAULT_BRANCH = 'conductor/p2p-com-03af26';

const readDoc = (): string => fs.readFileSync(path.join(REPO_ROOT, CONTRIBUTING_PATH), 'utf8');

interface Manifest {
  readonly scripts: Record<string, string>;
  readonly engines: Record<string, string>;
  readonly packageManager: string;
}

const manifest = (): Manifest =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as Manifest;

/** Every command the `verify` script chains, plus the entry point itself. */
const verificationCommands = (): string[] => {
  const verify = manifest().scripts['verify'] ?? '';
  const chained = verify
    .split('&&')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return ['npm run verify', ...chained];
};

const expectations = (): DocsExpectations => {
  const pkg = manifest();
  return {
    nodeVersion: fs.readFileSync(path.join(REPO_ROOT, '.nvmrc'), 'utf8').trim(),
    npmVersion: pkg.packageManager.split('@').pop()?.split('+')[0] ?? '',
    engineMinimums: Object.values(pkg.engines).map((range) => range.replace(/[^\d.]/g, '')),
    verificationCommands: verificationCommands(),
    checkIds: CHECK_IDS,
    fixtureDirs: fs
      .readdirSync(path.join(REPO_ROOT, 'tests/fixtures'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
    financialZonePrefixes: FINANCIAL_ZONE_PREFIXES,
    aiGatewayPath: AI_GATEWAY_PATH,
    defaultBranch: DEFAULT_BRANCH,
    schemaPrefixes: [KERNEL_SCHEMA_PREFIX, MODULE_SCHEMA_PREFIX],
    forbiddenSchema: FORBIDDEN_SCHEMA,
    resolveLink: (target) => fs.existsSync(path.resolve(DOC_DIR, target)),
  };
};

/** Apply one weakening, asserting the pattern still matches something. */
const weaken = (find: string | RegExp, replace: string): string => {
  const original = readDoc();
  const mutated =
    typeof find === 'string' ? original.split(find).join(replace) : original.replace(find, replace);
  assert.notEqual(
    mutated,
    original,
    `the mutation ${String(find)} matched nothing — test is stale`,
  );
  return mutated;
};

const idsFrom = (text: string): DocsContractId[] =>
  checkDocsContract(text, expectations()).map((violation) => violation.id);

// --------------------------------------------------------------- the document as written

test('the contributor documentation exists where the contract expects it', () => {
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, CONTRIBUTING_PATH)),
    `${CONTRIBUTING_PATH} is missing — a new contributor has no documented setup path`,
  );
});

test('the contributor documentation satisfies every guarantee', () => {
  const violations = checkDocsContract(readDoc(), expectations());
  assert.deepEqual(
    violations,
    [],
    `documentation contract violations:\n${violations
      .map((v) => `  [${v.id}] ${v.message}`)
      .join('\n')}`,
  );
});

test('every command in the verify chain is documented', () => {
  const doc = readDoc();
  const commands = verificationCommands();
  assert.ok(
    commands.length >= 6,
    `expected the verify chain to have gates, got ${commands.length}`,
  );
  for (const command of commands) {
    assert.ok(doc.includes(command), `\`${command}\` is a gate but is undocumented`);
  }
});

test('the documented toolchain matches the repository pins', () => {
  const doc = readDoc();
  const expected = expectations();
  assert.ok(doc.includes(expected.nodeVersion), 'the documented Node version has drifted');
  assert.ok(doc.includes(expected.npmVersion), 'the documented npm version has drifted');
});

test('the contract targets the remote default branch, where that ref is available', () => {
  let remoteDefault: string;
  try {
    remoteDefault = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // A shallow or single-branch checkout has no origin/HEAD. Nothing to cross-check against.
    return;
  }
  assert.equal(
    remoteDefault.replace(/^origin\//, ''),
    DEFAULT_BRANCH,
    'the default branch has moved; update DEFAULT_BRANCH and the documentation together',
  );
});

// --------------------------------------------------------------- planted erosions

const EROSIONS: ReadonlyArray<{
  readonly name: string;
  readonly id: DocsContractId;
  readonly mutate: () => string;
}> = [
  {
    name: 'the exact Node version is removed',
    id: 'prerequisites',
    mutate: () => weaken(expectations().nodeVersion, 'whatever you have'),
  },
  {
    name: 'the .nvmrc reference is removed',
    id: 'prerequisites',
    mutate: () => weaken('.nvmrc', 'somewhere'),
  },
  {
    name: 'npm ci is replaced by npm install in the setup path',
    id: 'clean-clone',
    mutate: () => weaken('npm ci', 'npm install'),
  },
  {
    name: 'the supported-range minimums are dropped',
    id: 'toolchain-pins',
    mutate: () => weaken('22.18.0', ''),
  },
  {
    name: 'the lockfile is no longer described as part of the pinned toolchain',
    id: 'toolchain-pins',
    mutate: () => weaken('package-lock.json', 'the lockfile'),
  },
  {
    name: 'a verification command is dropped from the documentation',
    id: 'verification-commands',
    mutate: () => weaken('npm run check:boundaries', 'some command'),
  },
  {
    name: 'the documentation link validator is dropped',
    id: 'verification-commands',
    mutate: () => weaken('node docs/tools/validate-doc-links.mjs', 'a link check'),
  },
  {
    name: 'the audit threshold is dropped',
    id: 'verification-commands',
    mutate: () => weaken('npm audit --audit-level=high', 'npm audit'),
  },
  {
    name: 'a boundary check is no longer named',
    id: 'boundary-checks',
    mutate: () => weaken('kernel-purity', 'some check'),
  },
  {
    name: 'a planted fixture is no longer documented',
    id: 'planted-fixtures',
    mutate: () => weaken('violation-provider-import', 'a fixture'),
  },
  {
    name: 'the fixtures-are-evidence explanation is deleted',
    id: 'planted-fixtures',
    mutate: () =>
      weaken('not broken code', 'ordinary code').replace(
        'evidence that each check can fail',
        'examples',
      ),
  },
  {
    name: 'the single-owner rule is softened',
    id: 'module-ownership',
    mutate: () => weaken('exactly one owner', 'an owner'),
  },
  {
    name: 'the data-ownership rule is deleted',
    id: 'module-ownership',
    mutate: () => weaken('owns its data', 'shares its data'),
  },
  {
    name: 'the downward-only dependency rule is deleted',
    id: 'dependency-rules',
    mutate: () => weaken('point downward only', 'point wherever they need to'),
  },
  {
    name: 'the acyclicity rule is deleted',
    id: 'dependency-rules',
    mutate: () => weaken('No cycles', 'Cycles are acceptable'),
  },
  {
    name: 'the prohibition on AI deciding money is deleted',
    id: 'financial-ai-prohibition',
    mutate: () => weaken('AI never decides money', 'AI may assist with money'),
  },
  {
    name: 'the financial-zone check is no longer named',
    id: 'financial-ai-prohibition',
    mutate: () => weaken('financial-zone-ai', 'a zone check'),
  },
  {
    name: 'a financial-zone module is dropped from the documented zone',
    id: 'financial-ai-prohibition',
    mutate: () => weaken('modules/seller-payouts', 'somewhere else'),
  },
  {
    name: 'the sole permitted provider importer is no longer named',
    id: 'provider-import-restriction',
    mutate: () => weaken(AI_GATEWAY_PATH, 'the gateway'),
  },
  {
    name: 'the provider allowlist is no longer named',
    id: 'provider-import-restriction',
    mutate: () => weaken('PROVIDER_PACKAGES', 'a list'),
  },
  {
    name: 'the prohibition on committing secrets is deleted',
    id: 'secrets-handling',
    mutate: () => weaken('No secret is ever committed', 'Avoid committing secrets where practical'),
  },
  {
    name: 'the rotate-before-removing instruction is deleted',
    id: 'secrets-handling',
    mutate: () => weaken('Rotate it', 'Remove it'),
  },
  {
    name: 'the atomic-change convention is deleted',
    id: 'atomic-changes',
    mutate: () => weaken('One bounded task per change', 'Group related work'),
  },
  {
    name: 'the no-completion-without-evidence rule is deleted',
    id: 'atomic-changes',
    mutate: () => weaken('without evidence', 'when it looks done'),
  },
  {
    name: 'the review section is removed',
    id: 'review',
    mutate: () => weaken(/^## \d+\. Review$/m, '## 12. Notes'),
  },
  {
    name: 'review no longer asks whether a guarantee was weakened',
    id: 'review',
    mutate: () => weaken('weakened', 'adjusted'),
  },
  {
    name: 'the default branch is no longer named',
    id: 'branch-conventions',
    mutate: () => weaken(DEFAULT_BRANCH, 'the main branch'),
  },
  {
    name: 'the Conductor-managed Git explanation is deleted',
    id: 'branch-conventions',
    mutate: () => weaken('Conductor', 'the automation'),
  },
  {
    name: 'a Git operation owned by Conductor is no longer listed',
    id: 'branch-conventions',
    mutate: () => weaken('git checkout', 'switching branches'),
  },
  {
    name: 'the selected database is no longer named',
    id: 'database',
    mutate: () => weaken('PostgreSQL', 'a relational database'),
  },
  {
    name: 'a schema-namespace prefix is no longer documented',
    id: 'database',
    mutate: () => weaken(MODULE_SCHEMA_PREFIX, 'mod_'),
  },
  {
    name: 'the document stops saying what the data foundation does not deliver',
    id: 'database',
    mutate: () => weaken('Not delivered', 'Available'),
  },
  {
    name: 'the document stops admitting the migrations were never run live',
    id: 'database',
    mutate: () =>
      weaken('never been executed against a live server', 'been executed routinely').replace(
        'opens no connection',
        'connects on demand',
      ),
  },
  {
    name: 'a cross-reference points at a file that does not exist',
    id: 'link-integrity',
    mutate: () => weaken('./MODULE_MAP.md', './MODULE_MAP_OLD.md'),
  },
];

for (const erosion of EROSIONS) {
  test(`rejects eroded documentation: ${erosion.name}`, () => {
    const ids = idsFrom(erosion.mutate());
    assert.ok(
      ids.includes(erosion.id),
      `expected a "${erosion.id}" violation, got ${JSON.stringify(ids)}`,
    );
  });
}

test('every declared documentation guarantee is exercised by at least one planted erosion', () => {
  const covered = new Set(EROSIONS.map((erosion) => erosion.id));
  const uncovered = DOCS_CONTRACT_IDS.filter((id) => !covered.has(id));
  assert.deepEqual(uncovered, [], `guarantees with no planted erosion: ${uncovered.join(', ')}`);
});
