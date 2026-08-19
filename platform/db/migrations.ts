/**
 * The migration contract (FND-002a).
 *
 * A migration is the one artefact in a system that runs exactly once, in production, usually
 * unattended, and often against data nobody can reconstruct. The failure modes are well known and
 * all of them are cheap to detect before the file is ever executed: an unpaired forward migration
 * that cannot be rolled back, two developers claiming the same version number, DDL outside a
 * transaction that leaves the schema half-migrated, a table dropped into `public` where every
 * module can reach it, one module reaching into another module's namespace.
 *
 * This module rejects those statically. It parses the migration files as text and opens no
 * connection — the checks hold on a machine with no PostgreSQL installed, which is the point:
 * they run in the same `npm run verify` as everything else, on every change, rather than at
 * deploy time when the cost of being wrong is highest.
 *
 * It is a lint, not a substitute for running the migration. What it proves is that a file cannot
 * be structurally unsafe; what it cannot prove is that the SQL does what its author intended.
 *
 * Owned by: FND-002a (data foundation). Describes and validates migrations; contains no business
 * logic.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  FORBIDDEN_SCHEMA,
  knownSchemas,
  ownerOfSchema,
  type SchemaOwner,
} from './schema-namespaces.ts';

/** Repo-relative directory holding the migration set. */
export const MIGRATIONS_DIR = 'db/migrations';

export type MigrationCheckId =
  | 'malformed-name'
  | 'malformed-header'
  | 'duplicate-version'
  | 'missing-rollback'
  | 'orphan-rollback'
  | 'non-transactional'
  | 'public-schema'
  | 'cross-owner-schema'
  | 'unregistered-schema'
  | 'unsafe-statement';

/** Every check this module performs. The tests assert each has a planted-invalid fixture. */
export const MIGRATION_CHECK_IDS: readonly MigrationCheckId[] = [
  'malformed-name',
  'malformed-header',
  'duplicate-version',
  'missing-rollback',
  'orphan-rollback',
  'non-transactional',
  'public-schema',
  'cross-owner-schema',
  'unregistered-schema',
  'unsafe-statement',
];

/**
 * P0 stops progression. Everything that can corrupt or expose data is P0; naming and pairing
 * defects are P1 because they are recoverable before the migration runs.
 */
export type Severity = 'P0' | 'P1';

const SEVERITY: Readonly<Record<MigrationCheckId, Severity>> = {
  'malformed-name': 'P1',
  'malformed-header': 'P1',
  'duplicate-version': 'P0',
  'missing-rollback': 'P0',
  'orphan-rollback': 'P1',
  'non-transactional': 'P0',
  'public-schema': 'P0',
  'cross-owner-schema': 'P0',
  'unregistered-schema': 'P0',
  'unsafe-statement': 'P0',
};

export interface MigrationViolation {
  readonly check: MigrationCheckId;
  readonly severity: Severity;
  /** File name within the migrations directory. */
  readonly file: string;
  /** 1-indexed line, or 0 when the defect is a property of the set rather than of a line. */
  readonly line: number;
  readonly message: string;
}

export type Direction = 'up' | 'down';

export interface Migration {
  readonly file: string;
  readonly version: string;
  readonly slug: string;
  readonly direction: Direction;
  /** Schema declared in the header as this migration's owner. */
  readonly owner: string | null;
}

export interface MigrationValidationResult {
  readonly filesScanned: number;
  readonly migrations: readonly Migration[];
  readonly violations: readonly MigrationViolation[];
}

const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.(up|down)\.sql$/;

/**
 * Statements that destroy or expose data. Permitted in a rollback, where undoing the forward
 * migration is the whole purpose; never permitted in a forward migration, which must be additive
 * so that a deploy can be halted without data loss.
 */
const DESTRUCTIVE = [
  { pattern: /\bDROP\s+TABLE\b/i, what: 'DROP TABLE' },
  { pattern: /\bDROP\s+SCHEMA\b/i, what: 'DROP SCHEMA' },
  { pattern: /\bDROP\s+DATABASE\b/i, what: 'DROP DATABASE' },
  {
    pattern: /\bALTER\s+TABLE\b[\s\S]{0,200}?\bDROP\s+COLUMN\b/i,
    what: 'ALTER TABLE ... DROP COLUMN',
  },
] as const;

/** Statements that are unsafe in either direction. */
const ALWAYS_UNSAFE = [
  { pattern: /\bTRUNCATE\b/i, what: 'TRUNCATE' },
  { pattern: /\bDROP\s+DATABASE\b/i, what: 'DROP DATABASE' },
  { pattern: /\bGRANT\b[\s\S]{0,80}?\bPUBLIC\b/i, what: 'GRANT ... TO PUBLIC' },
] as const;

/** Replace comment and string-literal content with spaces, preserving line structure. */
export function stripNoise(sql: string): string {
  let out = '';
  let index = 0;
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

  while (index < sql.length) {
    const rest = sql.slice(index);

    const lineComment = /^--[^\n]*/.exec(rest);
    if (lineComment) {
      out += blank(lineComment[0]);
      index += lineComment[0].length;
      continue;
    }
    const blockComment = /^\/\*[\s\S]*?\*\//.exec(rest);
    if (blockComment) {
      out += blank(blockComment[0]);
      index += blockComment[0].length;
      continue;
    }
    const singleQuoted = /^'(?:[^']|'')*'/.exec(rest);
    if (singleQuoted) {
      out += blank(singleQuoted[0]);
      index += singleQuoted[0].length;
      continue;
    }
    const dollarQuoted = /^\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/.exec(rest);
    if (dollarQuoted) {
      out += blank(dollarQuoted[0]);
      index += dollarQuoted[0].length;
      continue;
    }
    out += sql[index] ?? '';
    index += 1;
  }
  return out;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

const headerValue = (sql: string, field: string): string | null => {
  const found = new RegExp(`^--\\s*${field}:\\s*(\\S+)\\s*$`, 'im').exec(sql);
  return found?.[1] ?? null;
};

/** Schema names referenced by qualified identifiers, CREATE/DROP SCHEMA and search_path. */
function referencedSchemas(code: string): ReadonlyArray<{ schema: string; index: number }> {
  const refs: Array<{ schema: string; index: number }> = [];
  const add = (schema: string | undefined, index: number): void => {
    if (schema !== undefined) refs.push({ schema: schema.toLowerCase(), index });
  };

  const qualified = /\b([a-z_][a-z0-9_]*)\.[a-z_][a-z0-9_]*/gi;
  let match: RegExpExecArray | null = qualified.exec(code);
  while (match !== null) {
    add(match[1], match.index);
    match = qualified.exec(code);
  }

  const schemaStatement =
    /\b(?:CREATE|DROP)\s+SCHEMA\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
  match = schemaStatement.exec(code);
  while (match !== null) {
    add(match[1], match.index);
    match = schemaStatement.exec(code);
  }

  const searchPath = /\bsearch_path\s*(?:=|TO)\s*([a-z_][a-z0-9_]*)/gi;
  match = searchPath.exec(code);
  while (match !== null) {
    add(match[1], match.index);
    match = searchPath.exec(code);
  }

  return refs;
}

/**
 * Object-creating statements whose target carries no schema qualification, and so lands in the
 * default schema.
 *
 * An index is the exception: PostgreSQL places it in the schema of the table it indexes, and
 * qualifying the index name is in fact an error unless it matches. So for an index the check
 * moves to the `ON` target, which is what actually decides the namespace.
 */
function unqualifiedObjects(code: string): ReadonlyArray<{ what: string; index: number }> {
  const found: Array<{ what: string; index: number }> = [];

  // `(?!IF\b)` stops the optional IF-NOT-EXISTS group from being skipped by backtracking, which
  // would otherwise let the regex read `IF` itself as the object name.
  const named =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|VIEW|SEQUENCE|TYPE|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?!IF\b)([a-z_][a-z0-9_]*)\b(?!\s*\.)/gi;
  let match: RegExpExecArray | null = named.exec(code);
  while (match !== null) {
    found.push({
      what: `${(match[1] ?? '').toUpperCase().replace(/\s+/g, ' ')} ${match[2] ?? ''}`,
      index: match.index,
    });
    match = named.exec(code);
  }

  const index =
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!IF\b)([a-z_][a-z0-9_]*)\s+ON\s+(?:ONLY\s+)?(?!ONLY\b)([a-z_][a-z0-9_]*)\b(?!\s*\.)/gi;
  match = index.exec(code);
  while (match !== null) {
    found.push({ what: `INDEX ${match[1] ?? ''} ON ${match[2] ?? ''}`, index: match.index });
    match = index.exec(code);
  }

  return found;
}

/**
 * Validate every migration in a directory. Returns violations rather than throwing, so the CLI
 * can report all of them at once instead of one per run.
 */
export function validateMigrations(dir: string): MigrationValidationResult {
  const violations: MigrationViolation[] = [];
  const migrations: Migration[] = [];
  const report = (check: MigrationCheckId, file: string, line: number, message: string): void => {
    violations.push({ check, severity: SEVERITY[check], file, line, message });
  };

  const entries = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
        .map((entry) => entry.name)
        .sort()
    : [];

  const seen = new Map<string, string>();

  for (const file of entries) {
    const parsed = FILE_NAME.exec(file);
    if (parsed === null) {
      report(
        'malformed-name',
        file,
        0,
        'file name must be NNNN_snake_case_slug.up.sql or .down.sql — a version that cannot be ' +
          'ordered cannot be applied deterministically',
      );
      continue;
    }

    const version = parsed[1] ?? '';
    const slug = parsed[2] ?? '';
    const direction = (parsed[3] ?? 'up') as Direction;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const code = stripNoise(sql);

    // --- header -------------------------------------------------------------------------------
    const declaredName = headerValue(sql, 'migration');
    const declaredDirection = headerValue(sql, 'direction');
    const owner = headerValue(sql, 'owner');

    if (declaredName !== `${version}_${slug}`) {
      report(
        'malformed-header',
        file,
        1,
        `header \`-- migration:\` is ${declaredName ?? 'absent'}, expected ${version}_${slug}`,
      );
    }
    if (declaredDirection !== direction) {
      report(
        'malformed-header',
        file,
        1,
        `header \`-- direction:\` is ${declaredDirection ?? 'absent'}, expected ${direction}`,
      );
    }
    if (owner === null) {
      report(
        'malformed-header',
        file,
        1,
        'header `-- owner:` is absent — every migration must name the schema it owns, or ' +
          'cross-owner access cannot be checked',
      );
    }

    migrations.push({ file, version, slug, direction, owner });

    // --- duplicate versions -------------------------------------------------------------------
    const key = `${version}.${direction}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      report(
        'duplicate-version',
        file,
        0,
        `version ${version} (${direction}) is already claimed by ${previous} — two migrations ` +
          'with one version apply in an undefined order',
      );
    } else {
      seen.set(key, file);
    }

    // --- transaction wrapping -----------------------------------------------------------------
    const hasBegin = /^\s*BEGIN\s*;/im.test(code);
    const hasCommit = /\bCOMMIT\s*;\s*$/i.test(code.trimEnd());
    if (!hasBegin || !hasCommit) {
      report(
        'non-transactional',
        file,
        1,
        'migration must be wrapped in BEGIN; ... COMMIT; — DDL that fails partway through ' +
          'otherwise leaves the schema in a state no rollback file describes',
      );
    }

    // --- schema ownership ---------------------------------------------------------------------
    if (owner !== null) {
      const ownerRecord: SchemaOwner | null = ownerOfSchema(owner);
      if (owner === FORBIDDEN_SCHEMA) {
        report(
          'public-schema',
          file,
          1,
          `\`${FORBIDDEN_SCHEMA}\` is on the default search_path, so anything in it belongs to ` +
            'every unit and is owned by none — declare a unit schema instead',
        );
      } else if (ownerRecord === null) {
        report(
          'unregistered-schema',
          file,
          1,
          `owner \`${owner}\` is not a schema derived from the architecture manifest — add the ` +
            `unit to platform/architecture/manifest.ts first (known: ${knownSchemas().length} schemas)`,
        );
      }
    }

    for (const ref of referencedSchemas(code)) {
      const line = lineOf(code, ref.index);
      if (ref.schema === FORBIDDEN_SCHEMA) {
        report(
          'public-schema',
          file,
          line,
          `references \`${FORBIDDEN_SCHEMA}\` — module and kernel data must live in an owned ` +
            'schema, never in the default one',
        );
        continue;
      }
      if (ownerOfSchema(ref.schema) === null) {
        report(
          'unregistered-schema',
          file,
          line,
          `references schema \`${ref.schema}\`, which no unit in the architecture manifest owns`,
        );
        continue;
      }
      if (owner !== null && ref.schema !== owner) {
        report(
          'cross-owner-schema',
          file,
          line,
          `owned by \`${owner}\` but references \`${ref.schema}\` — a migration may not reach ` +
            "into another unit's namespace; go through that unit's contract instead",
        );
      }
    }

    for (const object of unqualifiedObjects(code)) {
      report(
        'public-schema',
        file,
        lineOf(code, object.index),
        `CREATE ${object.what} has no schema qualification, so it lands in \`${FORBIDDEN_SCHEMA}\``,
      );
    }

    // --- unsafe statements ---------------------------------------------------------------------
    for (const rule of ALWAYS_UNSAFE) {
      const found = rule.pattern.exec(code);
      if (found !== null) {
        report(
          'unsafe-statement',
          file,
          lineOf(code, found.index),
          `${rule.what} is never permitted in a migration`,
        );
      }
    }
    if (direction === 'up') {
      for (const rule of DESTRUCTIVE) {
        const found = rule.pattern.exec(code);
        if (found !== null) {
          report(
            'unsafe-statement',
            file,
            lineOf(code, found.index),
            `${rule.what} in a forward migration destroys data — forward migrations are ` +
              'additive so a deploy can be halted without loss; put the removal in the rollback',
          );
        }
      }
      if (/\bDELETE\s+FROM\b(?![\s\S]{0,400}?\bWHERE\b)/i.test(code)) {
        const found = /\bDELETE\s+FROM\b/i.exec(code);
        report(
          'unsafe-statement',
          file,
          found === null ? 1 : lineOf(code, found.index),
          'DELETE FROM without a WHERE clause removes every row',
        );
      }
    }
  }

  // --- pairing --------------------------------------------------------------------------------
  const ups = migrations.filter((m) => m.direction === 'up');
  const downs = migrations.filter((m) => m.direction === 'down');
  const downKeys = new Set(downs.map((m) => `${m.version}_${m.slug}`));
  const upKeys = new Set(ups.map((m) => `${m.version}_${m.slug}`));

  for (const up of ups) {
    if (!downKeys.has(`${up.version}_${up.slug}`)) {
      report(
        'missing-rollback',
        up.file,
        0,
        `no rollback file — expected ${up.version}_${up.slug}.down.sql. A forward migration that ` +
          'cannot be reversed turns a bad deploy into an outage',
      );
    }
  }
  for (const down of downs) {
    if (!upKeys.has(`${down.version}_${down.slug}`)) {
      report(
        'orphan-rollback',
        down.file,
        0,
        `rollback with no forward migration — expected ${down.version}_${down.slug}.up.sql`,
      );
    }
  }

  return { filesScanned: entries.length, migrations, violations };
}
