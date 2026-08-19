/**
 * The integration-suite safety contract (FND-002c correction).
 *
 * A suite that applies migrations to the development database destroys a contributor's local work,
 * and it does so silently — the tests pass, and the damage is only noticed later. The previous
 * revision did exactly that, alongside a guarded lifecycle that proved a *different* suite was
 * safe. Prose in a header comment would not have stopped it, and did not.
 *
 * So the rule is executable: within tests/integration, only the harness may build a database
 * connection, and only the harness may read DATABASE_URL. Everything else takes its target from
 * `withTestDatabase`, which derives a `_test` database and runs it past assertSafeTestTarget
 * before anything is created.
 *
 * Static analysis rather than behavioural: this needs to hold when no PostgreSQL exists, which is
 * exactly when nobody is running the live suites and a mistake would go unnoticed longest.
 *
 * Owned by: FND-002c (data foundation). Describes test structure; contains no business logic.
 */

/** Directory whose contents this contract governs. */
export const INTEGRATION_DIR = 'tests/integration';

/** The one file permitted to construct connections and read the configured URL. */
export const HARNESS_FILE = 'harness.ts';

export type IntegrationSafetyId =
  | 'harness-only-connections'
  | 'harness-only-configuration'
  | 'guarded-lifecycle'
  | 'seeded-cleanup'
  | 'harness-guards';

export const INTEGRATION_SAFETY_IDS: readonly IntegrationSafetyId[] = [
  'harness-only-connections',
  'harness-only-configuration',
  'guarded-lifecycle',
  'seeded-cleanup',
  'harness-guards',
];

export interface IntegrationSafetyViolation {
  readonly id: IntegrationSafetyId;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface IntegrationFile {
  /** File name within tests/integration. */
  readonly name: string;
  readonly source: string;
}

/** Blank comment and string content so a rule cannot be satisfied — or broken — by prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match) => match.replace(/[^\n]/g, ' '));
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/**
 * Check every integration file. Returns one violation per offending line; an empty array means no
 * suite can reach the development database.
 */
export function checkIntegrationSafety(
  files: readonly IntegrationFile[],
): IntegrationSafetyViolation[] {
  const violations: IntegrationSafetyViolation[] = [];
  const report = (id: IntegrationSafetyId, file: string, line: number, message: string): void => {
    violations.push({ id, file, line, message });
  };

  const harness = files.find((file) => file.name === HARNESS_FILE);
  if (harness === undefined) {
    report(
      'harness-guards',
      HARNESS_FILE,
      0,
      `${INTEGRATION_DIR}/${HARNESS_FILE} is missing — there is no sanctioned way to reach a ` +
        'database, so every suite would have to improvise one',
    );
  }

  for (const file of files) {
    const code = stripComments(file.source);
    const isHarness = file.name === HARNESS_FILE;

    // --- only the harness may construct a connection -------------------------------------------
    if (!isHarness) {
      const constructions = [...code.matchAll(/new\s+PostgresDatabase\s*\(/g)];
      for (const match of constructions) {
        report(
          'harness-only-connections',
          file.name,
          lineOf(code, match.index),
          'constructs a database connection directly. Use withTestDatabase from the harness — a ' +
            'connection built here can be aimed at the development database, and a migration ' +
            'applied to it destroys a contributor’s local work',
        );
      }

      // --- and only the harness may read the configured target ---------------------------------
      for (const pattern of [
        /process\.env\s*\[\s*DATABASE_URL_ENV\s*\]/g,
        /process\.env\s*\.\s*DATABASE_URL/g,
        /process\.env\s*\[\s*['"]DATABASE_URL['"]\s*\]/g,
      ]) {
        for (const match of [...code.matchAll(pattern)]) {
          report(
            'harness-only-configuration',
            file.name,
            lineOf(code, match.index),
            'reads the configured DATABASE_URL. The development database is connection input, ' +
              'not a target; the harness derives the `_test` database from it',
          );
        }
      }
    }

    // --- migration calls must be inside the guarded lifecycle -----------------------------------
    const runsMigrations = /\b(?:migrateUp|migrateDown)\s*\(/.test(code);
    if (runsMigrations && !isHarness && !/withTestDatabase\s*\(/.test(code)) {
      const match = /\b(?:migrateUp|migrateDown)\s*\(/.exec(code);
      report(
        'guarded-lifecycle',
        file.name,
        match === null ? 0 : lineOf(code, match.index),
        'applies or rolls back migrations without entering withTestDatabase, so the target is ' +
          'whatever the caller chose rather than a guarded, disposable database',
      );
    }
  }

  // --- anything deliberately left behind must be cleaned up unconditionally -------------------
  // A suite that plants a leftover database has to remove it in a `finally`. Cleanup that only
  // runs on the success path is worse than none: the leftover survives a failing assertion and
  // the next run of the very same test can then pass for the wrong reason.
  for (const file of files) {
    const code = stripComments(file.source);
    if (file.name === HARNESS_FILE) continue;
    if (!/seedLeftoverTestDatabase\s*\(/.test(code)) continue;

    const guarded = /finally\s*\{[\s\S]{0,400}?removeTestDatabase\s*\(/.test(code);
    if (!guarded) {
      const match = /seedLeftoverTestDatabase\s*\(/.exec(code);
      report(
        'seeded-cleanup',
        file.name,
        match === null ? 0 : lineOf(code, match.index),
        'plants a leftover database but does not remove it in a finally block, so a failing ' +
          'assertion would leave it on the server for the next run to inherit',
      );
    }
  }

  // --- the harness must actually guard -----------------------------------------------------------
  if (harness !== undefined) {
    const code = stripComments(harness.source);
    const required: ReadonlyArray<{ pattern: RegExp; message: string }> = [
      {
        pattern: /assertSafeTestTarget\s*\(/,
        message: 'the harness no longer calls assertSafeTestTarget',
      },
      {
        pattern: /deriveTestDatabaseUrl\s*\(/,
        message: 'the harness no longer derives the test database from the configured URL',
      },
      {
        pattern: /createTestDatabase\s*\(/,
        message: 'the harness no longer creates the test database',
      },
      {
        pattern: /finally\s*\{\s*await\s+dropTestDatabase\s*\(/,
        message:
          'the harness no longer drops the test database in a finally block — cleanup that only ' +
          'runs on success leaves a failed run’s wreckage for the next one',
      },
      {
        pattern: /export const liveTestOptions/,
        message:
          'the harness no longer exposes the skip options, so suites would fail rather ' +
          'than skip when nothing is configured',
      },
      {
        pattern: /loadEnvFile\s*\(/,
        message:
          'the harness no longer loads .env, so `cp .env.example .env` would stop being ' +
          'sufficient and the suites would skip on a configured machine',
      },
    ];
    for (const { pattern, message } of required) {
      if (!pattern.test(code)) report('harness-guards', HARNESS_FILE, 0, message);
    }

    // The harness may open the development database, but only to read status — never to migrate.
    const developmentMigration =
      /developmentUrl\s*\(\s*\)[\s\S]{0,200}?\b(?:migrateUp|migrateDown)\s*\(/.exec(code);
    if (developmentMigration !== null) {
      report(
        'harness-guards',
        HARNESS_FILE,
        lineOf(code, developmentMigration.index),
        'the harness itself aims a migration at the development URL',
      );
    }
  }

  return violations;
}
