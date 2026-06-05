/**
 * Quorum guard tests for `submit_council_verdicts`.
 *
 * These tests cover the bug-fix surface area introduced by the council
 * tool-correctness plan: the model can no longer call submit_council_verdicts
 * with a single verdict and receive an APPROVE.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgentSession } from '../../../src/state';

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

describe('submit_council_verdicts — quorum guard', () => {
	test('1 verdict with default minimumMembers=3 → insufficient_quorum', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-quorum-1of3-'));
		try {
			writeConfig(tempDir, { enabled: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [makeVerdict('reviewer', 'APPROVE')],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('insufficient_quorum');
			expect(parsed.quorumRequired).toBe(3);
			expect(parsed.membersVoted).toEqual(['reviewer']);
			expect(parsed.membersAbsent).toEqual([
				'critic',
				'sme',
				'test_engineer',
				'explorer',
			]);
			expect(parsed.message).toContain('Council quorum not met');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('3 distinct verdicts with minimumMembers=3 → success with quorum metadata', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-quorum-3of3-'));
		try {
			writeConfig(tempDir, { enabled: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [
						makeVerdict('critic'),
						makeVerdict('reviewer'),
						makeVerdict('sme'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.overallVerdict).toBe('APPROVE');
			expect(parsed.quorumMet).toBe(true);
			expect(parsed.quorumSize).toBe(3);
			expect(parsed.membersVoted).toEqual(['critic', 'reviewer', 'sme']);
			expect(parsed.membersAbsent).toEqual(['test_engineer', 'explorer']);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('2 verdicts from same agent (duplicate) with minimumMembers=2 → insufficient_quorum (counted as 1)', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-quorum-dup-'));
		try {
			writeConfig(tempDir, { enabled: true, minimumMembers: 2 });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [makeVerdict('reviewer'), makeVerdict('reviewer')],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('insufficient_quorum');
			expect(parsed.quorumRequired).toBe(2);
			expect(parsed.membersVoted).toEqual(['reviewer']);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('5 verdicts all from same agent (adversarial) → insufficient_quorum, quorumSize=1', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-quorum-adversarial-'));
		try {
			writeConfig(tempDir, { enabled: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [
						makeVerdict('reviewer'),
						makeVerdict('reviewer'),
						makeVerdict('reviewer'),
						makeVerdict('reviewer'),
						makeVerdict('reviewer'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('insufficient_quorum');
			expect(parsed.membersVoted).toEqual(['reviewer']);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('requireAllMembers=true + 4 verdicts → insufficient_quorum (effective minimum is 5)', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-require-4-'));
		try {
			writeConfig(tempDir, { enabled: true, requireAllMembers: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [
						makeVerdict('critic'),
						makeVerdict('reviewer'),
						makeVerdict('sme'),
						makeVerdict('test_engineer'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.reason).toBe('insufficient_quorum');
			expect(parsed.quorumRequired).toBe(5);
			expect(parsed.membersAbsent).toEqual(['explorer']);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('requireAllMembers=true + 5 verdicts → success with quorumSize=5', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-require-5-'));
		try {
			writeConfig(tempDir, { enabled: true, requireAllMembers: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [
						makeVerdict('critic'),
						makeVerdict('reviewer'),
						makeVerdict('sme'),
						makeVerdict('test_engineer'),
						makeVerdict('explorer'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.overallVerdict).toBe('APPROVE');
			expect(parsed.quorumSize).toBe(5);
			expect(parsed.membersAbsent).toEqual([]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('minimumMembers=1 disables quorum enforcement (1 verdict succeeds)', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-min-1-'));
		try {
			writeConfig(tempDir, { enabled: true, minimumMembers: 1 });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [makeVerdict('reviewer')],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.quorumSize).toBe(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('failure response shape includes membersVoted, membersAbsent, quorumRequired', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-failure-shape-'));
		try {
			writeConfig(tempDir, { enabled: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [makeVerdict('critic'), makeVerdict('reviewer')],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('membersVoted');
			expect(parsed).toHaveProperty('membersAbsent');
			expect(parsed).toHaveProperty('quorumRequired');
			expect(Array.isArray(parsed.membersVoted)).toBe(true);
			expect(Array.isArray(parsed.membersAbsent)).toBe(true);
			expect(typeof parsed.quorumRequired).toBe('number');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('success response shape includes membersVoted, membersAbsent, quorumSize, quorumMet', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-success-shape-'));
		try {
			writeConfig(tempDir, { enabled: true });
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [
						makeVerdict('critic'),
						makeVerdict('reviewer'),
						makeVerdict('sme'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed).toHaveProperty('membersVoted');
			expect(parsed).toHaveProperty('membersAbsent');
			expect(parsed).toHaveProperty('quorumSize');
			expect(parsed.quorumMet).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('rejects cherry-picked re-dispatch after insufficient_quorum in same round', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-quorum-cherry-pick-'));
		const sessionID = `submit-council-${Date.now()}-a`;
		try {
			writeConfig(tempDir, { enabled: true });
			startAgentSession(sessionID, 'architect', undefined, tempDir);
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const first = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [makeVerdict('critic'), makeVerdict('test_engineer')],
					working_directory: tempDir,
				},
				{ directory: tempDir, sessionID },
			);
			const firstParsed = JSON.parse(first);
			expect(firstParsed.reason).toBe('insufficient_quorum');
			expect(firstParsed.membersAbsent).toEqual(['reviewer', 'sme', 'explorer']);

			const retry = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [
						makeVerdict('critic'),
						makeVerdict('test_engineer'),
						makeVerdict('reviewer'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir, sessionID },
			);
			const retryParsed = JSON.parse(retry);
			expect(retryParsed.success).toBe(false);
			expect(retryParsed.reason).toBe('cherry_pick_detected');
			expect(retryParsed.stillMissingMembers).toEqual(['sme', 'explorer']);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('round 2 requires prior-round dissenter to re-review', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'submit-dissenter-round2-'));
		const sessionID = `submit-council-${Date.now()}-b`;
		try {
			writeConfig(tempDir, { enabled: true });
			startAgentSession(sessionID, 'architect', undefined, tempDir);
			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const round1 = await submit_council_verdicts.execute(
				{
					taskId: '2.2',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [
						makeVerdict('critic', 'APPROVE', 1),
						makeVerdict('reviewer', 'APPROVE', 1),
						makeVerdict('sme', 'CONCERNS', 1),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir, sessionID },
			);
			const round1Parsed = JSON.parse(round1);
			expect(round1Parsed.success).toBe(true);

			const round2 = await submit_council_verdicts.execute(
				{
					taskId: '2.2',
					swarmId: 'swarm-1',
					roundNumber: 2,
					verdicts: [
						makeVerdict('critic', 'APPROVE', 2),
						makeVerdict('reviewer', 'APPROVE', 2),
						makeVerdict('test_engineer', 'APPROVE', 2),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir, sessionID },
			);
			const round2Parsed = JSON.parse(round2);
			expect(round2Parsed.success).toBe(false);
			expect(round2Parsed.reason).toBe('cherry_pick_detected');
			expect(round2Parsed.stillMissingMembers).toEqual(['sme']);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

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
			expect(parsed.staleVerdicts).toEqual([
				{ agent: 'sme', verdictRound: 1 },
			]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
