/**
 * Tests for write_final_council_evidence tool.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CouncilMemberVerdict } from '../../../src/council/types';
import { executeWriteFinalCouncilEvidence } from '../../../src/tools/write-final-council-evidence';

const members = [
	'critic',
	'reviewer',
	'sme',
	'test_engineer',
	'explorer',
] as const;

function verdict(
	agent: (typeof members)[number],
	overrides: Partial<CouncilMemberVerdict> = {},
): CouncilMemberVerdict {
	return {
		agent,
		verdict: 'APPROVE',
		confidence: 0.9,
		findings: [],
		criteriaAssessed: ['project-scope'],
		criteriaUnmet: [],
		durationMs: 25,
		...overrides,
	};
}

function allApprovedVerdicts(): CouncilMemberVerdict[] {
	return members.map((member) => verdict(member));
}

function rejectingVerdicts(): CouncilMemberVerdict[] {
	return [
		verdict('critic', {
			verdict: 'REJECT',
			findings: [
				{
					severity: 'HIGH',
					category: 'logic',
					location: 'src/example.ts:10',
					detail: 'Project close would ship an unresolved runtime bug.',
					evidence: 'critic found failing path',
				},
			],
			criteriaUnmet: ['project-scope'],
		}),
		...members
			.filter((member) => member !== 'critic')
			.map((member) => verdict(member)),
	];
}

describe('executeWriteFinalCouncilEvidence', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'final-council-evidence-test-'),
		);
		await fs.promises.mkdir(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors.
		}
	});

	test('writes project-scoped five-member final council evidence', async () => {
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 3,
				projectSummary: 'All planned project phases are complete.',
				verdicts: allApprovedVerdicts(),
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.phase).toBe(3);
		expect(parsed.verdict).toBe('approved');
		expect(parsed.overallVerdict).toBe('APPROVE');
		expect(parsed.quorumSize).toBe(5);
		expect(parsed.membersVoted).toEqual([...members]);
		expect(parsed.evidencePath).toBe('.swarm/evidence/final-council.json');

		const expectedPath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'final-council.json',
		);
		const content = await fs.promises.readFile(expectedPath, 'utf-8');
		const evidence = JSON.parse(content);
		const entry = evidence.entries[0];

		expect(entry.type).toBe('final-council');
		expect(entry.phase).toBe(3);
		expect(entry.verdict).toBe('approved');
		expect(entry.rawCouncilVerdict).toBe('APPROVE');
		expect(entry.quorumSize).toBe(5);
		expect(entry.memberVerdicts).toHaveLength(5);
		expect(entry.membersAbsent).toEqual([]);
		expect(entry.projectSummary).toBe(
			'All planned project phases are complete.',
		);
		expect(entry.unifiedFeedbackMd).toContain('## Final Council Review');
		expect(entry.unifiedFeedbackMd).not.toContain('Phase Council Review');
		expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
	});

	test('normalizes rejecting or concern final council verdicts to rejected evidence verdict', async () => {
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 2,
				projectSummary: 'Project complete pending final review.',
				verdicts: rejectingVerdicts(),
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.overallVerdict).toBe('REJECT');
		expect(parsed.verdict).toBe('rejected');
		expect(parsed.requiredFixesCount).toBe(1);

		const content = await fs.promises.readFile(
			path.join(tempDir, '.swarm', 'evidence', 'final-council.json'),
			'utf-8',
		);
		const entry = JSON.parse(content).entries[0];
		expect(entry.verdict).toBe('rejected');
		expect(entry.requiredFixes).toHaveLength(1);
		expect(entry.allCriteriaMet).toBe(false);
	});

	test('rejects invalid phase and missing project summary', async () => {
		const badPhase = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 0,
					projectSummary: 'Project summary',
					verdicts: allApprovedVerdicts(),
				},
				tempDir,
			),
		);
		expect(badPhase.success).toBe(false);
		expect(badPhase.reason).toBe('invalid arguments');
		expect(badPhase.errors[0].path).toBe('phase');

		const missingSummary = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: '',
					verdicts: allApprovedVerdicts(),
				},
				tempDir,
			),
		);
		expect(missingSummary.success).toBe(false);
		expect(missingSummary.reason).toBe('invalid arguments');
		expect(missingSummary.errors[0].path).toBe('projectSummary');
	});

	test('rejects legacy verdict and summary payloads', async () => {
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				verdict: 'APPROVED',
				summary: 'Legacy simple payload',
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
		expect(
			parsed.errors.map((error: { path: string }) => error.path),
		).toContain('projectSummary');
		expect(
			parsed.errors.map((error: { path: string }) => error.path),
		).toContain('verdicts');
	});

	test('rejects insufficient quorum with actionable absent-member metadata', async () => {
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Project summary',
				verdicts: [verdict('critic'), verdict('reviewer')],
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('insufficient_quorum');
		expect(parsed.membersVoted).toEqual(['critic', 'reviewer']);
		expect(parsed.membersAbsent).toEqual(['sme', 'test_engineer', 'explorer']);
		expect(parsed.quorumRequired).toBe(5);
	});

	test('uses atomic temp+rename pattern', async () => {
		const writeFileSpy = spyOn(fs.promises, 'writeFile');
		const renameSpy = spyOn(fs.promises, 'rename');

		await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Atomic write test',
				verdicts: allApprovedVerdicts(),
			},
			tempDir,
		);

		expect(writeFileSpy).toHaveBeenCalledTimes(1);
		expect(renameSpy).toHaveBeenCalledTimes(1);

		const tempPath = writeFileSpy.mock.calls[0][0] as string;
		const renameFrom = renameSpy.mock.calls[0][0] as string;
		const renameTo = renameSpy.mock.calls[0][1] as string;

		expect(tempPath).toContain('.swarm');
		expect(tempPath).toContain('.final-council.json.tmp');
		expect(renameFrom).toBe(tempPath);
		expect(renameTo).toBe(
			path.join(tempDir, '.swarm', 'evidence', 'final-council.json'),
		);

		writeFileSpy.mockRestore();
		renameSpy.mockRestore();
	});
});
