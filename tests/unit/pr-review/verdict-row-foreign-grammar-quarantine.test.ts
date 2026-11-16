/**
 * Issue #3310 AC1 — reviewer verdict-row foreign-grammar quarantine.
 *
 * A reviewer artifact that carries a valid 12-field [REVIEWED] row for every
 * assigned item must settle even when the same artifact also contains a stray
 * illegal-arity [REVIEWED] row with an unassigned id (foreign grammar such as
 * `APPROVED`) plus plain prose lines. The stray row must be quarantined into a
 * diagnostics surface that still names its identifier, never voiding the valid
 * sibling rows.
 *
 * RED at base, GREEN after the fix: at base every marker line counts toward the
 * exact-set check, so the stray unassigned id makes ok=false with an
 * unexpectedIds signature; after the fix illegal-arity rows are quarantined
 * and the valid sibling rows settle.
 */

import {
	analyzePrReviewVerdictRowContract,
	type PrReviewItemClaim,
	parsePrReviewVerdictRows,
} from '../../../src/pr-review/legacy-transcript-adapter.js';

const REVIEWER_ARTIFACT = [
	'[REVIEWED] | c1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |',
	'[REVIEWED] | c2 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | b.ts:2 | rationale long | probe text | notes | UNKNOWN |',
	'[REVIEWED] | task-unknown | APPROVED | looks fine',
	'Some plain prose line that is not a verdict row at all.',
].join('\n');

const REVIEWER_CLAIMS_FOR_C1: ReadonlyMap<string, PrReviewItemClaim> = new Map([
	[
		'C-1',
		{
			batchId: 'batch-1',
			laneId: 'lane-1',
			workflowLane: 'workflow-lane-1',
			classification: 'CONFIRMED',
			severity: 'HIGH',
		},
	],
]);

describe('issue #3310 AC1: reviewer verdict-row foreign-grammar quarantine', () => {
	test('stray illegal-arity row with an unassigned id is quarantined and valid sibling rows settle', () => {
		const analysis = analyzePrReviewVerdictRowContract(
			REVIEWER_ARTIFACT,
			['c1', 'c2'],
			'reviewer',
		);

		expect(analysis.ok).toBe(true);
		const { parsed } = parsePrReviewVerdictRows(
			REVIEWER_ARTIFACT,
			['c1', 'c2'],
			'reviewer',
		);
		expect(parsed.has('c1')).toBe(true);
		expect(parsed.has('c2')).toBe(true);
		// The quarantined row's identifier stays observable somewhere in the
		// result's diagnostics surface: 'task-unknown' is not an assigned id,
		// so after the fix the only legitimate place it can appear is the
		// quarantine record.
		expect(JSON.stringify(analysis)).toContain('task-unknown');
	});

	test('critic marker scan is unaffected by reviewer-marker strays and prose', () => {
		const criticArtifact = [
			'[CRITIC] | C-1 | UPHELD | HIGH | rationale long enough | required change text',
			'[REVIEWED] | task-unknown | APPROVED | looks fine',
			'Some plain prose line that is not a verdict row at all.',
		].join('\n');
		const analysis = analyzePrReviewVerdictRowContract(
			criticArtifact,
			['C-1'],
			'critic',
			REVIEWER_CLAIMS_FOR_C1,
		);

		expect(analysis.ok).toBe(true);
		const { parsed } = parsePrReviewVerdictRows(
			criticArtifact,
			['C-1'],
			'critic',
			REVIEWER_CLAIMS_FOR_C1,
		);
		expect(parsed.has('C-1')).toBe(true);
	});
});

describe('issue #3334 AC1: quarantined ids are bounded to identifier-charset text', () => {
	test('row prose in the id field collapses to (invalid-id), never leaks', () => {
		const artifact = [
			'[REVIEWED] | c1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |',
			'[REVIEWED] | reviewed files a b c and gates | APPROVED | looks fine',
		].join('\n');
		const { quarantined } = parsePrReviewVerdictRows(
			artifact,
			['c1'],
			'reviewer',
		);
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0]?.itemId).toBe('(invalid-id)');
		const serialized = JSON.stringify(quarantined);
		expect(serialized).not.toContain('reviewed files');
	});

	test('a clean id longer than 64 characters is sliced to 64', () => {
		const longId = 'x'.repeat(80);
		const artifact = `[REVIEWED] | ${longId} | APPROVED | looks fine`;
		const { quarantined } = parsePrReviewVerdictRows(
			artifact,
			['c1'],
			'reviewer',
		);
		expect(quarantined[0]?.itemId).toBe('x'.repeat(64));
	});

	test('a secret-shaped id renders the fixed (redacted) sentinel', () => {
		// Charset-clean token shapes (GitHub PAT style) pass the identifier
		// check but must never surface through the diagnostic; redaction
		// placeholders ([REDACTED:<type>]) are themselves outside the
		// identifier charset. The fixture is built by concatenation so the
		// literal token shape never appears in source (push-protection rule).
		const secretPrefix = ['ghp', '_'].join('');
		const secretId = secretPrefix + '0123456789abcdefghijklmnopqrstuvwxyzAB';
		const artifact = `[REVIEWED] | ${secretId} | APPROVED | looks fine`;
		const { quarantined } = parsePrReviewVerdictRows(
			artifact,
			['c1'],
			'reviewer',
		);
		expect(quarantined[0]?.itemId).toBe('(redacted)');
		expect(JSON.stringify(quarantined)).not.toContain(secretId);
	});

	test('an absent id field surfaces as the (missing) sentinel', () => {
		const artifact = '[REVIEWED] |  | APPROVED | looks fine';
		const { quarantined } = parsePrReviewVerdictRows(
			artifact,
			['c1'],
			'reviewer',
		);
		expect(quarantined[0]?.itemId).toBe('(missing)');
	});

	test('a bare arity-1 marker row (undefined id field) also surfaces (missing)', () => {
		// A line consisting of only the marker parses as an arity-1 row with
		// fields[1] undefined — the reachable path for the undefined arm of
		// the (missing) sentinel.
		const { quarantined } = parsePrReviewVerdictRows(
			'[REVIEWED]',
			['c1'],
			'reviewer',
		);
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0]?.itemId).toBe('(missing)');
	});
});

describe('issue #3375 review PRR-002: assigned ids keep their raw form in analysis.actual', () => {
	test('a legitimately-assigned non-charset id renders raw and never as unexpected', () => {
		// Assigned ids are controller-declared (same trust level as the
		// expected string), so the sentinel bounding applies only to ids
		// absent from the assigned set; bounding a legal assigned id made
		// actual contradict ok.
		const artifact =
			'[REVIEWED] | src/foo.ts:12 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |';
		const analysis = analyzePrReviewVerdictRowContract(
			artifact,
			['src/foo.ts:12'],
			'reviewer',
		);
		expect(analysis.ok).toBe(true);
		const actual = JSON.parse(analysis.actual) as {
			observedIds: string[];
			unexpectedIds: string[];
		};
		expect(actual.observedIds).toEqual(['src/foo.ts:12']);
		expect(actual.unexpectedIds).toEqual([]);
	});
});
