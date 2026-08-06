/**
 * Coverage for `scripts/check-event-contract.ts` (issue #2029 AC6 — event
 * contract completeness gate) and its drift-check wiring
 * (`scripts/drift-check.ts` -> `detectEventContractDrift`).
 *
 * A final critic found this gate shipped with NO test at all, in violation
 * of CLAUDE.md permanent directive 2 ("untested branches count as unwired
 * code and are blockers"). This file closes that gap by exercising the pure
 * exported helpers directly (mirroring
 * `tests/unit/scripts/check-tool-registration-reverse.test.ts`) plus a
 * real-repo integration smoke assertion (mirroring
 * `tests/unit/scripts/drift-check-detectors.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	checkCitationMentions,
	collectCitationResolutionErrors,
	collectEventContractErrors,
	extractHeadingSlugs,
	extractTelemetryEventUnionMembers,
	slugifyHeading,
} from '../../../scripts/check-event-contract.ts';
import { detectEventContractDrift } from '../../../scripts/drift-check.ts';
import { CATALOG_KINDS } from '../../../src/observability/catalog.ts';

const REPO_ROOT = path.resolve(__dirname, '../../../');
const TELEMETRY_FILE = path.join(REPO_ROOT, 'src', 'telemetry.ts');
const DRIFT_CHECK_FILE = path.join(REPO_ROOT, 'scripts', 'drift-check.ts');

describe('extractTelemetryEventUnionMembers', () => {
	test('extracts all members of a simple union', () => {
		const source = [
			'export type TelemetryEvent =',
			"\t| 'kind_a'",
			"\t| 'kind_b'",
			"\t| 'kind_c';",
		].join('\n');
		expect(extractTelemetryEventUnionMembers(source)).toEqual([
			'kind_a',
			'kind_b',
			'kind_c',
		]);
	});

	test('stops at the union-terminating ";" and ignores anything after it', () => {
		// The trailing block below is deliberately a SECOND real `| 'x'`-shaped
		// union (mirroring src/telemetry.ts's actual
		// `ReviewerGateEvidenceKind`, which follows TelemetryEvent), not an
		// inline `Unrelated = 'kind_z'` type. An inline type never matches the
		// line-anchored `| 'x'` member pattern at all, so a test built on it
		// would pass even with the `terminated`/`break` logic deleted
		// entirely and prove nothing about termination. This shape actually
		// exercises the break: without it, the scan would keep matching into
		// the next union and 'kind_z' would leak into the result.
		const source = [
			'export type TelemetryEvent =',
			"\t| 'kind_a';",
			'',
			'export type ReviewerGateEvidenceKind =',
			"\t| 'kind_z';",
		].join('\n');
		const members = extractTelemetryEventUnionMembers(source);
		expect(members).toEqual(['kind_a']);
		expect(members).not.toContain('kind_z');
	});

	test('regression: a "//" comment line that itself contains a literal ";" does NOT truncate the scan', () => {
		// This is the exact defect class described in the docstring above
		// extractTelemetryEventUnionMembers: a naive `indexOf(';', ...)` scan
		// would stop at the semicolon inside the comment prose below and never
		// see 'kind_after_comment'. The real src/telemetry.ts carries exactly
		// this shape (see the "agent_conflict_detected" member's preceding
		// comment, which reads "...this issue targets; the cast is now
		// gone."), so this is not a hypothetical.
		const source = [
			'export type TelemetryEvent =',
			"\t| 'kind_before'",
			'\t// That is the exact defect class this issue targets; the cast is now gone.',
			"\t| 'kind_after_comment';",
		].join('\n');
		const members = extractTelemetryEventUnionMembers(source);
		expect(members).toEqual(['kind_before', 'kind_after_comment']);
	});

	test('throws a clear error when the start marker is absent', () => {
		expect(() =>
			extractTelemetryEventUnionMembers('export type SomethingElse = string;'),
		).toThrow(/Could not find "export type TelemetryEvent ="/);
	});

	test('throws a clear error when the union never reaches a closing ";"', () => {
		const source = [
			'export type TelemetryEvent =',
			"\t| 'kind_a'",
			"\t| 'kind_b'",
			'// no terminator below, union body runs off the end of the file',
		].join('\n');
		expect(() => extractTelemetryEventUnionMembers(source)).toThrow(
			/Could not find the closing ";"/,
		);
	});

	test('real src/telemetry.ts parses cleanly and its comment-with-";" line is present (fixture-reality check)', () => {
		const telemetrySource = fs.readFileSync(TELEMETRY_FILE, 'utf-8');
		// Sanity-check that the regression fixture above still mirrors reality:
		// if this substring ever disappears from telemetry.ts, the regression
		// test above stops being a regression test for a real defect and this
		// assertion is the tripwire that says so.
		expect(telemetrySource).toContain(
			'this issue targets; the cast is now gone.',
		);
		const members = extractTelemetryEventUnionMembers(telemetrySource);
		// The gate's own catalog<->union parity check (collectEventContractErrors
		// section 1) requires these two sets to be the SAME SIZE on a clean
		// repo, so this is the extractor's real termination contract, not an
		// arbitrary lower bound: if extraction ran past the union's closing
		// ";" into ReviewerGateEvidenceKind below it, this count would exceed
		// CATALOG_KINDS.length and this assertion would catch it.
		expect(members.length).toBe(CATALOG_KINDS.length);
		expect(members).toContain('agent_conflict_detected');
		expect(members).toContain('delegation_end');
		// 'genuine' is a member of the ADJACENT ReviewerGateEvidenceKind union
		// that immediately follows TelemetryEvent in the real file. Its
		// presence here would mean the scan ran past the terminating ";".
		expect(members).not.toContain('genuine');
	});

	test('mutation-style: a union member absent from CATALOG_KINDS is detectable via set difference', () => {
		// Exercises the exact set-difference logic collectEventContractErrors
		// runs internally (src/telemetry.ts union vs. CATALOG_KINDS), without
		// mutating the real repo: a synthetic union member that is provably
		// NOT in the real catalog proves the building block that would catch
		// an uncatalogued event kind actually works.
		const source = [
			'export type TelemetryEvent =',
			"\t| 'delegation_end'",
			"\t| 'not_a_real_catalog_kind_2029';",
		].join('\n');
		const members = extractTelemetryEventUnionMembers(source);
		const catalogSet = new Set(CATALOG_KINDS);
		const uncatalogued = members.filter((k) => !catalogSet.has(k));
		expect(uncatalogued).toEqual(['not_a_real_catalog_kind_2029']);
		// Negative control: a real catalogued kind must NOT show up as missing.
		expect(catalogSet.has('delegation_end')).toBe(true);
	});
});

describe('slugifyHeading', () => {
	test('lowercases and turns spaces into hyphens', () => {
		expect(slugifyHeading('Event Contract Overview')).toBe(
			'event-contract-overview',
		);
	});

	test('strips backticks and other punctuation not in the allowed set', () => {
		expect(slugifyHeading('`delegation_end` Docs')).toBe('delegation_end-docs');
	});

	test('strips punctuation: colons, parens, commas', () => {
		expect(slugifyHeading('Retention: Owner (assigned), notes')).toBe(
			'retention-owner-assigned-notes',
		);
	});

	test('collapses runs of whitespace into a single hyphen', () => {
		expect(slugifyHeading('Multiple   Spaces   Here')).toBe(
			'multiple-spaces-here',
		);
	});

	test('preserves existing hyphens and underscores', () => {
		expect(slugifyHeading('already-hyphenated_and_underscored')).toBe(
			'already-hyphenated_and_underscored',
		);
	});

	test('trims leading/trailing whitespace before slugifying', () => {
		expect(slugifyHeading('  padded heading  ')).toBe('padded-heading');
	});

	test('regression: an event kind like "delegation_end" maps to itself', () => {
		// This is load-bearing: docAnchor entries in EVENT_CATALOG are commonly
		// the bare event-kind string (e.g. "delegation_end"), and check 5 in
		// collectEventContractErrors compares that string's slug against
		// extracted markdown heading slugs. If slugifyHeading ever mangled a
		// bare snake_case identifier, the docAnchor check would silently stop
		// matching real headings and every entry using this pattern would
		// falsely fail (or, worse, a coincidental mangling could falsely pass).
		expect(slugifyHeading('delegation_end')).toBe('delegation_end');
		expect(slugifyHeading('agent_conflict_detected')).toBe(
			'agent_conflict_detected',
		);
	});
});

describe('extractHeadingSlugs', () => {
	test('finds headings at every level 1-6 and ignores non-heading lines', () => {
		const markdown = [
			'# Top Level',
			'some prose, not a heading',
			'## Second Level',
			'not # a heading either (no leading #)',
			'### Third Level',
			'#### Fourth Level',
			'##### Fifth Level',
			'###### Sixth Level',
			'####### Seven hashes is NOT a valid heading level',
		].join('\n');
		const slugs = extractHeadingSlugs(markdown);
		expect(slugs.has('top-level')).toBe(true);
		expect(slugs.has('second-level')).toBe(true);
		expect(slugs.has('third-level')).toBe(true);
		expect(slugs.has('fourth-level')).toBe(true);
		expect(slugs.has('fifth-level')).toBe(true);
		expect(slugs.has('sixth-level')).toBe(true);
		// "not # a heading" only matches if "#" is at true line-start; it is
		// not, so it must not be picked up as a heading.
		expect(slugs.has('a-heading-either-no-leading')).toBe(false);
		// Seven leading "#" characters is NOT a valid markdown heading level
		// (GFM caps at 6). This is the only case in this fixture that would
		// catch the heading regex's `#{1,6}` being loosened to `#+`.
		expect(slugs.has('seven-hashes-is-not-a-valid-heading-level')).toBe(false);
	});

	test('a heading containing an inline event kind slugifies to a matchable anchor', () => {
		const markdown = '## `delegation_end`\n\nSome docs about this event.\n';
		const slugs = extractHeadingSlugs(markdown);
		expect(slugs.has('delegation_end')).toBe(true);
	});

	test('returns an empty set for markdown with no headings', () => {
		const markdown = 'Just some prose.\nNo headings anywhere.\n';
		expect(extractHeadingSlugs(markdown).size).toBe(0);
	});

	test('deduplicates identical heading text into a single slug (Set semantics)', () => {
		const markdown = '# Duplicate\n\ntext\n\n# Duplicate\n';
		const slugs = extractHeadingSlugs(markdown);
		expect([...slugs]).toEqual(['duplicate']);
	});
});

describe('collectEventContractErrors — real-repo integration', () => {
	test('returns zero errors on the current repo (the contract currently holds)', () => {
		const errors = collectEventContractErrors();
		expect(errors).toEqual([]);
	});
});

describe('detectEventContractDrift — drift-check wiring (issue #2029 AC6)', () => {
	test('is registered in the drift-check DETECTORS array', () => {
		// scripts/drift-check.ts does not export its DETECTORS array (it is
		// module-private), so registration is verified the same way
		// check-tool-registration.ts's own reverse-registration guard works:
		// a text-anchored scan for the exact tuple entry. This is a genuine
		// mutation gate — deleting the
		// `['event-contract', detectEventContractDrift]` line from DETECTORS
		// (the exact regression this test guards against: a detector that
		// exists and is exported but was never wired into the orchestration
		// array) makes this assertion fail.
		const driftCheckSource = fs.readFileSync(DRIFT_CHECK_FILE, 'utf-8');
		// Anchor strictly to the `const DETECTORS = [ ... ];` array literal
		// itself, not the whole file — a stray comment elsewhere mentioning
		// the tuple text must not be able to satisfy this assertion.
		const arrayStart = driftCheckSource.indexOf('const DETECTORS');
		expect(arrayStart).toBeGreaterThan(-1);
		const arrayEnd = driftCheckSource.indexOf('];', arrayStart);
		expect(arrayEnd).toBeGreaterThan(arrayStart);
		const arrayLiteral = driftCheckSource.slice(arrayStart, arrayEnd);
		expect(arrayLiteral).toMatch(
			/\[\s*'event-contract'\s*,\s*detectEventContractDrift\s*\]/,
		);
	});

	test('returns no findings against the real repo', () => {
		const findings = detectEventContractDrift();
		expect(findings).toEqual([]);
	});

	test('detectEventContractDrift body maps each error to category "event-contract" / severity "error" / file "src/observability/catalog.ts"', () => {
		// The real repo currently has ZERO event-contract errors, so calling
		// detectEventContractDrift() end-to-end cannot exercise the non-empty
		// mapping branch (map() over an empty array runs the callback zero
		// times) — asserting `toEqual([])` here would pass identically for a
		// correctly-mapping function and for one that dropped the mapping
		// fields entirely. Constraint 4 (no repo mutation) and the lack of a
		// cwd/root injection point on collectEventContractErrors rule out
		// driving a real violation. Instead, isolate the function's own
		// source text (anchored between its declaration and closing brace, so
		// a stray comment mentioning these fields elsewhere in the file can't
		// satisfy this) and assert the literal mapping fields are present.
		const driftCheckSource = fs.readFileSync(DRIFT_CHECK_FILE, 'utf-8');
		const startIdx = driftCheckSource.indexOf(
			'export function detectEventContractDrift(',
		);
		expect(startIdx).toBeGreaterThan(-1);
		const endIdx = driftCheckSource.indexOf('\n}', startIdx);
		expect(endIdx).toBeGreaterThan(startIdx);
		const body = driftCheckSource.slice(startIdx, endIdx);
		expect(body).toContain('collectEventContractErrors()');
		expect(body).toContain("category: 'event-contract'");
		expect(body).toContain("severity: 'error'");
		expect(body).toContain("file: 'src/observability/catalog.ts'");
	});
});

// ---------------------------------------------------------------------------
// Fixture-driven coverage of the two citation checks (final-critic BLOCKER 5).
//
// These are the checks the whole "the defect class is closed by machinery"
// argument rests on, so they get real behavioural coverage rather than the
// `=== []` smoke assertion. Both accept an injectable `root`, so a temp fixture
// tree drives them without mutating the repo.
// ---------------------------------------------------------------------------
describe('checkCitationMentions (fixture-driven)', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-cite-'));
		fs.mkdirSync(path.join(root, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'src', 'producer.ts'),
			[
				'const a = 1;', // 1
				"emit('my_kind', {", // 2
				'});', // 3
				'const b = 2;', // 4
			].join('\n'),
			'utf-8',
		);
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('accepts a citation landing exactly on the kind', () => {
		expect(
			checkCitationMentions('src/producer.ts:2', 'my_kind', 'L', 'R', root),
		).toEqual([]);
	});

	// The regression that motivated removing the 3-line tolerance window: when
	// lines are inserted ABOVE an emit, a stale citation points EARLY.
	test('rejects a citation that drifted one line EARLY', () => {
		const errs = checkCitationMentions(
			'src/producer.ts:1',
			'my_kind',
			'L',
			'R',
			root,
		);
		expect(errs).toHaveLength(1);
		expect(errs[0]).toContain("does not mention 'my_kind'");
	});

	test('rejects a citation that drifted one line LATE', () => {
		expect(
			checkCitationMentions('src/producer.ts:3', 'my_kind', 'L', 'R', root),
		).toHaveLength(1);
	});

	test('rejects a nonexistent file', () => {
		const errs = checkCitationMentions(
			'src/nope.ts:1',
			'my_kind',
			'L',
			'R',
			root,
		);
		expect(errs[0]).toContain('does not exist');
	});

	test('rejects an out-of-range line', () => {
		const errs = checkCitationMentions(
			'src/producer.ts:999',
			'my_kind',
			'L',
			'R',
			root,
		);
		expect(errs[0]).toContain('out of range');
	});

	test('rejects a malformed citation with no line number', () => {
		expect(
			checkCitationMentions('src/producer.ts', 'my_kind', 'L', 'R', root),
		).toHaveLength(1);
	});
});

describe('collectCitationResolutionErrors (fixture-driven)', () => {
	let root: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-resolve-'));
		fs.mkdirSync(path.join(root, 'src'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'src', 'target.ts'),
			'a\nb\nc\nd\ne\n',
			'utf-8',
		);
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const write = (body: string): void => {
		fs.writeFileSync(path.join(root, 'doc.md'), body, 'utf-8');
	};

	test('accepts sound single-line and range citations', () => {
		write('see `src/target.ts:2` and `src/target.ts:1-5`');
		expect(collectCitationResolutionErrors(root, ['doc.md'])).toEqual([]);
	});

	test('rejects an INVERTED range', () => {
		write('see `src/target.ts:5-2`');
		const errs = collectCitationResolutionErrors(root, ['doc.md']);
		expect(errs).toHaveLength(1);
		expect(errs[0]).toContain('INVERTED range');
	});

	test('rejects a line past EOF', () => {
		write('see `src/target.ts:99`');
		expect(collectCitationResolutionErrors(root, ['doc.md'])[0]).toContain(
			'out of range',
		);
	});

	test('rejects a citation naming a nonexistent file', () => {
		write('see `src/ghost.ts:1`');
		expect(collectCitationResolutionErrors(root, ['doc.md'])[0]).toContain(
			'does not exist',
		);
	});

	test('scans .md files inside a directory glob', () => {
		fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'notes', 'a.md'),
			'`src/target.ts:5-2`',
			'utf-8',
		);
		expect(collectCitationResolutionErrors(root, ['notes'])[0]).toContain(
			'INVERTED range',
		);
	});

	test('skips a line carrying the citation-check:ignore marker', () => {
		// docs/engineering-invariants.md exists to RECORD defects, so an entry that
		// quotes a bad citation as an example is correct prose. Without an opt-out
		// the scanner turns CI red on documentation of its own defect class — which
		// is exactly what happened during issue #2029 (final-critic round 3).
		write(
			'the range `src/target.ts:5-2` was inverted <!-- citation-check:ignore -->',
		);
		expect(collectCitationResolutionErrors(root, ['doc.md'])).toEqual([]);
	});

	test('the ignore marker is line-scoped, not file-scoped', () => {
		write(
			'ok `src/target.ts:5-2` <!-- citation-check:ignore -->\nbad `src/target.ts:5-1`',
		);
		const errs = collectCitationResolutionErrors(root, ['doc.md']);
		expect(errs).toHaveLength(1);
		expect(errs[0]).toContain('5-1');
	});
});
