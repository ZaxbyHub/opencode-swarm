/**
 * Issue #3310 AC3 — quarantine never fabricates a claim.
 *
 * An assigned item whose ONLY [REVIEWED] row has illegal arity must stay
 * unsettled: the row is a per-item contract failure, and quarantining it must
 * never create a claim for an id whose only row was quarantined.
 *
 * GREEN at base (PRESERVING); must remain green after the fix.
 */

import {
	analyzePrReviewVerdictRowContract,
	parsePrReviewVerdictRows,
} from '../../../src/pr-review/legacy-transcript-adapter.js';

describe('issue #3310 AC3: quarantine never claims an item whose only row was quarantined', () => {
	test('assigned id with only an illegal-arity row stays unclaimed and fails the contract', () => {
		// 8 pipe-separated fields — the legal reviewer arity is 12 (after
		// legacy-10 normalization), so this row can never yield a claim.
		const artifact =
			'[REVIEWED] | C-1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | r';
		const analysis = analyzePrReviewVerdictRowContract(
			artifact,
			['C-1'],
			'reviewer',
		);

		expect(analysis.ok).toBe(false);
		const actual = JSON.parse(analysis.actual) as {
			invalidOrMissingIds: string[];
		};
		expect(actual.invalidOrMissingIds).toContain('C-1');
		const { parsed } = parsePrReviewVerdictRows(artifact, ['C-1'], 'reviewer');
		expect(parsed.has('C-1')).toBe(false);
	});
});

describe('issue #3334 AC2: control characters in a quarantined id become (invalid-id)', () => {
	test('an escaped-newline id is replaced, so no newline reaches any egress surface', () => {
		// The parser decodes the canonical \n escape into a REAL control
		// character inside the id field; the quarantine entry must collapse
		// it to the sentinel so diagnostics, telemetry payloads, and the
		// joined BLOCKED message cannot be line-injected.
		const artifact = [
			'[REVIEWED] | c1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |',
			'[REVIEWED] | bad\\nid | APPROVED | looks fine',
		].join('\n');
		const { quarantined } = parsePrReviewVerdictRows(
			artifact,
			['c1'],
			'reviewer',
		);
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0]?.itemId).toBe('(invalid-id)');
		const serialized = JSON.stringify(quarantined);
		expect(serialized).not.toMatch(/\\n|[\r\n]/);
	});

	test('#3334 recurrence sweep: analysis.actual observed ids are bounded too', () => {
		// observedIds render into the exact-set contract failure text
		// (analysis.actual → the lane-failure diagnostics), so a prose id on
		// a LEGAL-arity marker row must not leak through that surface either.
		const artifact = [
			'[REVIEWED] | c1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |',
			'[REVIEWED] | prose id with spaces | CONFIRMED | STATIC_TRACE_PROVEN | LOW | YES | b.ts:2 | rationale | probe | notes | UNKNOWN |',
		].join('\n');
		const analysis = analyzePrReviewVerdictRowContract(
			artifact,
			['c1'],
			'reviewer',
		);
		expect(analysis.ok).toBe(false);
		expect(analysis.actual).toContain('(invalid-id)');
		expect(analysis.actual).not.toContain('prose id with spaces');
	});
});
