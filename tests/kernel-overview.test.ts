/**
 * The kernel overview must describe the kernel that exists (FND-003b, documentation accuracy).
 *
 * `kernel/README.md` and the header of `kernel/configuration/index.ts` both claimed, after K-08 was
 * delivered, that one kernel component existed and that K-08 Events did not. Neither claim was
 * true, and neither is the sort of thing that fails a build — prose drifts silently, and the two
 * places a reader looks first for "what is in the kernel" were the two places that were wrong.
 *
 * Under-reporting the kernel has a specific cost: it is how a component gets built twice, or how a
 * reader concludes a dependency is unavailable and works around something that is already there.
 *
 * So this reads the real files and derives the truth from the filesystem and the manifest rather
 * than from a number written here. A component counts as implemented when it has a `CONTRACT.md`,
 * which is the repository's own convention for "this component has a fixed public contract"; when
 * K-06 lands, these tests demand that the README mentions it without anybody editing this file.
 *
 * The tests are deliberately one-sided. They fail on *under*-reporting — claiming fewer components
 * than exist, or claiming K-08 is absent — and on over-claiming completeness, but they say nothing
 * about wording otherwise. A documentation test that pins prose is a documentation test that gets
 * deleted.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KERNEL_COMPONENTS } from '../platform/architecture/manifest.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL_DIR = path.join(REPO_ROOT, 'kernel');

const KERNEL_README_PATH = path.join(KERNEL_DIR, 'README.md');
const CONFIG_INDEX_PATH = path.join(KERNEL_DIR, 'configuration', 'index.ts');

const KERNEL_README = readFileSync(KERNEL_README_PATH, 'utf8');
const CONFIG_INDEX = readFileSync(CONFIG_INDEX_PATH, 'utf8');

const IDENTITY_INDEX_PATH = path.join(KERNEL_DIR, 'identity', 'index.ts');
const IDENTITY_INDEX = readFileSync(IDENTITY_INDEX_PATH, 'utf8');

/** The doc comment at the top of a source file — the part a consumer reads before the exports. */
function leadingComment(source: string): string {
  const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  assert.ok(match !== null, 'expected a leading doc comment');
  return match[1] ?? '';
}

/**
 * Components that are implemented, according to the filesystem.
 *
 * `CONTRACT.md` is the marker because that is what the repository already uses to mean "this
 * component has a public contract that other units may rely on". Deriving it means these tests
 * cannot go stale in the direction that matters: adding a component without mentioning it in the
 * README fails here.
 */
const implementedComponents = KERNEL_COMPONENTS.filter((component) =>
  existsSync(path.join(KERNEL_DIR, component.dir, 'CONTRACT.md')),
);

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;

test('the fixture for these tests is the real kernel, and it holds K-05 and K-08', () => {
  const ids = implementedComponents.map((component) => component.id).sort();
  assert.ok(
    ids.includes('K-05'),
    'K-05 Configuration has a CONTRACT.md; if this fails the marker convention changed',
  );
  assert.ok(ids.includes('K-08'), 'K-08 Event Infrastructure has a CONTRACT.md');
  assert.ok(
    implementedComponents.length >= 2,
    `expected at least two implemented components, found ${implementedComponents.length}`,
  );
});

test('kernel/README.md names every implemented component', () => {
  for (const component of implementedComponents) {
    assert.ok(
      KERNEL_README.includes(component.id),
      `kernel/README.md does not mention ${component.id} ${component.name}, which is implemented`,
    );
    assert.ok(
      KERNEL_README.includes(`${component.dir}/`),
      `kernel/README.md does not point at kernel/${component.dir}/`,
    );
    assert.ok(
      KERNEL_README.includes(`${component.dir}/CONTRACT.md`),
      `kernel/README.md does not link ${component.dir}/CONTRACT.md, so a reader cannot reach the contract`,
    );
  }
});

test('kernel/README.md does not claim fewer components than exist', () => {
  const claimed = implementedComponents.length;

  // Every count *below* the real one, in the forms this README has actually used. "One component
  // is implemented" was the exact sentence that went stale when K-08 landed.
  for (let lower = 0; lower < claimed; lower += 1) {
    const word = NUMBER_WORDS[lower] as string;
    const patterns = [
      new RegExp(`\\b${word}\\s+component\\s+(is|has)\\b`, 'i'),
      new RegExp(`\\b${word}\\s+components?\\s+(is|are)\\s+implemented\\b`, 'i'),
      new RegExp(`\\bonly\\s+${word}\\b[^.]{0,40}\\bcomponent`, 'i'),
      new RegExp(`\\b${lower}\\s+of\\s+15\\s+components?\\s+(is|are)\\s+implemented\\b`, 'i'),
    ];
    for (const pattern of patterns) {
      assert.ok(
        !pattern.test(KERNEL_README),
        `kernel/README.md claims ${word} implemented component(s) via ${String(pattern)}, but ` +
          `${claimed} are implemented`,
      );
    }
  }

  // And the remaining-unbuilt count must agree with the same arithmetic.
  const remaining = KERNEL_COMPONENTS.length - claimed;
  assert.ok(
    new RegExp(
      `\\b(${remaining}|${NUMBER_WORDS[remaining] ?? 'never'})\\b[^.]{0,40}unbuilt`,
      'i',
    ).test(KERNEL_README),
    `kernel/README.md should say ${remaining} components are unbuilt (15 minus the ${claimed} implemented)`,
  );
});

test('neither file claims K-08 Event Infrastructure is absent', () => {
  const files: ReadonlyArray<{ readonly name: string; readonly text: string }> = [
    { name: 'kernel/README.md', text: KERNEL_README },
    { name: 'kernel/configuration/index.ts', text: leadingComment(CONFIG_INDEX) },
  ];

  // Each pattern is a way the two files have actually put it, or an obvious neighbour. The
  // original wording was "K-02 Authentication, K-04 Permissions, K-09 Audit and K-08 Events, none
  // of which exists" — the list form is why "K-08" and the denial are matched across a span rather
  // than adjacently.
  const denials: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
    {
      pattern: /K-08[\s\S]{0,120}?\bnone of which exists?\b/i,
      why: 'lists K-08 among components that do not exist',
    },
    {
      pattern:
        /K-08[^.]{0,80}?\b(does not exist|doesn't exist|is absent|is not built|is unbuilt)\b/i,
      why: 'states K-08 does not exist',
    },
    {
      pattern: /\b(no|without)\s+(event infrastructure|event log)\b/i,
      why: 'states there is no event infrastructure',
    },
    {
      pattern: /\bK-08\b[^.]{0,60}\b(not yet|still)\s+(exists?|delivered|implemented)\b/i,
      why: 'states K-08 is not yet delivered',
    },
    {
      pattern: /\bevents?\b[^.]{0,40}\bwait(s|ing)? on\b[^.]{0,40}\bK-08\b/i,
      why: 'says something waits on K-08 arriving, which it already has',
    },
  ];

  for (const file of files) {
    for (const denial of denials) {
      assert.ok(
        !denial.pattern.test(file.text),
        `${file.name} ${denial.why} — K-08 Event Infrastructure has an implemented foundation ` +
          'in kernel/event-infrastructure',
      );
    }
  }
});

test("K-05's public commentary records that it publishes no events, and why", () => {
  const comment = leadingComment(CONFIG_INDEX);

  assert.match(
    comment,
    /publishes no events/i,
    'the header must still say K-05 emits nothing — that has not changed and a reader must not ' +
      'assume otherwise merely because K-08 now exists',
  );
  assert.match(
    comment,
    /deferred integration/i,
    'and must name it as a deferred integration rather than a missing dependency',
  );
  assert.match(comment, /K-08/, 'naming the component the integration would go through');
});

test('the README distinguishes implemented foundations from deferred integrations', () => {
  assert.match(
    KERNEL_README,
    /no module publishes or consumes an event/i,
    'K-08 has no producer and no consumer, and the README must not let that be inferred away',
  );
  assert.match(
    KERNEL_README,
    /(never been applied|no runtime is available|unproven)/i,
    'neither schema has run against PostgreSQL, which is the largest thing still unverified',
  );
  assert.match(
    KERNEL_README,
    /K-02|K-04|K-09/,
    'the deferred API, authority and audit integrations must name what they wait on',
  );
});

test('neither file claims a kernel component is complete', () => {
  // The components are foundations. "Complete" here would contradict CURRENT_IMPLEMENTATION_STATUS,
  // where K-05 and K-08 are both IN PROGRESS and P0-35 is not closed.
  for (const [name, text] of [
    ['kernel/README.md', KERNEL_README],
    ['kernel/configuration/index.ts', leadingComment(CONFIG_INDEX)],
  ] as const) {
    for (const pattern of [
      /\bK-0[58]\b[^.]{0,40}\bis complete\b/i,
      /\bfully implemented\b/i,
      /\bproduction[- ]ready\b/i,
    ]) {
      assert.ok(!pattern.test(text), `${name} over-claims completeness via ${String(pattern)}`);
    }
  }
});

test("K-01's public commentary does not claim K-03 is unbuilt", () => {
  // The exact obsolete sentence, which survived FND-004b: "K-03 will be its first consumer".
  // K-03 was delivered in that task and *is* its first consumer, so the header was describing a
  // future that had already happened — the same kind of drift the K-08 denials in this file were
  // written to catch, in the same kind of place (the first thing a consumer reads).
  const comment = leadingComment(IDENTITY_INDEX);

  const obsolete: ReadonlyArray<{ readonly pattern: RegExp; readonly why: string }> = [
    {
      pattern: /K-03[^.]{0,60}\bwill be\b/i,
      why: 'says K-03 will be its consumer, which it already is',
    },
    {
      pattern:
        /\bK-03\b[^.]{0,60}\b(does not exist|doesn't exist|is absent|is not built|is unbuilt)\b/i,
      why: 'states K-03 does not exist',
    },
    {
      pattern: /K-03[\s\S]{0,120}?\bnone of which exists?\b/i,
      why: 'lists K-03 among components that do not exist',
    },
    {
      pattern: /\bno (unit|component|consumer)[^.]{0,60}\bconsumes?\b[^.]{0,40}\bK-01\b/i,
      why: 'says nothing consumes K-01',
    },
  ];

  for (const { pattern, why } of obsolete) {
    assert.ok(
      !pattern.test(comment),
      `kernel/identity/index.ts ${why} — K-03 Accounts is implemented in kernel/accounts and ` +
        'consumes K-01 through its SubjectLookup port',
    );
  }
});

test("K-01's public commentary records K-03 as its implemented consumer, and what is still deferred", () => {
  const comment = leadingComment(IDENTITY_INDEX);

  assert.match(comment, /\bK-03\b/, 'the consumer must be named');
  assert.match(
    comment,
    /K-03[^.]{0,80}\b(is implemented|is delivered|is built)\b|\bimplemented\b[^.]{0,40}\bK-03\b/i,
    'and recorded as implemented rather than as a plan',
  );

  // Accurate in the other direction too. Two things really are still missing, and a header that
  // dropped them while updating the first half would over-claim instead of under-claiming.
  assert.match(
    comment,
    /\b(deferred|undelivered|not delivered)\b/i,
    'the remaining integration must still be named as deferred',
  );
  assert.match(
    comment,
    /transactional registration|one transaction/i,
    'specifically the transactional registration path, which is what is actually missing',
  );
  assert.match(
    comment,
    /no caller creates|nothing[^.]{0,40}\bwrites?\b[^.]{0,20}subject/i,
    'and that nothing writes a subject, which is separate from K-03 reading one',
  );
});

test('K-01 and K-03 both record that nothing uses their enlisted paths', () => {
  // The enlisted paths are the capability transactional registration would be built from. Both
  // components claim to have one and neither claims it is used; if either started claiming
  // otherwise without a caller existing, this is where it would show.
  const accountIndex = readFileSync(path.join(KERNEL_DIR, 'accounts', 'index.ts'), 'utf8');

  assert.match(leadingComment(IDENTITY_INDEX), /nothing uses it|undelivered|deferred/i);
  assert.match(leadingComment(accountIndex), /No unit opens an account/i);
});
