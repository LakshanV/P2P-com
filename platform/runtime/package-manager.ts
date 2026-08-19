/**
 * Package-manager pin parsing for the JAYA platform substrate.
 *
 * `engines.npm` states the *supported range*; `packageManager` states the *exact version the
 * project is developed and verified against*. The two answer different questions, and
 * conflating them is how a repository ends up claiming reproducibility it does not have:
 * a lockfile guarantees the dependency graph, not the tool that resolves and installs it.
 *
 * Only an exact `name@major.minor.patch` pin is accepted, with the optional integrity suffix
 * Corepack appends. A range in `packageManager` is rejected rather than tolerated — a pin
 * that permits a span of versions is not a pin.
 *
 * Owned by: FND-001a (toolchain substrate). No business logic.
 */

export interface PackageManagerPin {
  /** Tool name, e.g. `npm`, `pnpm`, `yarn`. */
  readonly name: string;
  /** Exact `major.minor.patch` version. */
  readonly version: string;
}

/** `name@x.y.z`, optionally followed by the `+<integrity>` suffix Corepack writes. */
const PIN_PATTERN = /^([a-z][a-z0-9-]*)@(\d+\.\d+\.\d+)(?:\+[A-Za-z0-9._-]+)?$/;

/**
 * Parse a `package.json` `packageManager` value.
 *
 * @throws if the value is not an exact `name@major.minor.patch` pin. Range syntax
 *   (`^`, `~`, `>=`, `x`, `*`) and partial versions are rejected, not normalised.
 */
export function parsePackageManager(value: string): PackageManagerPin {
  const match = PIN_PATTERN.exec(value.trim());
  if (match === null) {
    throw new Error(
      `Invalid packageManager "${value}": expected an exact pin of the form "name@major.minor.patch"`,
    );
  }

  const [, name, version] = match;
  if (name === undefined || version === undefined) {
    throw new Error(`Invalid packageManager "${value}": could not read name and version`);
  }

  return { name, version };
}
