/**
 * The fixture-manifest contract (FND-002d).
 *
 * Seed data is the quietest way to make a test suite lie. A fixture that carries a real-looking
 * email address becomes a GDPR question the first time somebody dumps a development database; one
 * that calls `now()` makes a test that passes in the morning and fails at midnight; one that writes
 * into another unit's schema makes the boundary rules decorative. None of those fail loudly, and
 * all of them are cheap to prevent at the point the data is declared.
 *
 * So a fixture is a *declared* dataset, not a script:
 *
 *   - **Versioned.** `manifestVersion` is checked, so a format change cannot be read as if it were
 *     the old format.
 *   - **Owned.** A dataset names one manifest unit and writes only into that unit's schema. The
 *     ownership mapping is the same one the migration validator uses, derived from
 *     `platform/architecture/manifest.ts` rather than remembered.
 *   - **Deterministic.** Every identifier and every instant is a literal. There is no clock, no
 *     randomness and no SQL function call anywhere in a row, because a fixture whose content
 *     depends on when it ran cannot be the baseline a test asserts against.
 *   - **Ordered.** Datasets declare dependencies; loading order is a topological sort with ties
 *     broken by name, so the same manifests always produce the same plan.
 *   - **Identified.** Each table names the columns that identify a row, which is what makes a
 *     rerun idempotent rather than a duplicate-key failure.
 *
 * Everything here is validation. Nothing in this file opens a connection or writes a row — see
 * runner.ts.
 *
 * Owned by: FND-002d (data foundation).
 */

import fs from 'node:fs';
import path from 'node:path';

import { ownerOfSchema, type SchemaOwner } from '../db/schema-namespaces.ts';

import { FINGERPRINT_FORMAT, fingerprintPayload } from './fingerprint.ts';

/** Repo-relative directory holding the real datasets. */
export const FIXTURES_DIR = 'db/fixtures';

/** The only manifest format this code understands. */
export const MANIFEST_VERSION = 1;

/**
 * What a dataset is for.
 *
 * There is deliberately no `production`. A fixture is development and test data; production data
 * arrives through the application, and a seed file that could target production is a seed file
 * that eventually will.
 */
export const FIXTURE_PURPOSES = ['development', 'test'] as const;
export type FixturePurpose = (typeof FIXTURE_PURPOSES)[number];

export type FixtureCheckId =
  | 'malformed-manifest'
  | 'unknown-owner'
  | 'cross-owner-table'
  | 'duplicate-identity'
  | 'dependency-cycle'
  | 'malformed-record'
  | 'nondeterministic-value'
  | 'credential-in-fixture'
  | 'personal-data'
  | 'fingerprint-mismatch';

/** Every check this module performs. The tests assert each has a planted-invalid fixture. */
export const FIXTURE_CHECK_IDS: readonly FixtureCheckId[] = [
  'malformed-manifest',
  'unknown-owner',
  'cross-owner-table',
  'duplicate-identity',
  'dependency-cycle',
  'malformed-record',
  'nondeterministic-value',
  'credential-in-fixture',
  'personal-data',
  'fingerprint-mismatch',
];

/** P0 stops progression: anything that could leak data or corrupt another unit's schema. */
export type Severity = 'P0' | 'P1';

const SEVERITY: Readonly<Record<FixtureCheckId, Severity>> = {
  'malformed-manifest': 'P1',
  'unknown-owner': 'P0',
  'cross-owner-table': 'P0',
  'duplicate-identity': 'P1',
  'dependency-cycle': 'P1',
  'malformed-record': 'P1',
  'nondeterministic-value': 'P0',
  'credential-in-fixture': 'P0',
  'personal-data': 'P0',
  // P0: a row whose own evidence contradicts it is worse than a missing row. Nothing notices until
  // a consumer compares the two, which is the worst moment and the least related code.
  'fingerprint-mismatch': 'P0',
};

export type FixtureScalar = string | number | boolean | null;
export type FixtureJson =
  FixtureScalar | readonly FixtureJson[] | { readonly [key: string]: FixtureJson };

export interface FixtureTable {
  /** Schema-qualified, e.g. `kernel_configuration.config_version`. */
  readonly table: string;
  /**
   * The columns that identify a row.
   *
   * This is what makes a reload idempotent: the runner inserts on conflict of exactly these
   * columns and does nothing, so running twice is running once. A table with no declared identity
   * would duplicate every row on the second run.
   */
  readonly identity: readonly string[];
  /** Columns whose value is a JSON document rather than a scalar, e.g. a `jsonb` payload. */
  readonly jsonColumns?: readonly string[];
  readonly rows: ReadonlyArray<Readonly<Record<string, FixtureJson>>>;
}

export interface FixtureManifest {
  readonly manifestVersion: number;
  /** Stable identifier, kebab-case. Referenced by `dependsOn` and by the CLI. */
  readonly dataset: string;
  /** Manifest unit id, e.g. `K-05`. */
  readonly owner: string;
  /** The one schema this dataset writes into. Must belong to `owner`. */
  readonly schema: string;
  readonly purpose: FixturePurpose;
  readonly description: string;
  /** Datasets that must be loaded first. */
  readonly dependsOn: readonly string[];
  readonly tables: readonly FixtureTable[];
}

export interface FixtureViolation {
  readonly check: FixtureCheckId;
  readonly severity: Severity;
  /** Repo-relative file, or the dataset name when the problem spans files. */
  readonly file: string;
  readonly dataset: string;
  readonly message: string;
}

export interface FixtureValidation {
  readonly manifests: readonly FixtureManifest[];
  readonly violations: readonly FixtureViolation[];
  readonly filesScanned: number;
}

// ---------------------------------------------------------------------------
// The refusals, and why each exists
// ---------------------------------------------------------------------------

const DATASET_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const COLUMN_NAME = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const QUALIFIED_TABLE = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;

/**
 * Values that would make a row's content depend on when it was loaded.
 *
 * A fixture is a baseline. If loading it twice on different days produces different rows, every
 * assertion against it is really an assertion about the clock, and the failure arrives at 00:00 in
 * somebody else's time zone.
 */
const NONDETERMINISTIC_VALUES: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> =
  [
    { pattern: /\bnow\s*\(\s*\)/i, what: 'now()' },
    { pattern: /\bcurrent_(timestamp|date|time)\b/i, what: 'CURRENT_TIMESTAMP' },
    { pattern: /\bclock_timestamp\s*\(/i, what: 'clock_timestamp()' },
    { pattern: /\bstatement_timestamp\s*\(/i, what: 'statement_timestamp()' },
    { pattern: /\btransaction_timestamp\s*\(/i, what: 'transaction_timestamp()' },
    { pattern: /\brandom\s*\(\s*\)/i, what: 'random()' },
    { pattern: /\bgen_random_uuid\s*\(/i, what: 'gen_random_uuid()' },
    { pattern: /\buuid_generate_v[14]\s*\(/i, what: 'uuid_generate_v1()/v4()' },
    { pattern: /\bnextval\s*\(/i, what: 'nextval()' },
    { pattern: /\bDEFAULT\b/, what: 'DEFAULT' },
  ];

/** Column names that mean a credential is being carried. Same reasoning as K-05's and K-08's. */
export const CREDENTIAL_COLUMN_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'api_key',
  'apikey',
  'private_key',
  'access_key',
  'credential',
  'authorization',
];

/** Value shapes that are a credential whatever the column is called. */
export const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b(postgres(?:ql)?|mysql|mongodb):\/\/[^\s:]+:[^\s@]+@/,
];

/**
 * Domains reserved by RFC 2606 and RFC 6761 for exactly this purpose.
 *
 * An address at one of these can never reach a real person. An address anywhere else might, and a
 * fixture that reaches a real person is an incident rather than a test failure.
 */
const RESERVED_EMAIL_DOMAINS = /@(example\.(com|org|net)|.*\.(test|invalid|localhost|example))$/i;
const EMAIL_SHAPED = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

/** E.164-ish, and long digit runs that could be a card or a national identifier. */
const PHONE_SHAPED = /^\+?[0-9][0-9\s().-]{7,}[0-9]$/;
const LONG_DIGIT_RUN = /\b\d{12,19}\b/;

/**
 * Reserved test ranges. A fixture may use these freely; anything else that looks like a phone
 * number probably belongs to somebody.
 */
const RESERVED_PHONE_PREFIXES = ['+15550', '+1555', '+445555', '5550', '555-01'];

export function severityOf(check: FixtureCheckId): Severity {
  return SEVERITY[check];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Manifest files in `directory`, sorted by name so discovery is deterministic. */
export function discoverFixtureFiles(directory: string): readonly string[] {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.fixture.json'))
    .sort()
    .map((file) => path.join(directory, file));
}

/**
 * Parse and validate every dataset in `directory`.
 *
 * Returns rather than throws, so a caller can report every problem at once. A validator that stops
 * at the first violation makes fixing a set of fixtures an exercise in repeated guessing.
 */
export function validateFixtures(directory: string): FixtureValidation {
  const files = discoverFixtureFiles(directory);
  const violations: FixtureViolation[] = [];
  const parsed: FixtureManifest[] = [];
  const sources = new Map<string, string>();

  for (const file of files) {
    const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
    const manifest = parseManifest(file, relative, violations);
    if (manifest === null) continue;
    sources.set(manifest.dataset, relative);
    parsed.push(manifest);
  }

  const checked = validateManifests(parsed, sources);
  return {
    manifests: checked.manifests,
    violations: [...violations, ...checked.violations],
    filesScanned: files.length,
  };
}

/**
 * Validate manifests that are already in memory — the same checks, minus the parsing.
 *
 * This exists because the CLI was not the only way to reach the runner. A programmatic caller
 * passing hand-built manifests bypassed every ownership, identity, determinism, credential and
 * personal-data check, which meant the contract was enforced by *the path taken to the runner*
 * rather than by the runner. The guarantees the fixture contract makes have to hold for whoever
 * calls, not for whoever calls politely.
 *
 * `sources` maps a dataset name to the file it came from, purely so a violation can name it. A
 * caller with no files omits it and violations are reported against the dataset name.
 */
export function validateManifests(
  manifests: readonly FixtureManifest[],
  sources: ReadonlyMap<string, string> = new Map(),
): {
  readonly manifests: readonly FixtureManifest[];
  readonly violations: readonly FixtureViolation[];
} {
  const violations: FixtureViolation[] = [];
  const accepted: FixtureManifest[] = [];
  const byDataset = new Map<string, string>();

  for (const manifest of manifests) {
    const where = sources.get(manifest.dataset) ?? manifest.dataset;

    const shape = describeShapeProblem(manifest);
    if (shape !== null) {
      violations.push({
        check: 'malformed-manifest',
        severity: SEVERITY['malformed-manifest'],
        file: where,
        dataset: String(manifest.dataset ?? '(unnamed)'),
        message: shape,
      });
      continue;
    }

    const existing = byDataset.get(manifest.dataset);
    if (existing !== undefined) {
      violations.push({
        check: 'duplicate-identity',
        severity: SEVERITY['duplicate-identity'],
        file: where,
        dataset: manifest.dataset,
        message: `dataset "${manifest.dataset}" is also declared by ${existing}; a dataset name is a stable identifier and must be unique`,
      });
      continue;
    }

    byDataset.set(manifest.dataset, where);
    accepted.push(manifest);
    validateManifest(manifest, where, violations);
  }

  validateDependencies(accepted, byDataset, violations);
  return { manifests: accepted, violations };
}

/**
 * Structural problems in an in-memory manifest, or null.
 *
 * `parseManifest` already rejects these when reading a file. A programmatic caller has not been
 * through that, and TypeScript types are not a runtime guard — a caller in JavaScript, or one that
 * cast an `unknown`, can hand over anything at all.
 */
function describeShapeProblem(manifest: FixtureManifest): string | null {
  const candidate = manifest as unknown as Record<string, unknown>;

  if (candidate.manifestVersion !== MANIFEST_VERSION) {
    return `declares manifestVersion ${JSON.stringify(candidate.manifestVersion)}; this code reads version ${MANIFEST_VERSION} only`;
  }
  for (const field of ['dataset', 'owner', 'schema', 'purpose', 'description'] as const) {
    const value = candidate[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return `is missing a non-empty "${field}"`;
    }
  }
  if (!FIXTURE_PURPOSES.includes(candidate.purpose as FixturePurpose)) {
    return `declares purpose ${JSON.stringify(candidate.purpose)}; expected one of ${FIXTURE_PURPOSES.join(', ')}`;
  }
  if (!DATASET_NAME.test(candidate.dataset as string)) {
    return `dataset "${String(candidate.dataset)}" is not kebab-case`;
  }
  if (!Array.isArray(candidate.dependsOn)) return 'is missing a "dependsOn" array';
  if (!Array.isArray(candidate.tables) || candidate.tables.length === 0) {
    return 'is missing a non-empty "tables" array';
  }
  for (const [index, table] of (candidate.tables as unknown[]).entries()) {
    if (typeof table !== 'object' || table === null || Array.isArray(table)) {
      return `tables[${index}] is not an object`;
    }
    const entry = table as Record<string, unknown>;
    if (typeof entry.table !== 'string' || !QUALIFIED_TABLE.test(entry.table)) {
      return `tables[${index}].table is ${JSON.stringify(entry.table)}; expected schema.table`;
    }
    if (
      !Array.isArray(entry.identity) ||
      entry.identity.length === 0 ||
      !(entry.identity as unknown[]).every((column) => typeof column === 'string')
    ) {
      return `tables[${index}].identity must be a non-empty array of column names`;
    }
    if (!Array.isArray(entry.rows) || entry.rows.length === 0) {
      return `tables[${index}].rows must be a non-empty array`;
    }
  }
  return null;
}

function parseManifest(
  file: string,
  relative: string,
  violations: FixtureViolation[],
): FixtureManifest | null {
  const report = (message: string): null => {
    violations.push({
      check: 'malformed-manifest',
      severity: SEVERITY['malformed-manifest'],
      file: relative,
      dataset: path.basename(file, '.fixture.json'),
      message,
    });
    return null;
  };

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return report(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return report('is not a JSON object');
  }
  const candidate = raw as Record<string, unknown>;

  if (candidate.manifestVersion !== MANIFEST_VERSION) {
    return report(
      `declares manifestVersion ${JSON.stringify(candidate.manifestVersion)}; this code reads ` +
        `version ${MANIFEST_VERSION} only. A format change must not be read as if it were the old format`,
    );
  }
  for (const field of ['dataset', 'owner', 'schema', 'purpose', 'description'] as const) {
    const value = candidate[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return report(`is missing a non-empty "${field}"`);
    }
  }
  if (!FIXTURE_PURPOSES.includes(candidate.purpose as FixturePurpose)) {
    return report(
      `declares purpose ${JSON.stringify(candidate.purpose)}; expected one of ` +
        `${FIXTURE_PURPOSES.join(', ')}. There is deliberately no production purpose`,
    );
  }
  if (!Array.isArray(candidate.dependsOn)) return report('is missing a "dependsOn" array');
  if (!(candidate.dependsOn as unknown[]).every((entry) => typeof entry === 'string')) {
    return report('has a "dependsOn" entry that is not a string');
  }
  if (!Array.isArray(candidate.tables) || candidate.tables.length === 0) {
    return report('is missing a non-empty "tables" array');
  }

  for (const [index, table] of (candidate.tables as unknown[]).entries()) {
    if (typeof table !== 'object' || table === null || Array.isArray(table)) {
      return report(`tables[${index}] is not an object`);
    }
    const entry = table as Record<string, unknown>;
    if (typeof entry.table !== 'string' || !QUALIFIED_TABLE.test(entry.table)) {
      return report(
        `tables[${index}].table is ${JSON.stringify(entry.table)}; expected schema.table, so ` +
          'ownership can be checked and nothing lands in the default search path',
      );
    }
    if (
      !Array.isArray(entry.identity) ||
      entry.identity.length === 0 ||
      !(entry.identity as unknown[]).every((column) => typeof column === 'string')
    ) {
      return report(
        `tables[${index}].identity must be a non-empty array of column names; without it a ` +
          'reload duplicates every row instead of doing nothing',
      );
    }
    if (entry.jsonColumns !== undefined) {
      if (
        !Array.isArray(entry.jsonColumns) ||
        !(entry.jsonColumns as unknown[]).every((column) => typeof column === 'string')
      ) {
        return report(`tables[${index}].jsonColumns must be an array of column names`);
      }
    }
    if (!Array.isArray(entry.rows) || entry.rows.length === 0) {
      return report(`tables[${index}].rows must be a non-empty array`);
    }
  }

  if (!DATASET_NAME.test(candidate.dataset as string)) {
    return report(`dataset "${String(candidate.dataset)}" is not kebab-case`);
  }

  return candidate as unknown as FixtureManifest;
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

function validateManifest(
  manifest: FixtureManifest,
  file: string,
  violations: FixtureViolation[],
): void {
  const report = (check: FixtureCheckId, message: string): void => {
    violations.push({
      check,
      severity: SEVERITY[check],
      file,
      dataset: manifest.dataset,
      message,
    });
  };

  const owner: SchemaOwner | null = ownerOfSchema(manifest.schema);
  if (owner === null) {
    report(
      'unknown-owner',
      `writes into schema \`${manifest.schema}\`, which no unit in the architecture manifest owns`,
    );
  } else if (owner.id !== manifest.owner) {
    report(
      'unknown-owner',
      `claims owner ${manifest.owner} but \`${manifest.schema}\` belongs to ${owner.id} ${owner.name}`,
    );
  }

  for (const table of manifest.tables) {
    const match = QUALIFIED_TABLE.exec(table.table);
    const schema = match?.[1] ?? '';
    if (schema !== manifest.schema) {
      report(
        'cross-owner-table',
        `writes into \`${table.table}\`, which is outside its own schema \`${manifest.schema}\`. ` +
          "A fixture may not reach into another unit's namespace; add a dataset owned by that unit",
      );
    }

    const jsonColumns = new Set(table.jsonColumns ?? []);
    const seenIdentities = new Map<string, number>();

    for (const [index, row] of table.rows.entries()) {
      const where = `${table.table} row ${index}`;

      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        report('malformed-record', `${where} is not an object`);
        continue;
      }

      for (const column of table.identity) {
        if (!(column in row)) {
          report(
            'malformed-record',
            `${where} has no identity column "${column}", so it cannot be matched on reload`,
          );
        }
      }

      for (const [column, value] of Object.entries(row)) {
        if (!COLUMN_NAME.test(column)) {
          report('malformed-record', `${where} has column "${column}"; expected lower_snake_case`);
          continue;
        }
        if (!jsonColumns.has(column) && !isScalar(value)) {
          report(
            'malformed-record',
            `${where} column "${column}" is ${describe(value)}; only scalars are permitted unless ` +
              'the column is declared in jsonColumns',
          );
          continue;
        }
        checkValue(where, column, value, report);
      }

      checkFingerprint(where, row, report);

      const identity = table.identity
        .map((column) => JSON.stringify(row[column] ?? null))
        .join('|');
      const first = seenIdentities.get(identity);
      if (first !== undefined) {
        report(
          'duplicate-identity',
          `${where} repeats the identity of row ${first} (${table.identity.join(', ')} = ` +
            `${identity}). On reload the second would silently do nothing, so one of them is dead data`,
        );
      } else {
        seenIdentities.set(identity, index);
      }
    }
  }
}

/**
 * A row that carries both a payload and its fingerprint must carry a fingerprint *of that payload*.
 *
 * Recomputed rather than trusted. K-08 writes a fingerprint at append and treats it as the evidence
 * that the payload was never edited; a fixture that writes the two inconsistently has seeded a row
 * whose own evidence contradicts it, and nothing notices until a consumer compares them — in code
 * with no part in creating the problem, long after the fixture was written.
 *
 * The rule is expressed over column names rather than over K-08's table, so it applies to any
 * future table that keeps the same pair. Recomputation happens here, before any database access, so
 * an inconsistent fixture never reaches a connection.
 */
function checkFingerprint(
  where: string,
  row: Readonly<Record<string, FixtureJson>>,
  report: (check: FixtureCheckId, message: string) => void,
): void {
  const declared = row.payload_fingerprint;
  if (declared === undefined) return;

  if (typeof declared !== 'string' || !FINGERPRINT_FORMAT.test(declared)) {
    report(
      'fingerprint-mismatch',
      `${where} has payload_fingerprint ${JSON.stringify(declared)}, which is not 64 lower-case ` +
        'hex characters. The database CHECK would refuse it too, but not until the load ran',
    );
    return;
  }

  const payload = row.payload;
  if (payload === undefined) {
    report(
      'fingerprint-mismatch',
      `${where} carries a payload_fingerprint but no payload, so nothing can confirm it. A ` +
        'fingerprint of an absent payload is a claim about nothing',
    );
    return;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    report(
      'fingerprint-mismatch',
      `${where} has a payload that is not a JSON object, so no fingerprint of it is meaningful`,
    );
    return;
  }

  const recomputed = fingerprintPayload(payload as Readonly<Record<string, unknown>>);
  if (recomputed !== declared) {
    report(
      'fingerprint-mismatch',
      `${where} declares payload_fingerprint ${declared} but its payload hashes to ${recomputed}. ` +
        'Either the payload was edited without recomputing, or the fingerprint was copied from ' +
        'another row — both seed a row whose evidence disagrees with its content',
    );
  }
}

/** Walk a value, scalar or JSON document, applying the content rules to every string in it. */
function checkValue(
  where: string,
  column: string,
  value: FixtureJson,
  report: (check: FixtureCheckId, message: string) => void,
): void {
  const fragment = CREDENTIAL_COLUMN_FRAGMENTS.find((candidate) => column.includes(candidate));
  if (fragment !== undefined) {
    report(
      'credential-in-fixture',
      `${where} column "${column}" names a credential ("${fragment}"). A seeded credential is a ` +
        'real credential the moment somebody copies the fixture into a shared environment',
    );
  }

  for (const text of strings(value)) {
    for (const rule of NONDETERMINISTIC_VALUES) {
      if (rule.pattern.test(text)) {
        report(
          'nondeterministic-value',
          `${where} column "${column}" contains ${rule.what}. A fixture whose content depends on ` +
            'when it loaded is not a baseline anything can assert against',
        );
      }
    }
    for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
      if (pattern.test(text)) {
        report(
          'credential-in-fixture',
          `${where} column "${column}" holds a value shaped like a credential (${String(pattern)})`,
        );
      }
    }
    checkPersonalData(where, column, text, report);
  }
}

/**
 * Refuse anything that could be a real person's data.
 *
 * Not a privacy audit — a shape check. The point is that seed data is copied, dumped and pasted
 * into issues, and a plausible email address or phone number in a fixture is indistinguishable
 * from a real one to everyone downstream of it.
 */
function checkPersonalData(
  where: string,
  column: string,
  text: string,
  report: (check: FixtureCheckId, message: string) => void,
): void {
  if (EMAIL_SHAPED.test(text) && !RESERVED_EMAIL_DOMAINS.test(text)) {
    report(
      'personal-data',
      `${where} column "${column}" holds "${text}", which is a deliverable email address. Use a ` +
        'reserved domain (example.com, or a .test/.invalid host) so a fixture can never reach a person',
    );
  }

  const digits = text.replace(/[\s().-]/g, '');
  if (
    PHONE_SHAPED.test(text) &&
    !RESERVED_PHONE_PREFIXES.some((prefix) => digits.startsWith(prefix.replace(/[\s().-]/g, '')))
  ) {
    report(
      'personal-data',
      `${where} column "${column}" holds "${text}", which is shaped like a real telephone number. ` +
        'Use a reserved test range',
    );
  }

  if (LONG_DIGIT_RUN.test(text)) {
    report(
      'personal-data',
      `${where} column "${column}" holds a 12-19 digit run, which is the shape of a payment card ` +
        'or a national identifier. Fixtures carry neither',
    );
  }
}

/**
 * Load order: dependencies first, ties broken by name.
 *
 * Kahn's algorithm with a sorted frontier, so the same manifests always produce the same plan —
 * an ordering that varied run to run would make a load failure depend on which dataset happened to
 * go first.
 */
export function loadOrder(manifests: readonly FixtureManifest[]): readonly FixtureManifest[] {
  const byName = new Map(manifests.map((manifest) => [manifest.dataset, manifest]));
  const remaining = new Map(
    manifests.map((manifest) => [
      manifest.dataset,
      manifest.dependsOn.filter((dependency) => byName.has(dependency)).length,
    ]),
  );
  const dependents = new Map<string, string[]>();
  for (const manifest of manifests) {
    for (const dependency of manifest.dependsOn) {
      if (!byName.has(dependency)) continue;
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), manifest.dataset]);
    }
  }

  const ordered: FixtureManifest[] = [];
  const ready = [...remaining.entries()]
    .filter(([, count]) => count === 0)
    .map(([name]) => name)
    .sort();

  while (ready.length > 0) {
    const name = ready.shift() as string;
    const manifest = byName.get(name);
    if (manifest !== undefined) ordered.push(manifest);
    for (const dependent of (dependents.get(name) ?? []).sort()) {
      const count = (remaining.get(dependent) ?? 1) - 1;
      remaining.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  return ordered;
}

function validateDependencies(
  manifests: readonly FixtureManifest[],
  files: ReadonlyMap<string, string>,
  violations: FixtureViolation[],
): void {
  const known = new Set(manifests.map((manifest) => manifest.dataset));

  for (const manifest of manifests) {
    for (const dependency of manifest.dependsOn) {
      if (!known.has(dependency)) {
        violations.push({
          check: 'dependency-cycle',
          severity: SEVERITY['dependency-cycle'],
          file: files.get(manifest.dataset) ?? manifest.dataset,
          dataset: manifest.dataset,
          message: `depends on "${dependency}", which is not a declared dataset`,
        });
      }
      if (dependency === manifest.dataset) {
        violations.push({
          check: 'dependency-cycle',
          severity: SEVERITY['dependency-cycle'],
          file: files.get(manifest.dataset) ?? manifest.dataset,
          dataset: manifest.dataset,
          message: 'depends on itself',
        });
      }
    }
  }

  // Anything the topological sort could not place is in a cycle, by construction.
  const ordered = new Set(loadOrder(manifests).map((manifest) => manifest.dataset));
  for (const manifest of manifests) {
    if (ordered.has(manifest.dataset)) continue;
    violations.push({
      check: 'dependency-cycle',
      severity: SEVERITY['dependency-cycle'],
      file: files.get(manifest.dataset) ?? manifest.dataset,
      dataset: manifest.dataset,
      message:
        'is part of a dependency cycle, so no load order exists. Datasets form a DAG: break the ' +
        'cycle by splitting whichever dataset needs the other half',
    });
  }
}

function isScalar(value: unknown): value is FixtureScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** Every string inside a value, however deeply nested. */
function strings(value: FixtureJson): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...strings(entry)]);
  }
  return [];
}
