/**
 * Local database provisioning CLI (FND-002c).
 *
 *   node platform/db/provision-cli.ts up          start PostgreSQL in the background
 *   node platform/db/provision-cli.ts ready       wait until it accepts connections
 *   node platform/db/provision-cli.ts down        stop it, KEEPING application data
 *   node platform/db/provision-cli.ts reset --yes drop and recreate the application database
 *   node platform/db/provision-cli.ts destroy --yes  remove the container AND its data volume
 *
 * DEVELOPMENT ONLY. This drives compose.yaml, which provisions a loopback-bound container with
 * credentials from an untracked .env. It is not a deployment tool and must never be pointed at a
 * shared environment.
 *
 * The two commands that can lose data — `reset` and `destroy` — require an explicit `--yes`.
 * A destructive default is a destructive accident waiting for a tired operator; `db:down` is the
 * one that stops the service, and it deliberately keeps the volume.
 *
 * Exit 0 = success. Exit 1 = the underlying command failed. Exit 2 = misuse.
 *
 * Owned by: FND-002c (data foundation — local provisioning).
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Commands that can destroy data and therefore require --yes. */
export const DESTRUCTIVE_COMMANDS: readonly string[] = ['reset', 'destroy'];

export const PROVISION_COMMANDS: readonly string[] = [
  'up',
  'ready',
  'down',
  ...DESTRUCTIVE_COMMANDS,
];

/** Compose service and volume names, kept in one place so the messages cannot drift. */
export const SERVICE = 'postgres';
export const DATA_VOLUME = 'jaya-postgres-data';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const composeFile = path.join(repoRoot, 'compose.yaml');

const argv = process.argv.slice(2);
const command = argv[0] ?? '';
const flag = (name: string): boolean => argv.includes(`--${name}`);

const fail = (message: string, code: number): never => {
  console.error(message);
  process.exit(code);
};

/** Run a command, streaming its output. Returns its exit code. */
function run(binary: string, args: readonly string[]): number {
  const result = spawnSync(binary, [...args], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error !== undefined) {
    const reason = result.error.message;
    if (/ENOENT/.test(reason)) {
      fail(
        `\`${binary}\` was not found on PATH. Local provisioning needs Docker with the Compose ` +
          'plugin — see docs/CONTRIBUTING.md section 6.8.',
        1,
      );
    }
    fail(`${binary} could not be started: ${reason}`, 1);
  }
  return result.status ?? 1;
}

const compose = (...args: readonly string[]): number =>
  run('docker', ['compose', '--file', composeFile, ...args]);

/** Read a variable out of the environment, or explain that .env has not been created. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return fail(
      `${name} is not set. Copy the committed example and edit it if you want different ` +
        'values:\n\n    cp .env.example .env\n',
      2,
    );
  }
  return value.trim();
}

function main(): void {
  if (!PROVISION_COMMANDS.includes(command)) {
    fail(`unknown command "${command}". Expected: ${PROVISION_COMMANDS.join(' | ')}`, 2);
  }

  // Fail closed on anything that can lose data. Checked before the command runs, not inside it.
  if (DESTRUCTIVE_COMMANDS.includes(command) && !flag('yes')) {
    fail(
      `refusing to run \`${command}\` without --yes.\n\n` +
        (command === 'destroy'
          ? `  destroy removes the ${DATA_VOLUME} volume. Every row in the local database is lost.\n` +
            '  If you only want to stop the service, use `npm run db:down`, which keeps the data.\n'
          : '  reset drops and recreates the application database. Every row is lost.\n' +
            '  If you only want to re-apply pending migrations, use `npm run db:migrate`.\n'),
      2,
    );
  }

  switch (command) {
    case 'up': {
      const code = compose('up', '--detach');
      if (code !== 0) fail('failed to start the local database', code);
      console.log('');
      console.log('Started. Wait for readiness with: npm run db:ready');
      return;
    }

    case 'ready': {
      // Compose already knows what healthy means — the healthcheck in compose.yaml. Waiting on it
      // is better than re-implementing a poll loop that disagrees with it.
      const code = compose('up', '--detach', '--wait', '--wait-timeout', '90');
      if (code !== 0) {
        fail(
          'the database did not become healthy within 90s.\n' +
            `  Inspect it with: docker compose --file compose.yaml logs ${SERVICE}\n` +
            '  A corrupt data volume is the usual cause; `npm run db:destroy -- --yes` clears it.',
          code,
        );
      }
      console.log('');
      console.log('Database is healthy and accepting connections.');
      return;
    }

    case 'down': {
      // No --volumes: stopping is not destroying. Data survives until `destroy`.
      const code = compose('down');
      if (code !== 0) fail('failed to stop the local database', code);
      console.log('');
      console.log(`Stopped. Application data is preserved in the ${DATA_VOLUME} volume.`);
      return;
    }

    case 'reset': {
      const user = required('POSTGRES_USER');
      const database = required('POSTGRES_DB');
      // Connect to `postgres`, not to the database being dropped.
      const psql = (sql: string): number =>
        compose(
          'exec',
          '-T',
          SERVICE,
          'psql',
          '-v',
          'ON_ERROR_STOP=1',
          '-U',
          user,
          '-d',
          'postgres',
          '-c',
          sql,
        );

      if (psql(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE);`) !== 0) {
        fail(`failed to drop ${database}`, 1);
      }
      if (psql(`CREATE DATABASE "${database}" OWNER "${user}";`) !== 0) {
        fail(`failed to recreate ${database}`, 1);
      }
      console.log('');
      console.log(`Recreated ${database}, empty. Apply migrations with: npm run db:migrate`);
      return;
    }

    case 'destroy': {
      const code = compose('down', '--volumes');
      if (code !== 0) fail('failed to remove the local database and its volume', code);
      console.log('');
      console.log(`Removed the container and the ${DATA_VOLUME} volume. All local data is gone.`);
      return;
    }

    default:
      fail(`unhandled command "${command}"`, 2);
  }
}

main();
