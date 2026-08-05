/**
 * Stale-verdict detection tests for `submit_phase_council_verdicts`.
 *
 * Extracted from submit-phase-council-verdicts.unit.test.ts for FR-006
 * test-file line-cap compliance (issue #2020 review finding F-003).
 * Covers the staleness guard at the phase level: omitted verdictRound
 * acceptance at round 2+ (the #2020 deadlock fix), mixed omitted+explicit,
 * and explicit stale rejection.
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

const writeMutationGateEvidence = (
	dir: string,
	phaseNumber: number,
	verdict: 'pass' | 'warn' | 'fail' | 'skip',
): void => {
	const evidenceDir = join(dir, '.swarm', 'evidence', String(phaseNumber));
	mkdirSync(evidenceDir, { recursive: true });
	writeFileSync(
		join(evidenceDir, 'mutation-gate.json'),
		JSON.stringify({
			entries: [
				{ type: 'mutation-gate', verdict, timestamp: '2026-01-01T00:00:00Z' },
			],
		}),
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
	confidence: 0.9,
	findings: [],
	criteriaAssessed: [],
	criteriaUnmet: [],
	durationMs: 10,
});

const ALL_5_VERDICTS = [
	makeVerdict('critic'),
	makeVerdict('reviewer'),
	makeVerdict('sme'),
	makeVerdict('test_engineer'),
	makeVerdict('explorer'),
];

describe('submit_phase_council_verdicts — stale verdict detection', () => {
	test('roundNumber:2 with omitted verdictRound is accepted (issue #2020)', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'spcv-fresh-omitted-'));
		try {
			writeConfig(tempDir, { enabled: true });
			writeMutationGateEvidence(tempDir, 1, 'pass');
			const { submit_phase_council_verdicts } = await import(
				'../../../src/tools/submit-phase-council-verdicts'
			);
			// All 5 members dispatched fresh for round 2 — none emit verdictRound
			// because no production code path stamps it (issue #2020). These must
			// be accepted as fresh, not rejected as stale.
			const result = await submit_phase_council_verdicts.execute(
				{
					phaseNumber: 1,
					swarmId: 'test',
					phaseSummary: 'Phase 1.',
					roundNumber: 2,
					verdicts: ALL_5_VERDICTS,
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
		const tempDir = mkdtempSync(join(tmpdir(), 'spcv-fresh-mixed-'));
		try {
			writeConfig(tempDir, { enabled: true });
			writeMutationGateEvidence(tempDir, 1, 'pass');
			const { submit_phase_council_verdicts } = await import(
				'../../../src/tools/submit-phase-council-verdicts'
			);
			const result = await submit_phase_council_verdicts.execute(
				{
					phaseNumber: 1,
					swarmId: 'test',
					phaseSummary: 'Phase 1.',
					roundNumber: 2,
					verdicts: [
						makeVerdict('critic'), // omitted → defaults to round 2
						makeVerdict('reviewer', 'APPROVE', 2), // explicit current
						makeVerdict('sme'), // omitted
						makeVerdict('test_engineer', 'APPROVE', 2), // explicit current
						makeVerdict('explorer'), // omitted
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

	test('roundNumber:2 with explicit verdictRound:1 returns stale_verdict_detected', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'spcv-stale-explicit-'));
		try {
			writeConfig(tempDir, { enabled: true });
			const { submit_phase_council_verdicts } = await import(
				'../../../src/tools/submit-phase-council-verdicts'
			);
			const result = await submit_phase_council_verdicts.execute(
				{
					phaseNumber: 1,
					swarmId: 'test',
					phaseSummary: 'Phase 1.',
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
});
