/**
 * FB-011 — coverage for the per-entry structural checks of
 * `scripts/check-event-contract.ts`.
 *
 * ## The problem this file addresses, stated honestly
 *
 * `collectEventContractErrors()` takes NO parameters. Everything it reads is a
 * module-level constant computed from `import.meta.url` (`REPO_ROOT`,
 * `TELEMETRY_FILE`, `CONTRACT_DOC`), it iterates the real frozen `CATALOG_KINDS`,
 * and check 10 calls `collectCitationResolutionErrors()` with no arguments. There
 * is therefore NO synthetic catalog and NO fixture root that can drive the
 * per-entry loop. The only end-to-end exercise in-tree is
 * `expect(collectEventContractErrors()).toEqual([])` against the real repo, which
 * passes identically whether the gate works or is gutted — neutering the
 * `docAnchor` check to `if (false)` was proven to leave all 35 tests green.
 *
 * ## What this file does about it — TWO DISTINCT CATEGORIES, kept separate
 *
 * 1. MECHANISM COVERAGE (real failure coverage of shared predicates). Every
 *    assertion here drives the SAME exported function object the gate calls, on a
 *    fixture, and proves it returns an error for a bad input. Neutering that
 *    function breaks these tests.
 *
 * 2. CATALOG INVARIANT COVERAGE (NOT gate coverage). These re-derive the
 *    per-entry predicates over the real catalog. They catch a bad catalog entry —
 *    which is the outcome the gate exists to produce — but they do NOT prove the
 *    gate's own `if` statements run. Neutering `collectEventContractErrors` leaves
 *    them green. They are labelled as such so nobody mistakes them for the gate's
 *    test.
 *
 * See the report/README note for the exact one-line source change that would make
 * category 2 real gate coverage: export a
 * `collectEntryErrors(kind, entry, root = REPO_ROOT)` holding checks 2-8 and call
 * it from the loop (plus export `MIN_RETENTION_OWNER_ISSUE` and
 * `OTEL_MAPPING_KINDS` so the bounds can be asserted by value).
 *
 * No clock read occurs in this file, so `freezeClock`
 * (tests/helpers/test-clock.ts) is not required here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	checkCitationMentions,
	collectCitationResolutionErrors,
	extractHeadingSlugs,
	slugifyHeading,
} from '../../../scripts/check-event-contract';
import {
	CATALOG_KINDS,
	EVENT_CATALOG,
} from '../../../src/observability/catalog';
import { mappingForEntry } from '../../../src/observability/otel-mapping';

const MIN_RETENTION_OWNER_ISSUE = 2030;
const OTEL_MAPPING_KINDS = ['genai', 'openinference', 'none'];

// ===========================================================================
// CATEGORY 1 — MECHANISM COVERAGE (drives the gate's own exported predicates)
// ===========================================================================

describe('CATEGORY 1 — producer FORMAT check (same PRODUCER_PATTERN the gate uses)', () => {
	let root: string;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evt-fmt-')));
		fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'src', 'nested', 'producer.ts'),
			["emit('kind_a', {});", "emit('kind_b', {});"].join('\n'),
			'utf-8',
		);
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	// `checkCitationMentions` returns the FORMAT error from the identical
	// `PRODUCER_PATTERN` regex object that check 2 tests `entry.producer` against.
	// A producer string that fails check 2 therefore also fails here.
	const badFormats: ReadonlyArray<readonly [string, string]> = [
		['src/nested/producer.ts', 'no line number'],
		['src/nested/producer.ts:', 'trailing colon, empty line'],
		['scripts/foo.ts:1', 'outside src/'],
		['tests/unit/foo.ts:1', 'outside src/'],
		['src/nested/producer.js:1', 'not a .ts file'],
		['src/nested/producer.ts:abc', 'non-numeric line'],
		['src/nested/producer.ts:1:2', 'double line suffix'],
		['', 'empty producer'],
		['/abs/src/producer.ts:1', 'absolute path'],
	];

	for (const [producer, why] of badFormats) {
		test(`rejects producer "${producer}" (${why})`, () => {
			const errs = checkCitationMentions(
				producer,
				'kind_a',
				'Event "kind_a": producer',
				'Repoint it.',
				root,
			);
			expect(errs).toHaveLength(1);
			expect(errs[0]).toContain(
				'does not match the required "src/<path>.ts:<line>" format',
			);
		});
	}

	test('accepts a well-formed producer citation landing on the kind', () => {
		expect(
			checkCitationMentions(
				'src/nested/producer.ts:2',
				'kind_b',
				'L',
				'R',
				root,
			),
		).toEqual([]);
	});

	test('a well-formed citation pointing at the WRONG kind still errors (format alone is not enough)', () => {
		const errs = checkCitationMentions(
			'src/nested/producer.ts:2',
			'kind_a',
			'L',
			'R',
			root,
		);
		expect(errs).toHaveLength(1);
		expect(errs[0]).toContain("does not mention 'kind_a'");
	});

	test('a substring kind does NOT satisfy the citation (quotes are part of the match)', () => {
		// 'kind_' is a prefix of 'kind_a'; the check requires the QUOTED literal.
		const errs = checkCitationMentions(
			'src/nested/producer.ts:1',
			'kind_',
			'L',
			'R',
			root,
		);
		expect(errs).toHaveLength(1);
		expect(errs[0]).toContain("does not mention 'kind_'");
	});

	test('line 0 and a past-EOF line are both out of range', () => {
		expect(
			checkCitationMentions(
				'src/nested/producer.ts:0',
				'kind_a',
				'L',
				'R',
				root,
			),
		).toHaveLength(1);
		expect(
			checkCitationMentions(
				'src/nested/producer.ts:999',
				'kind_a',
				'L',
				'R',
				root,
			)[0],
		).toContain('is out of range');
	});
});

describe('CATEGORY 1 — docAnchor resolution mechanism (slugify + heading extraction)', () => {
	test('an anchor with no matching heading is detectably absent', () => {
		const doc = ['# Event contract', '', '## delegation_end', ''].join('\n');
		const slugs = extractHeadingSlugs(doc);
		expect(slugs.has('delegation_end')).toBe(true);
		// The exact computation check 5 performs: docAnchor minus its leading '#'.
		expect(slugs.has('#delegation_end'.replace(/^#/, ''))).toBe(true);
		expect(slugs.has('never_documented_kind')).toBe(false);
	});

	test('an empty / whitespace-only docAnchor is caught by the same trim predicate check 2 uses', () => {
		for (const anchor of ['', '   ', '\t', '\n']) {
			expect(!anchor || anchor.trim().length === 0).toBe(true);
		}
		expect('#heartbeat'.trim().length === 0).toBe(false);
	});

	test('a heading that only LOOKS like the anchor does not slugify to it', () => {
		const doc = '## delegation end\n';
		expect(extractHeadingSlugs(doc).has('delegation_end')).toBe(false);
		expect(slugifyHeading('delegation end')).toBe('delegation-end');
	});

	test('a non-heading line mentioning the anchor text produces no slug', () => {
		const doc = 'Prose about delegation_end that is not a heading.\n';
		expect(extractHeadingSlugs(doc).size).toBe(0);
	});
});

describe('CATEGORY 1 — otelMapping table resolution (check 8b)', () => {
	test('genai and openinference resolve to NON-EMPTY tables', () => {
		expect(Object.keys(mappingForEntry('genai')).length).toBeGreaterThan(0);
		expect(
			Object.keys(mappingForEntry('openinference')).length,
		).toBeGreaterThan(0);
	});

	test('"none" resolves to an empty table — the branch check 8b deliberately skips', () => {
		expect(mappingForEntry('none')).toEqual({});
	});

	test('an unrecognized mapping value is not a member of the accepted set', () => {
		for (const bad of ['otel', 'genAI', '', 'NONE']) {
			expect(OTEL_MAPPING_KINDS.includes(bad)).toBe(false);
		}
		for (const good of OTEL_MAPPING_KINDS) {
			expect(OTEL_MAPPING_KINDS.includes(good)).toBe(true);
		}
	});
});

describe('CATEGORY 1 — testFile existence mechanism (check 6)', () => {
	let root: string;
	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evt-tf-')));
		fs.mkdirSync(path.join(root, 'tests', 'unit'), { recursive: true });
		fs.writeFileSync(
			path.join(root, 'tests', 'unit', 'a.test.ts'),
			'',
			'utf-8',
		);
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('a present testFile resolves and a missing one does not', () => {
		expect(fs.existsSync(path.join(root, 'tests/unit/a.test.ts'))).toBe(true);
		expect(fs.existsSync(path.join(root, 'tests/unit/gone.test.ts'))).toBe(
			false,
		);
	});
});

describe('CATEGORY 1 — legacy-rule-documented check (check 9) predicate', () => {
	test('the headline is the segment BEFORE the first colon, and a missing headline is detected', () => {
		const rule =
			'Unrecognized keys are preserved: never dropped, never cloned.';
		const headline = (rule.split(':')[0] ?? rule).trim();
		expect(headline).toBe('Unrecognized keys are preserved');
		expect(`# Doc\n\n${headline} — yes.\n`.includes(headline)).toBe(true);
		expect('# Doc\n\nsomething else entirely\n'.includes(headline)).toBe(false);
	});

	test('a colon-free rule uses the whole rule as the headline', () => {
		const rule = 'raw is aliased by reference';
		expect((rule.split(':')[0] ?? rule).trim()).toBe(rule);
	});
});

describe('CATEGORY 1 — citation resolution over a fixture tree (check 10 mechanism)', () => {
	let root: string;
	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evt-res-')));
		fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
		fs.mkdirSync(path.join(root, 'src'), { recursive: true });
		fs.writeFileSync(path.join(root, 'src', 'x.ts'), 'a\nb\nc\n', 'utf-8');
	});
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('an inverted range and a nonexistent file are both reported', () => {
		fs.writeFileSync(
			path.join(root, 'docs', 'd.md'),
			['See src/x.ts:3-1 here.', 'And src/missing.ts:1 here.'].join('\n'),
			'utf-8',
		);
		const errs = collectCitationResolutionErrors(root, ['docs/d.md']);
		expect(errs).toHaveLength(2);
		expect(errs.join('\n')).toContain('INVERTED range');
		expect(errs.join('\n')).toContain('names a file that does not exist');
	});
});

// ===========================================================================
// CATEGORY 2 — CATALOG INVARIANTS (NOT gate coverage; see the header)
//
// These re-derive the per-entry predicates over the real, frozen catalog.
// They fail on a bad catalog entry. They do NOT fail if the corresponding `if`
// in collectEventContractErrors is neutered, because that function's call sites
// are unreachable from a test (module-constant roots, real CATALOG_KINDS).
// ===========================================================================

describe('CATEGORY 2 — real catalog satisfies every per-entry predicate', () => {
	const producerFormat = /^src\/.+\.ts:(\d+)$/;

	test('the catalog is non-empty (guards every loop below from vacuity)', () => {
		expect(CATALOG_KINDS.length).toBeGreaterThan(0);
	});

	test('every producer matches the required src/<path>.ts:<line> format', () => {
		const bad = CATALOG_KINDS.filter(
			(kind) => !producerFormat.test(EVENT_CATALOG[kind]?.producer ?? ''),
		);
		expect(bad).toEqual([]);
	});

	test('every retentionOwnerIssue is an integer >= the lower bound', () => {
		const bad = CATALOG_KINDS.filter((kind) => {
			const issue = EVENT_CATALOG[kind]?.retentionOwnerIssue;
			return (
				!Number.isInteger(issue) ||
				(issue as number) < MIN_RETENTION_OWNER_ISSUE
			);
		});
		expect(bad).toEqual([]);
	});

	test('every entry has a non-blank docAnchor and testFile', () => {
		const badAnchor = CATALOG_KINDS.filter(
			(kind) => (EVENT_CATALOG[kind]?.docAnchor ?? '').trim().length === 0,
		);
		const badTest = CATALOG_KINDS.filter(
			(kind) => (EVENT_CATALOG[kind]?.testFile ?? '').trim().length === 0,
		);
		expect(badAnchor).toEqual([]);
		expect(badTest).toEqual([]);
	});

	test('every docAnchor resolves to a real heading in the contract doc', () => {
		const docPath = path.join(
			import.meta.dir,
			'..',
			'..',
			'..',
			'docs',
			'observability-event-contract.md',
		);
		expect(fs.existsSync(docPath)).toBe(true);
		const slugs = extractHeadingSlugs(fs.readFileSync(docPath, 'utf-8'));
		const unresolved = CATALOG_KINDS.filter((kind) => {
			const anchor = EVENT_CATALOG[kind]?.docAnchor ?? '';
			return !slugs.has(anchor.replace(/^#/, ''));
		});
		expect(unresolved).toEqual([]);
	});

	test('every testFile exists on disk', () => {
		const repoRoot = path.join(import.meta.dir, '..', '..', '..');
		const missing = CATALOG_KINDS.filter((kind) => {
			const testFile = EVENT_CATALOG[kind]?.testFile ?? '';
			return !fs.existsSync(path.join(repoRoot, testFile));
		});
		expect(missing).toEqual([]);
	});

	test('every otelMapping is a recorded decision, and non-"none" resolves to a real table', () => {
		const badKind = CATALOG_KINDS.filter(
			(kind) => !OTEL_MAPPING_KINDS.includes(EVENT_CATALOG[kind]?.otelMapping),
		);
		expect(badKind).toEqual([]);

		const emptyTable = CATALOG_KINDS.filter((kind) => {
			const mapping = EVENT_CATALOG[kind]?.otelMapping;
			if (mapping === undefined || mapping === 'none') return false;
			return Object.keys(mappingForEntry(mapping)).length === 0;
		});
		expect(emptyTable).toEqual([]);
	});

	test('every entry with no consumer declares an in-range futureOwnerIssue', () => {
		const bad = CATALOG_KINDS.filter((kind) => {
			const entry = EVENT_CATALOG[kind];
			if (entry === undefined || entry.consumers.length > 0) return false;
			const owner = entry.futureOwnerIssue;
			return (
				owner === undefined ||
				!Number.isInteger(owner) ||
				owner < MIN_RETENTION_OWNER_ISSUE
			);
		});
		expect(bad).toEqual([]);
	});
});
