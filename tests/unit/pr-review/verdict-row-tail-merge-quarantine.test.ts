/**
 * Issue #3357 (completing #3275 RC2): a verdict row that ARRIVED over its
 * marker's legal arity is tail-merged down to exactly the legal count by
 * parsePrReviewVerdictRow, so the #3310 post-parse-arity quarantine never
 * fired — the row entered the exact-set count with an unassigned id and
 * voided every valid sibling row (the #3275 deadlock shape).
 *
 * Pins the post-fix behavior: such rows are quarantined on their RAW arrival
 * arity when the caller supplies the assigned-id set; assigned-id tail-merged
 * rows keep the legacy pipe-recovery path; the exact-arrival spoofing floor
 * still voids. RED at base, GREEN after the fix (frozen trace check C1 is the
 * same contract; this is the CI-tracked twin).
 */

import { describe, expect, test } from 'bun:test';
import { parsePrReviewVerdictRow } from '../../../src/background/pr-review-contract.js';
import {
	analyzePrReviewVerdictRowContract,
	parsePrReviewVerdictRows,
} from '../../../src/pr-review/legacy-transcript-adapter.js';

const GOOD_REVIEWER_ROW =
	'[REVIEWED] | c1 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | src/a.ts:10 | rationale text | probe text | notes | UNKNOWN |';
/** Stage-B grammar row, 14 raw fields against the 12-field reviewer grammar. */
const STAGE_B_REVIEWER_STRAY_14 =
	'[REVIEWED] | task-unknown | REJECTED | summary | with | pipes | a | b | c | d | e | f | g | h';
/** Legal 6-field critic row. */
const GOOD_CRITIC_ROW =
	'[CRITIC] | c1 | UPHELD | HIGH | rationale text | none needed';
/** Stage-B grammar row, 9 raw fields against the 6-field critic grammar. */
const STAGE_B_CRITIC_STRAY_9 =
	'[CRITIC] | task-2.1 | APPROVED | summary | with | pipes | a | b | c';
/** Exact-arrival-arity 12-field row with an unassigned id: the spoofing class. */
const SPOOF_ROW_12 =
	'[REVIEWED] | ghost-id | CONFIRMED | STRUCTURALLY_PROVEN | LOW | NO | src/a.ts:1 | rationale text | probe text | notes | UNKNOWN |';

describe('verdict-row tail-merge quarantine (#3357)', () => {
	test('parser reports the raw arrival arity for tail-merged rows', () => {
		const row = parsePrReviewVerdictRow(STAGE_B_REVIEWER_STRAY_14, 'reviewer');
		expect(row?.recoveredOverflow).toBe(true);
		expect(row?.fields.length).toBe(12);
		expect(row?.rawFieldCount).toBe(14);
		const exact = parsePrReviewVerdictRow(GOOD_REVIEWER_ROW, 'reviewer');
		expect(exact?.recoveredOverflow).toBe(false);
		expect(exact?.rawFieldCount).toBe(12);
	}, 30000);

	test('reviewer leg: over-arity Stage-B stray is quarantined, valid sibling settles, raw arity 14', () => {
		const analysis = analyzePrReviewVerdictRowContract(
			`${GOOD_REVIEWER_ROW}\n${STAGE_B_REVIEWER_STRAY_14}`,
			['c1'],
			'reviewer',
		);
		expect(analysis.ok).toBe(true);
		expect(analysis.quarantined.length).toBe(1);
		expect(analysis.quarantined[0]?.itemId).toBe('task-unknown');
		expect(analysis.quarantined[0]?.arity).toBe(14);
	}, 30000);

	test('critic leg: over-arity Stage-B stray is quarantined at raw arity 9', () => {
		const analysis = analyzePrReviewVerdictRowContract(
			`${GOOD_CRITIC_ROW}\n${STAGE_B_CRITIC_STRAY_9}`,
			['c1'],
			'critic',
		);
		expect(analysis.ok).toBe(true);
		expect(analysis.quarantined.length).toBe(1);
		expect(analysis.quarantined[0]?.arity).toBe(9);
	}, 30000);

	test('spoofing floor: an exact-arity unassigned row still voids the lane', () => {
		const analysis = analyzePrReviewVerdictRowContract(
			`${GOOD_REVIEWER_ROW}\n${SPOOF_ROW_12}`,
			['c1'],
			'reviewer',
		);
		expect(analysis.ok).toBe(false);
		expect(analysis.quarantined).toEqual([]);
	}, 30000);

	test('assigned-id tail-merged rows keep the legacy pipe-recovery path (not quarantined)', () => {
		const text = `${GOOD_REVIEWER_ROW}\n${'[REVIEWED] | c2 | DISPROVED | STRUCTURALLY_PROVEN | NONE | NO | src/b.ts:2 | rationale | probe | notes | UNKNOWN | prose | with | extra | pipes'}`;
		const parsed = parsePrReviewVerdictRows(text, ['c1', 'c2'], 'reviewer');
		expect(parsed.quarantined).toEqual([]);
		expect(parsed.recoveries.length).toBe(1);
		expect(parsed.recoveries[0]?.itemId).toBe('c2');
		expect(parsed.recoveries[0]?.recovery).toBe('legacy-lossy');
	}, 30000);
});
