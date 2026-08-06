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

const MIN_RETENTION_ISSUE = 2030;
const MAX_RETENTION_ISSUE = 2051;

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

	describe.each(Object.entries(EVENT_CATALOG))('entry: %s', (kind, entry) => {
		test(`${kind} has a non-empty producer matching src/*.ts:line`, () => {
			expect(entry.producer.length).toBeGreaterThan(0);
			expect(PRODUCER_PATTERN.test(entry.producer)).toBe(true);
		});

		test(`${kind} has a retentionOwnerIssue in [2030, 2051]`, () => {
			expect(entry.retentionOwnerIssue).toBeGreaterThanOrEqual(
				MIN_RETENTION_ISSUE,
			);
			expect(entry.retentionOwnerIssue).toBeLessThanOrEqual(
				MAX_RETENTION_ISSUE,
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

		test(`${kind}: empty consumers requires a futureOwnerIssue in [2030, 2051]`, () => {
			if (entry.consumers.length === 0) {
				expect(entry.futureOwnerIssue).toBeDefined();
				expect(entry.futureOwnerIssue as number).toBeGreaterThanOrEqual(
					MIN_RETENTION_ISSUE,
				);
				expect(entry.futureOwnerIssue as number).toBeLessThanOrEqual(
					MAX_RETENTION_ISSUE,
				);
			}
		});
	});
});
