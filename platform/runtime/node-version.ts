/**
 * Runtime version constraints for the JAYA platform substrate.
 *
 * `package.json` pins the runtime with `engines.node`, but npm only warns on a mismatch by
 * default. These helpers make the pin checkable from code and from tests, so "the runtime is
 * pinned" is a verifiable statement rather than a declaration in a manifest.
 *
 * Scope: only the `>=x.y.z` form actually used by this repository's `engines.node` is
 * supported. Anything else throws rather than guessing — a version check that silently
 * accepts a range it does not understand is worse than no check at all.
 *
 * Owned by: FND-001a (toolchain substrate). No business logic.
 */

export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Parse a semantic version string.
 *
 * Accepts an optional leading `v` and ignores any prerelease or build metadata, so the
 * values Node itself reports (`process.versions.node`, e.g. `22.18.0` or `23.0.0-nightly`)
 * parse without special handling at the call site.
 *
 * @throws if the value is not `major.minor.patch` with non-negative integer components.
 */
export function parseVersion(value: string): SemanticVersion {
  const trimmed = value.trim().replace(/^v/i, '');
  const core = trimmed.split(/[-+]/)[0] ?? '';
  const parts = core.split('.');

  if (parts.length !== 3) {
    throw new Error(`Invalid version "${value}": expected major.minor.patch`);
  }

  const numbers = parts.map((part) => {
    if (!/^\d+$/.test(part)) {
      throw new Error(`Invalid version "${value}": "${part}" is not a non-negative integer`);
    }
    return Number.parseInt(part, 10);
  });

  const [major, minor, patch] = numbers;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Invalid version "${value}": expected major.minor.patch`);
  }

  return { major, minor, patch };
}

/** Compare two versions. Negative if a < b, zero if equal, positive if a > b. */
export function compareVersions(a: SemanticVersion, b: SemanticVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Test whether `actual` satisfies a minimum-version range of the form `>=x.y.z`.
 *
 * @throws if the range is not in that form — see the scope note at the top of this file.
 */
export function satisfiesMinimum(actual: string, range: string): boolean {
  const match = /^>=\s*(.+)$/.exec(range.trim());
  if (match === null) {
    throw new Error(
      `Unsupported version range "${range}": only the ">=x.y.z" form is supported here`,
    );
  }
  const minimum = match[1];
  if (minimum === undefined) {
    throw new Error(`Unsupported version range "${range}": no minimum version found`);
  }
  return compareVersions(parseVersion(actual), parseVersion(minimum)) >= 0;
}
