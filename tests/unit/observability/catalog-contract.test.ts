/**
 * AC6 — the event catalog is complete and stays in parity with the
 * `TelemetryEvent` union (issue #2029).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractTelemetryEventUnionMembers } from '../../../scripts/check-event-contract.js';
import {
	CATALOG_KINDS,
	EVENT_CATALOG,
} from '../../../src/observability/catalog.js';

// Lower bound only — mirrors `scripts/check-event-contract.ts`, which dropped its
// upper bound so a kind whose real owner issue is numbered above the #2030-#2051
// programme cannot be forced into citing a false in-window issue.
const MIN_RETENTION_ISSUE = 2030;

const VALID_PRIVACY_CLASSES = new Set([
	'operational',
	'pseudonymous',
	'sensitive',
	'content',
]);
const VALID_CATEGORIES = new Set([
	'lifecycle',
	'delegation',
	'gate',
	'plan',
	'evidence',
	'guardrail',
	'knowledge',
	'cost',
	'prm',
	'conflict',
	'unrecognized',
]);
const VALID_SEVERITIES = new Set([
	'debug',
	'info',
	'notice',
	'warning',
	'error',
	'critical',
]);

const PRODUCER_PATTERN = /^src\/.+\.ts:\d+$/;

const CONTRACT_DOC_REL = 'docs/observability-event-contract.md';
const CONTRACT_DOC_PATH = path.join(
	__dirname,
	'..',
	'..',
	'..',
	'docs',
	'observability-event-contract.md',
);

/**
 * The per-kind declaration line every `#### <kind>` section opens with, e.g.
 * ``Category `guardrail`, severity `warning`, privacy **`sensitive`**.``
 *
 * Anchored on the full `Category …, severity …, privacy …` form rather than a
 * bare `` privacy `x` `` so it cannot be satisfied by explanatory prose further
 * down a section — `loop_detected`'s body, for instance, goes on to discuss
 * `sensitive` and `pseudonymous` at length. `\s+` spans newlines, so a
 * hard-wrapped declaration still matches. Bold markers are optional because the
 * doc emphasises the non-obvious classes.
 */
const PRIVACY_DECLARATION_RE =
	/Category\s+\*{0,2}`[a-z_]+`\*{0,2},\s+severity\s+\*{0,2}`[a-z]+`\*{0,2},\s+privacy\s+\*{0,2}`([a-z]+)`/;

/**
 * Split the contract doc into `#### <kind>` section bodies, keyed by heading
 * text. A section runs until the next heading of ANY level.
 */
function readKindSections(): Map<string, string> {
	const doc = fs.readFileSync(CONTRACT_DOC_PATH, 'utf-8');
	const sections = new Map<string, string[]>();
	let current: string | null = null;
	for (const line of doc.split('\n')) {
		const heading = line.match(/^(#{1,6})\s+(.+)$/);
		if (heading) {
			current = heading[1].length === 4 ? heading[2].trim() : null;
			if (current) sections.set(current, []);
			continue;
		}
		if (current) sections.get(current)?.push(line);
	}
	return new Map(
		[...sections].map(([name, body]) => [name, body.join('\n')] as const),
	);
}

const KIND_SECTIONS = readKindSections();

/**
 * Parse the `TelemetryEvent` union members straight out of
 * `src/telemetry.ts` (lines ~11-56) — a type union has no runtime
 * representation, so this is the only way to derive it without hand-copying
 * the list (which would drift silently).
 */
/**
 * Read the `TelemetryEvent` union members from source.
 *
 * Delegates to the CI gate's own parser rather than keeping a second copy.
 * Two parsers can disagree, and they did: an earlier local copy stripped `//`
 * line comments but not `/* *\/` block comments, so a JSDoc block whose prose
 * contained a semicolon (added to main by #2063: "...once per non-progress
 * streak; the denial itself repeats...") truncated the union at that point and
 * silently under-reported members. The gate's parser is line-anchored on
 * `| 'name'` and is immune to semicolons anywhere in prose.
 */
function readTelemetryEventUnionMembers(): Set<string> {
	const telemetryTsPath = path.join(
		__dirname,
		'..',
		'..',
		'..',
		'src',
		'telemetry.ts',
	);
	const content = fs.readFileSync(telemetryTsPath, 'utf-8');
	const members = extractTelemetryEventUnionMembers(content);
	// Sanity: guard against a silently broken parser reporting an empty set.
	expect(members.length).toBeGreaterThan(20);
	return new Set(members);
}

describe('catalog contract — AC6', () => {
	test('entry count equals the TelemetryEvent union size', () => {
		// DERIVED from the union, never hard-coded. A literal here is fixture drift:
		// it goes stale the moment anyone adds an event kind (main added six via
		// #2063/#2065 while this branch was open), and a stale literal fails for a
		// reason that has nothing to do with the property under test.
		const unionSize = readTelemetryEventUnionMembers().size;
		expect(CATALOG_KINDS.length).toBe(unionSize);
		expect(Object.keys(EVENT_CATALOG).length).toBe(unionSize);
	});

	test('prose entry counts in catalog.ts and the contract doc match the real catalog size', () => {
		// Issue #2035 reviewer finding: adding an entry silently strands the
		// prose counts ("Exactly 43 entries") in the catalog header and the
		// contract doc while every structural assertion stays green. Pin the
		// prose to the structure.
		const repoRoot = path.resolve(import.meta.dir, '../../..');
		const catalogSrc = fs.readFileSync(
			path.join(repoRoot, 'src/observability/catalog.ts'),
			'utf-8',
		);
		const catalogProse = /Exactly (\d+) entries/.exec(catalogSrc);
		expect(catalogProse).not.toBeNull();
		expect(Number(catalogProse?.[1])).toBe(CATALOG_KINDS.length);
		const allEntriesProse = /for all (\d+) entries today/.exec(catalogSrc);
		expect(allEntriesProse).not.toBeNull();
		expect(Number(allEntriesProse?.[1])).toBe(CATALOG_KINDS.length);
		const doc = fs.readFileSync(
			path.join(repoRoot, 'docs/observability-event-contract.md'),
			'utf-8',
		);
		const docHeading = /## 5\. The (\d+)-entry catalog/.exec(doc);
		expect(docHeading).not.toBeNull();
		expect(Number(docHeading?.[1])).toBe(CATALOG_KINDS.length);
		const docBody = /Exactly (\d+) entries =/.exec(doc);
		expect(docBody).not.toBeNull();
		expect(Number(docBody?.[1])).toBe(CATALOG_KINDS.length);
	});

	test('CATALOG_KINDS has no duplicates', () => {
		const unique = new Set(CATALOG_KINDS);
		expect(unique.size).toBe(CATALOG_KINDS.length);
	});

	test('catalog kinds and the TelemetryEvent union are set-equal', () => {
		const unionMembers = readTelemetryEventUnionMembers();
		// Sanity: the union parse actually found a plausible number of members —
		// guards against a silently broken regex reporting an empty/near-empty set.
		expect(unionMembers.size).toBeGreaterThan(20);

		const catalogSet = new Set(CATALOG_KINDS);

		// Every union member is catalogued.
		for (const member of unionMembers) {
			expect(catalogSet.has(member)).toBe(true);
		}
		// Every catalog kind is in the union.
		for (const kind of CATALOG_KINDS) {
			expect(unionMembers.has(kind)).toBe(true);
		}
		// Full set equality, stated directly.
		expect(catalogSet.size).toBe(unionMembers.size);
	});

	/**
	 * FB-003: the privacy RECLASSIFICATION itself, not merely "some valid class".
	 *
	 * `loop_detected` was `pseudonymous` and this PR moved it to `sensitive`.
	 * Nothing asserted the new value: the only privacy assertion was membership in
	 * VALID_PRIVACY_CLASSES, which `pseudonymous` also satisfies — so reverting the
	 * reclassification left 712/712 tests passing and `check:events` green. That is
	 * a silent privacy downgrade, the exact failure this catalog exists to prevent.
	 *
	 * The class is `sensitive` because `loopType` carries FILESYSTEM PATHS today:
	 * `src/hooks/guardrails/messages-transform.ts:554` passes `pending.message`,
	 * built at `src/hooks/guardrails/tool-before.ts:1513` as
	 * `Modified N file(s): <paths>` — free text embedding a path. A per-kind class
	 * takes the WORST CASE across producers, so the second, closed-vocabulary
	 * producer (`src/hooks/guardrails/nontransient-circuit.ts:282`) cannot
	 * downgrade it. Do not relax this to `pseudonymous` without first proving no
	 * producer can put a path in `loopType`.
	 */
	test('loop_detected is classified sensitive (path-bearing loopType)', () => {
		expect(EVENT_CATALOG.loop_detected?.privacyClass).toBe('sensitive');
	});

	/**
	 * FB-003, generalised: close the whole doc<->catalog privacy divergence class,
	 * not just the one instance above.
	 *
	 * `docs/observability-event-contract.md` states a privacy class per kind in
	 * prose and `src/observability/catalog.ts` states one in code. Two independent
	 * statements of the same fact drift silently; a reviewer reading only the doc
	 * would then believe a guarantee the runtime does not enforce. This asserts
	 * they are equal for EVERY catalogued kind.
	 *
	 * Failure modes are enumerated rather than skipped on purpose: a missing
	 * section or an unparseable declaration is reported as a problem, so a doc
	 * restructure turns this test red instead of quietly making it vacuous.
	 */
	test('every catalog privacyClass equals the class documented per kind', () => {
		const problems: string[] = [];
		for (const kind of CATALOG_KINDS) {
			const body = KIND_SECTIONS.get(kind);
			if (body === undefined) {
				problems.push(
					`${kind}: no "#### ${kind}" section in ${CONTRACT_DOC_REL}`,
				);
				continue;
			}
			const match = body.match(PRIVACY_DECLARATION_RE);
			if (match === null) {
				problems.push(
					`${kind}: section has no "Category \`x\`, severity \`y\`, privacy \`z\`" declaration`,
				);
				continue;
			}
			const documented = match[1];
			if (!VALID_PRIVACY_CLASSES.has(documented)) {
				problems.push(
					`${kind}: documented privacy "${documented}" is not a valid privacy class`,
				);
				continue;
			}
			const catalogued = EVENT_CATALOG[kind]?.privacyClass;
			if (documented !== catalogued) {
				problems.push(
					`${kind}: ${CONTRACT_DOC_REL} says "${documented}" but src/observability/catalog.ts says "${catalogued}"`,
				);
			}
		}
		expect(problems).toEqual([]);
	});

	test('the #### section parser found a plausible number of kinds', () => {
		// Anti-vacuity for the test above: if the parser returned an empty map its
		// loop would report every kind as missing, but if CATALOG_KINDS were ever
		// empty the loop would pass over nothing at all.
		expect(CATALOG_KINDS.length).toBeGreaterThan(20);
		expect(KIND_SECTIONS.size).toBeGreaterThanOrEqual(CATALOG_KINDS.length);
	});

	describe.each(Object.entries(EVENT_CATALOG))('entry: %s', (kind, entry) => {
		test(`${kind} has a non-empty producer matching src/*.ts:line`, () => {
			expect(entry.producer.length).toBeGreaterThan(0);
			expect(PRODUCER_PATTERN.test(entry.producer)).toBe(true);
		});

		test(`${kind} has a retentionOwnerIssue >= 2030`, () => {
			expect(Number.isInteger(entry.retentionOwnerIssue)).toBe(true);
			expect(entry.retentionOwnerIssue).toBeGreaterThanOrEqual(
				MIN_RETENTION_ISSUE,
			);
		});

		test(`${kind} has a valid privacyClass`, () => {
			expect(VALID_PRIVACY_CLASSES.has(entry.privacyClass)).toBe(true);
		});

		test(`${kind} has a valid category`, () => {
			expect(VALID_CATEGORIES.has(entry.category)).toBe(true);
		});

		test(`${kind} has a valid severity`, () => {
			expect(VALID_SEVERITIES.has(entry.severity)).toBe(true);
		});

		test(`${kind} has a non-empty docAnchor`, () => {
			expect(typeof entry.docAnchor).toBe('string');
			expect(entry.docAnchor.length).toBeGreaterThan(0);
		});

		test(`${kind} has a non-empty testFile`, () => {
			expect(typeof entry.testFile).toBe('string');
			expect(entry.testFile.length).toBeGreaterThan(0);
		});

		test(`${kind}: empty consumers requires a futureOwnerIssue >= 2030`, () => {
			if (entry.consumers.length === 0) {
				expect(entry.futureOwnerIssue).toBeDefined();
				expect(Number.isInteger(entry.futureOwnerIssue as number)).toBe(true);
				expect(entry.futureOwnerIssue as number).toBeGreaterThanOrEqual(
					MIN_RETENTION_ISSUE,
				);
			}
		});
	});
});
