/**
 * Stale-verdict detection tests for `submit_council_verdicts`.
 *
 * Extracted from submit-council-verdicts.test.ts for FR-006 test-file line-cap
 * compliance (issue #2020 review finding F-003). Covers the staleness guard:
 * explicit stale verdictRound rejection, omitted verdictRound acceptance at
 * round 2+ (the #2020 deadlock fix), mixed omitted+explicit-current, and the
 * edge cases surfaced by PR #2021 review (future-round verdictRound, REJECT at
 * round 2 with omitted verdictRound).
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const writeConfig = (dir: string, council: Record<string, unknown>): void => {
	mkdirSync(join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ council }),
	);
};

const makeVerdict = (
	agent: string,
	verdict: 'APPROVE' | 'CONCERNS' | 'REJECT' = 'APPROVE',
	verdictRound?: number,
): Record<string, unknown> => ({
	agent,
	verdict,
	...(verdictRound !== undefined ? { verdictRound } : {}),
	confidence: 1,
	findings: [],
	criteriaAssessed: [],
	criteriaUnmet: [],
	durationMs: 10,
});

describe('submit_council_verdicts — stale verdict detection', () => {
	test('rejects stale verdictRound values from prior rounds', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-stale-verdict-round-'));
		try {
			writeConfig(tempDir, { enabled: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '3.1',
					swarmId: 'swarm-1',
					roundNumber: 2,
					verdicts: [
						makeVerdict('critic', 'APPROVE', 2),
						makeVerdict('reviewer', 'APPROVE', 2),
						makeVerdict('sme', 'CONCERNS', 1),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('stale_verdict_detected');
			expect(parsed.staleVerdicts).toEqual([{ agent: 'sme', verdictRound: 1 }]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('accepts fresh verdicts when verdictRound is omitted at round > 1 (issue #2020)', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-fresh-omitted-round-'));
		try {
			writeConfig(tempDir, { enabled: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			// All 5 members dispatched fresh for round 2 — none emit verdictRound
			// because no production code path stamps it (issue #2020). These must
			// be accepted as fresh, not rejected as stale.
			const result = await submit_council_verdicts.execute(
				{
					taskId: '3.2',
					swarmId: 'swarm-1',
					roundNumber: 2,
					verdicts: [
						makeVerdict('critic', 'APPROVE'),
						makeVerdict('reviewer', 'APPROVE'),
						makeVerdict('sme', 'APPROVE'),
						makeVerdict('test_engineer', 'APPROVE'),
						makeVerdict('explorer', 'APPROVE'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.overallVerdict).toBe('APPROVE');
			expect(parsed.roundNumber).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('round 2 accepts mixed omitted + explicit-current verdictRound (issue #2020)', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-fresh-mixed-round-'));
		try {
			writeConfig(tempDir, { enabled: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			// Some members omit verdictRound, others set it to the current round 2.
			// Both are fresh and must be accepted.
			const result = await submit_council_verdicts.execute(
				{
					taskId: '3.3',
					swarmId: 'swarm-1',
					roundNumber: 2,
					verdicts: [
						makeVerdict('critic', 'APPROVE'), // omitted → defaults to round 2
						makeVerdict('reviewer', 'APPROVE', 2), // explicit current round
						makeVerdict('sme', 'APPROVE'), // omitted
						makeVerdict('test_engineer', 'APPROVE', 2), // explicit current
						makeVerdict('explorer', 'APPROVE'), // omitted
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.overallVerdict).toBe('APPROVE');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('round 2 accepts future-dated verdictRound without error (PRR-001)', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-future-round-'));
		try {
			writeConfig(tempDir, { enabled: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			// A verdictRound greater than roundNumber is nonsensical but harmless:
			// the stale check rejects OLD verdicts, not future ones. (5 ?? 2) < 2
			// is false, so the verdict is accepted.
			const result = await submit_council_verdicts.execute(
				{
					taskId: '3.4',
					swarmId: 'swarm-1',
					roundNumber: 2,
					verdicts: [
						makeVerdict('critic', 'APPROVE', 5),
						makeVerdict('reviewer', 'APPROVE', 2),
						makeVerdict('sme', 'APPROVE'),
						makeVerdict('test_engineer', 'APPROVE', 2),
						makeVerdict('explorer', 'APPROVE'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.overallVerdict).toBe('APPROVE');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('round 2 with omitted verdictRound + REJECT still blocks via veto (PRR-005)', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-reject-round2-'));
		try {
			writeConfig(tempDir, { enabled: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			// Omitted verdictRound at round 2 passes the staleness check (the fix),
			// but a REJECT verdict must still block via the veto logic. This proves
			// the staleness fix does not mask the veto/blocking path.
			const result = await submit_council_verdicts.execute(
				{
					taskId: '3.5',
					swarmId: 'swarm-1',
					roundNumber: 2,
					verdicts: [
						makeVerdict('critic', 'APPROVE'),
						makeVerdict('reviewer', 'APPROVE'),
						makeVerdict('sme', 'REJECT'),
						makeVerdict('test_engineer', 'APPROVE'),
						makeVerdict('explorer', 'APPROVE'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			// REJECT with vetoPriority (default true) → overallVerdict REJECT.
			// Evidence IS written (stale check passed), so success is true — the
			// veto is reflected in overallVerdict, not in success:false.
			expect(parsed.success).toBe(true);
			expect(parsed.overallVerdict).toBe('REJECT');
			expect(parsed.vetoedBy).toEqual(['sme']);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
