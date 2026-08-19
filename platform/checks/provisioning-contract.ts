/**
 * The local-provisioning contract (FND-002c).
 *
 * compose.yaml and its surrounding commands carry guarantees that are cheap to state and easy to
 * lose: an exact database version, a health check that means "will accept our connection", a data
 * volume that survives a stop, credentials that live outside the repository, and a confirmation
 * flag on everything that can destroy data.
 *
 * Each of those degrades silently. A floating `postgres:16` still starts. A deleted healthcheck
 * still runs, it just makes `db:ready` meaningless. A password moved from .env into compose.yaml
 * works perfectly until the day it is public. So the guarantees are stated here as executable
 * assertions over the real files.
 *
 * Text-based on purpose: the repository ships no YAML parser, and every guarantee here is
 * textual — an exact tag, a literal flag name, the absence of a secret.
 *
 * Owned by: FND-002c (data foundation). Describes provisioning; contains no business logic.
 */

export const COMPOSE_PATH = 'compose.yaml';
export const ENV_EXAMPLE_PATH = '.env.example';

/** The only password permitted to appear in a committed file. */
export const PLACEHOLDER_PASSWORD = 'jaya_local_dev_only';

/** Minimum major version. v3 selects PostgreSQL 16 or later. */
export const MINIMUM_POSTGRES_MAJOR = 16;

export type ProvisioningContractId =
  | 'service-definition'
  | 'pinned-version'
  | 'health-check'
  | 'persistent-data'
  | 'loopback-only'
  | 'no-committed-secrets'
  | 'env-example'
  | 'commands'
  | 'destructive-confirmation'
  | 'safe-target-guard'
  | 'development-only';

export const PROVISIONING_CONTRACT_IDS: readonly ProvisioningContractId[] = [
  'service-definition',
  'pinned-version',
  'health-check',
  'persistent-data',
  'loopback-only',
  'no-committed-secrets',
  'env-example',
  'commands',
  'destructive-confirmation',
  'safe-target-guard',
  'development-only',
];

export interface ProvisioningViolation {
  readonly id: ProvisioningContractId;
  readonly message: string;
}

/** The real files, passed in so a test can plant a weakened variant of any one of them. */
export interface ProvisioningArtifacts {
  readonly compose: string;
  readonly envExample: string;
  readonly gitignore: string;
  /** package.json as raw text, so a missing script is a textual absence like everything else. */
  readonly packageJson: string;
  readonly provisionCli: string;
  readonly testDatabase: string;
  /** Repo-relative paths git reports as tracked. Used to catch a committed .env. */
  readonly trackedPaths: readonly string[];
}

/** Commands a contributor must be able to run, and the file that must define each. */
export const REQUIRED_SCRIPTS: readonly string[] = [
  'db:up',
  'db:ready',
  'db:migrate',
  'db:status',
  'db:reset',
  'db:down',
  'db:destroy',
];

/** Environment variables compose.yaml requires, which the example must therefore document. */
export const REQUIRED_ENV_VARS: readonly string[] = [
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_PORT',
  'DATABASE_URL',
];

/**
 * Values that look like a real secret rather than a placeholder. Deliberately blunt: the cost of a
 * false positive is renaming a fixture, and the cost of a false negative is a live credential in
 * git history forever.
 */
const SECRET_SHAPED = [
  /\bpassword\s*[:=]\s*['"]?(?!\$\{)(?!jaya_local_dev_only\b)[A-Za-z0-9!@#$%^&*_+-]{8,}/i,
  /\b(?:secret|token|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{16,}/i,
];

export function checkProvisioningContract(
  artifacts: ProvisioningArtifacts,
): ProvisioningViolation[] {
  const violations: ProvisioningViolation[] = [];
  const report = (id: ProvisioningContractId, message: string): void => {
    violations.push({ id, message });
  };

  const { compose, envExample, gitignore, packageJson, provisionCli, testDatabase } = artifacts;

  // --- the service itself ----------------------------------------------------------------------
  if (!/^\s{2}postgres:\s*$/m.test(compose)) {
    report('service-definition', 'compose.yaml declares no `postgres:` service');
  }

  const image = /^\s*image:\s*postgres:(\S+)\s*$/m.exec(compose);
  if (image === null) {
    report('pinned-version', 'compose.yaml declares no postgres image');
  } else {
    const tag = image[1] ?? '';
    const version = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(tag);
    if (tag === 'latest' || version === null || version[2] === undefined) {
      report(
        'pinned-version',
        `image tag "${tag}" is not an exact version — a floating tag means the database under ` +
          'your tests can change without a line of this repository changing',
      );
    } else if (Number.parseInt(version[1] ?? '0', 10) < MINIMUM_POSTGRES_MAJOR) {
      report(
        'pinned-version',
        `image tag "${tag}" is older than the selected PostgreSQL ${MINIMUM_POSTGRES_MAJOR}`,
      );
    }
  }

  if (!/^\s*healthcheck:\s*$/m.test(compose)) {
    report(
      'health-check',
      'compose.yaml declares no healthcheck — `db:ready` would report success as soon as the ' +
        'container starts, before the server accepts connections',
    );
  } else {
    if (!/pg_isready/.test(compose)) {
      report(
        'health-check',
        'the healthcheck does not use pg_isready, so "healthy" no longer means "will accept a ' +
          'connection"',
      );
    }
    for (const field of ['interval', 'retries']) {
      if (!new RegExp(`^\\s*${field}:`, 'm').test(compose)) {
        report('health-check', `the healthcheck declares no \`${field}\``);
      }
    }
  }

  if (!/\/var\/lib\/postgresql\/data/.test(compose)) {
    report('persistent-data', 'no volume is mounted at the PostgreSQL data directory');
  }
  if (!/^volumes:\s*$/m.test(compose)) {
    report(
      'persistent-data',
      'compose.yaml declares no named volume — an anonymous volume is discarded on `down`, so ' +
        'stopping the service would silently destroy application data',
    );
  }

  if (!/127\.0\.0\.1:\$\{POSTGRES_PORT/.test(compose)) {
    report(
      'loopback-only',
      'the published port is not bound to 127.0.0.1 — a database whose example credentials are ' +
        'committed must not be reachable from the network',
    );
  }

  // --- credentials -----------------------------------------------------------------------------
  for (const variable of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']) {
    if (!new RegExp(`\\$\\{${variable}`).test(compose)) {
      report(
        'no-committed-secrets',
        `${variable} is not read from the environment in compose.yaml — a literal here is a ` +
          'committed credential',
      );
    }
  }
  for (const pattern of SECRET_SHAPED) {
    if (pattern.test(compose)) {
      report('no-committed-secrets', 'compose.yaml contains something shaped like a real secret');
    }
    if (pattern.test(envExample)) {
      report(
        'no-committed-secrets',
        `${ENV_EXAMPLE_PATH} contains something shaped like a real secret — the example may only ` +
          `carry the placeholder "${PLACEHOLDER_PASSWORD}"`,
      );
    }
  }
  if (!envExample.includes(PLACEHOLDER_PASSWORD)) {
    report(
      'no-committed-secrets',
      `${ENV_EXAMPLE_PATH} no longer uses the known placeholder password, so the contract can no ` +
        'longer tell a placeholder from a real credential',
    );
  }
  if (!/^\.env$/m.test(gitignore) || !/^\.env\.\*$/m.test(gitignore)) {
    report('no-committed-secrets', '.env and .env.* are not both git-ignored');
  }
  if (!/^!\.env\.example$/m.test(gitignore)) {
    report('no-committed-secrets', `${ENV_EXAMPLE_PATH} is not exempted from the ignore rule`);
  }
  for (const tracked of artifacts.trackedPaths) {
    if (/^\.env($|\.)/.test(tracked) && tracked !== ENV_EXAMPLE_PATH) {
      report('no-committed-secrets', `${tracked} is tracked by git — credentials must never be`);
    }
  }

  // --- the example documents what compose needs -------------------------------------------------
  for (const variable of REQUIRED_ENV_VARS) {
    if (!new RegExp(`^${variable}=`, 'm').test(envExample)) {
      report('env-example', `${ENV_EXAMPLE_PATH} does not document ${variable}`);
    }
  }

  // --- commands ---------------------------------------------------------------------------------
  for (const script of REQUIRED_SCRIPTS) {
    if (!new RegExp(`"${script}"\\s*:`).test(packageJson)) {
      report('commands', `package.json declares no \`${script}\` script`);
    }
  }

  // --- destructive confirmation -----------------------------------------------------------------
  if (!/DESTRUCTIVE_COMMANDS/.test(provisionCli)) {
    report('destructive-confirmation', 'the CLI no longer names its destructive commands');
  }
  for (const destructive of ['reset', 'destroy']) {
    if (!new RegExp(`'${destructive}'`).test(provisionCli)) {
      report('destructive-confirmation', `\`${destructive}\` is no longer a declared command`);
    }
  }
  if (!/DESTRUCTIVE_COMMANDS\.includes\(command\)\s*&&\s*!flag\('yes'\)/.test(provisionCli)) {
    report(
      'destructive-confirmation',
      'the CLI no longer refuses a destructive command without --yes — a destructive default is ' +
        'a destructive accident waiting for a tired operator',
    );
  }
  if (/--volumes/.test(provisionCli) && !/case 'destroy'/.test(provisionCli)) {
    report(
      'destructive-confirmation',
      'a volume-removing command exists outside the guarded `destroy` branch',
    );
  }

  // --- test-target safety -------------------------------------------------------------------------
  if (!/export function assertSafeTestTarget/.test(testDatabase)) {
    report('safe-target-guard', 'the test-database module exports no target guard');
  }
  for (const required of ['LOCAL_HOSTS', 'TEST_DATABASE_SUFFIX', 'FORBIDDEN_NAME_MARKERS']) {
    if (!new RegExp(`export const ${required}`).test(testDatabase)) {
      report('safe-target-guard', `${required} is no longer declared`);
    }
  }
  for (const lifecycle of ['createTestDatabase', 'dropTestDatabase']) {
    const body = new RegExp(
      `export async function ${lifecycle}[\\s\\S]{0,400}?assertSafeTestTarget\\(`,
    );
    if (!body.test(testDatabase)) {
      report(
        'safe-target-guard',
        `${lifecycle} no longer calls assertSafeTestTarget before acting — a lifecycle function ` +
          'that trusts its caller is not a guard',
      );
    }
  }

  // --- development-only ----------------------------------------------------------------------------
  if (!/DEVELOPMENT ONLY/.test(compose)) {
    report(
      'development-only',
      'compose.yaml no longer states that it is development-only, which is the sentence that ' +
        'stops it being copied into a deployment',
    );
  }
  if (!/DEVELOPMENT ONLY/.test(provisionCli)) {
    report('development-only', 'the provisioning CLI no longer states that it is development-only');
  }

  return violations;
}
