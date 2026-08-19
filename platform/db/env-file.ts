/**
 * `.env` loading (FND-002c correction).
 *
 * The documented workflow is `cp .env.example .env`, and it has to be sufficient. Before this,
 * every `db:*` command and every integration suite additionally required the contributor to
 * export DATABASE_URL by hand — an undocumented step, and one whose absence looked exactly like
 * "no database configured", so the suites skipped and reported that as an honest result.
 *
 * So the entry points load `.env` themselves. Deliberately minimal, and deliberately
 * lowest-precedence: a variable already present in the environment always wins, because a shell
 * export or a CI secret is a more specific statement of intent than a file on disk.
 *
 * No dependency for this. `.env` is a handful of `KEY=VALUE` lines, and a parser small enough to
 * read in one sitting is easier to trust than one more package in the supply chain.
 *
 * Owned by: FND-002c (data foundation — local provisioning).
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Repository root, from this file's location, whether run as .ts or as built .js. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const ENV_FILE = '.env';
export const ENV_EXAMPLE_FILE = '.env.example';

/**
 * Parse `.env` content into key/value pairs.
 *
 * Supports the subset the example uses and nothing more: `KEY=VALUE`, `#` comments, blank lines,
 * optional surrounding quotes, optional `export ` prefix. Anything else is ignored rather than
 * guessed at — a silent misparse of a connection string is worse than an unset variable.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;

    const key = match[1] ?? '';
    let value = (match[2] ?? '').trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // An unquoted trailing comment is a comment. A quoted one is part of the value.
      value = value.replace(/\s+#.*$/, '').trim();
    }

    values[key] = value;
  }
  return values;
}

export interface LoadResult {
  /** Absolute path that was read, or null when no .env exists. */
  readonly file: string | null;
  /** Variables actually applied — those not already set in the environment. */
  readonly applied: readonly string[];
  /** Variables present in the file but already set, and therefore left alone. */
  readonly skipped: readonly string[];
}

/**
 * Load `.env` into `process.env`, without overriding anything already set.
 *
 * Returns a description of what happened rather than logging, so a CLI can report it and a test
 * can assert on it. A missing `.env` is not an error here: the caller decides whether the
 * variables it needs are present, and says something useful when they are not.
 */
export function loadEnvFile(
  root: string = REPO_ROOT,
  env: NodeJS.ProcessEnv = process.env,
): LoadResult {
  const file = path.join(root, ENV_FILE);
  if (!fs.existsSync(file)) return { file: null, applied: [], skipped: [] };

  const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      applied.push(key);
    } else {
      skipped.push(key);
    }
  }
  return { file, applied, skipped };
}

/**
 * The message to print when a required variable is missing. One sentence, one command — the
 * contributor should not have to read the documentation to get unstuck.
 */
export function missingEnvMessage(name: string): string {
  return (
    `${name} is not set, and no ${ENV_FILE} supplied it.\n\n` +
    `    cp ${ENV_EXAMPLE_FILE} ${ENV_FILE}\n\n` +
    `Everything the \`db:*\` commands and the integration suites need is in ${ENV_EXAMPLE_FILE}; ` +
    'copying it is the whole setup. A shell export still wins over the file if you need one.'
  );
}
