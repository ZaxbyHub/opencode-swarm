/**
 * Issue #3310 AC25 — a quarantined short row naming an ASSIGNED id does not
 * fail the valid row for that same id.
 *
 * When an assigned id has one legal-arity row plus one illegal-arity short
 * row naming the same id, the short row must be quarantined (not counted) and
 * the valid row must settle the item.
 *
 * Regression pin: GREEN at base 25a201430 and after this PR. The illegal-arity
 * quarantine branch already exists at base (indexVerdictRows), so these cases
 * pass at base; this file guards that behaviour against regression.
 */

import {
	analyzePrReviewVerdictRowContract,
	type PrReviewItemClaim,
	parsePrReviewVerdictRows,
} from '../../../src/pr-review/legacy-transcript-adapter.js';

const REVIEWER_CLAIMS: ReadonlyMap<string, PrReviewItemClaim> = new Map([
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

describe('issue #3310 AC25: quarantined short duplicate does not fail the valid row for the same id', () => {
	test('reviewer: valid row settles despite a short 4-field row naming the same assigned id', () => {
		const artifact = [
			'[REVIEWED] | C-1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |',
			'[REVIEWED] | C-1 | APPROVED | fine',
		].join('\n');
		const analysis = analyzePrReviewVerdictRowContract(
			artifact,
			['C-1'],
			'reviewer',
		);

		expect(analysis.ok).toBe(true);
		const { parsed } = parsePrReviewVerdictRows(artifact, ['C-1'], 'reviewer');
		expect(parsed.has('C-1')).toBe(true);
		expect(parsed.get('C-1')?.classification).toBe('CONFIRMED');
		expect(parsed.get('C-1')?.severity).toBe('HIGH');
	});

	test('critic: valid row settles despite a short 4-field row naming the same assigned id', () => {
		const artifact = [
			'[CRITIC] | C-1 | UPHELD | HIGH | rationale long enough | required change text',
			'[CRITIC] | C-1 | UPHELD | MEDIUM',
		].join('\n');
		const analysis = analyzePrReviewVerdictRowContract(
			artifact,
			['C-1'],
			'critic',
			REVIEWER_CLAIMS,
		);

		expect(analysis.ok).toBe(true);
		const { parsed } = parsePrReviewVerdictRows(
			artifact,
			['C-1'],
			'critic',
			REVIEWER_CLAIMS,
		);
		expect(parsed.has('C-1')).toBe(true);
		expect(parsed.get('C-1')?.classification).toBe('UPHELD');
		expect(parsed.get('C-1')?.severity).toBe('HIGH');
	});

	test('#3334 AC3 (parse-level): 16+ stray rows stay distinct, bounded, and never disturb the valid row', () => {
		// Parse-level arm of the 16+ stray rows case this file's issue argv
		// names: every stray id survives bounded and distinct, and the valid
		// sibling row still settles. (The composition-level ordering contract
		// is pinned by
		// tests/unit/hooks/pr-workflow-gate-quarantine-diagnostic-order-3334.test.ts;
		// per-lane aggregation versus per-row emission is not distinguished
		// there — see the PR body's considered-not-filed row.)
		const longStrayId = 'x'.repeat(200);
		const artifact = [
			'[REVIEWED] | C-1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |',
			...Array.from(
				{ length: 20 },
				(_v, index) => `[REVIEWED] | stray-${index} | APPROVED | looks fine`,
			),
			`[REVIEWED] | ${longStrayId} | APPROVED | looks fine`,
		].join('\n');
		const { quarantined, parsed } = parsePrReviewVerdictRows(
			artifact,
			['C-1'],
			'reviewer',
		);
		expect(quarantined).toHaveLength(21);
		// Every stray id is distinct and bounded (the 200-char id is cut to 64);
		// the valid row still settles.
		expect(new Set(quarantined.map((entry) => entry.itemId)).size).toBe(21);
		for (const entry of quarantined) {
			expect(entry.itemId.length).toBeLessThanOrEqual(64);
		}
		expect(parsed.has('C-1')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Issue #3362 AC3 — the corrected docstring contract, pinned: a LEGAL-arity
// duplicate remains a per-item parse failure (the item settles nothing), an
// ILLEGAL-arity duplicate is quarantined with the sibling keeping its claim,
// and an UNASSIGNED tail-merged (recovered-overflow) row is quarantined at
// its raw arrival arity with ZERO recovery bookkeeping — only admitted rows
// emit recovery entries.
// ---------------------------------------------------------------------------
describe('issue #3362 AC3: duplicate/overflow truth pins', () => {
	const LEGAL_ROW =
		'[REVIEWED] | C-1 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | a.ts:1 | rationale long | probe text | notes | UNKNOWN |';

	test('a LEGAL-arity duplicate remains a per-item parse failure (no claim for the item)', () => {
		const artifact = [LEGAL_ROW, LEGAL_ROW].join('\n');
		const { parsed, quarantined } = parsePrReviewVerdictRows(
			artifact,
			['C-1'],
			'reviewer',
		);
		// The item settles NOTHING: two legal rows for one id is the per-item
		// parse failure shape (rows?.length === 1 fails), not quarantine.
		expect(parsed.has('C-1')).toBe(false);
		expect(quarantined).toEqual([]);
	});

	test('an ILLEGAL-arity duplicate is quarantined and the legal sibling keeps the claim', () => {
		const artifact = [LEGAL_ROW, '[REVIEWED] | C-1 | APPROVED | fine'].join(
			'\n',
		);
		const { parsed, quarantined } = parsePrReviewVerdictRows(
			artifact,
			['C-1'],
			'reviewer',
		);
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0]?.itemId).toBe('C-1');
		expect(parsed.has('C-1')).toBe(true);
		expect(parsed.get('C-1')?.classification).toBe('CONFIRMED');
	});

	test('an UNASSIGNED tail-merged row quarantines at raw arity with ZERO recovery bookkeeping', () => {
		// 15 raw fields: tail-merged down to the 12-field legal shape, but the
		// id is not in the assigned set — the #3357 quarantine branch fires on
		// the RAW arrival arity and the recovery path never runs.
		const overArityGhost =
			'[REVIEWED] | c-ghost | DISPROVED | STRUCTURALLY_PROVEN | NONE | NO | src/b.ts:2 | rationale | probe | notes | UNKNOWN | prose | with | extra | pipes';
		const { parsed, quarantined, recoveries } = parsePrReviewVerdictRows(
			[LEGAL_ROW, overArityGhost].join('\n'),
			['C-1'],
			'reviewer',
		);
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0]?.itemId).toBe('c-ghost');
		// Raw arrival arity (15), not the tail-merged legal arity (12).
		expect(quarantined[0]?.arity).toBe(15);
		expect(recoveries).toEqual([]);
		expect(parsed.has('C-1')).toBe(true);
	});

	test('an ASSIGNED tail-merged row keeps the legacy recovery path (control leg)', () => {
		const overArityAssigned =
			'[REVIEWED] | C-2 | DISPROVED | STRUCTURALLY_PROVEN | NONE | NO | src/b.ts:2 | rationale | probe | notes | UNKNOWN | prose | with | extra | pipes';
		const { quarantined, recoveries } = parsePrReviewVerdictRows(
			[LEGAL_ROW, overArityAssigned].join('\n'),
			['C-1', 'C-2'],
			'reviewer',
		);
		// Mirrors the #3357 control: quarantine stays empty and the admitted
		// row emits its recovery entry (settlement shape is that suite's pin).
		expect(quarantined).toEqual([]);
		expect(recoveries).toHaveLength(1);
		expect(recoveries[0]?.itemId).toBe('C-2');
		expect(recoveries[0]?.recovery).toBe('legacy-lossy');
	});
});
