/**
 * M-07 Matching — the immutability boundary.
 *
 * A candidate's `evidence` is an open object, so a shallow freeze would hand a caller a frozen
 * wrapper around a mutable explanation of why something was matched. Everything is deep-frozen and
 * copied.
 *
 * Owned by: M-07 Matching.
 */

import type { MatchCandidate, MatchRun, RungAttempt } from './types.ts';

function sealDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(sealDeep));
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = sealDeep(entry);
  return Object.freeze(copy);
}

export function sealMatchRun(run: MatchRun): MatchRun {
  return Object.freeze({ ...run });
}

export function sealMatchRuns(runs: readonly MatchRun[]): readonly MatchRun[] {
  return Object.freeze(runs.map(sealMatchRun));
}

export function sealRungAttempt(attempt: RungAttempt): RungAttempt {
  return Object.freeze({ ...attempt });
}

export function sealRungAttempts(attempts: readonly RungAttempt[]): readonly RungAttempt[] {
  return Object.freeze(attempts.map(sealRungAttempt));
}

export function sealCandidate(candidate: MatchCandidate): MatchCandidate {
  return Object.freeze({
    ...candidate,
    evidence: sealDeep(candidate.evidence) as Readonly<Record<string, unknown>>,
  });
}

export function sealCandidates(candidates: readonly MatchCandidate[]): readonly MatchCandidate[] {
  return Object.freeze(candidates.map(sealCandidate));
}
