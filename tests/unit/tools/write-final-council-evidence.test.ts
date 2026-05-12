/**
 * Tests for write_final_council_evidence tool.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CouncilMemberVerdict } from '../../../src/council/types';
import {
	_internals,
	executeWriteFinalCouncilEvidence,
} from '../../../src/tools/write-final-council-evidence';

const members = [
	'critic',
	'reviewer',
	'sme',
	'test_engineer',
	'explorer',
] as const;

const originalInternals = { ..._internals };

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
		Object.assign(_internals, originalInternals);
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

	test('normalizes CONCERNS member verdicts to rejected evidence with raw CONCERNS verdict', async () => {
		const concernVerdicts = [
			verdict('critic', {
				verdict: 'CONCERNS',
				findings: [
					{
						severity: 'MEDIUM',
						category: 'release-readiness',
						location: 'docs/releases/v7.17.2.md',
						detail: 'Release note needs one more migration caveat.',
						evidence: 'critic concern',
					},
				],
			}),
			...members
				.filter((member) => member !== 'critic')
				.map((member) => verdict(member)),
		];

		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 2,
				projectSummary: 'Project complete with final council concerns.',
				verdicts: concernVerdicts,
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.overallVerdict).toBe('CONCERNS');
		expect(parsed.verdict).toBe('rejected');

		const content = await fs.promises.readFile(
			path.join(tempDir, '.swarm', 'evidence', 'final-council.json'),
			'utf-8',
		);
		const entry = JSON.parse(content).entries[0];
		expect(entry.verdict).toBe('rejected');
		expect(entry.rawCouncilVerdict).toBe('CONCERNS');
		expect(entry.advisoryFindings).toHaveLength(1);
		expect(entry.requiredFixes).toHaveLength(0);
	});

	test('aggregates multiple CONCERNS member verdicts into conflicts and rejected evidence', async () => {
		const concernVerdicts = [
			verdict('critic', {
				verdict: 'CONCERNS',
				findings: [
					{
						severity: 'MEDIUM',
						category: 'readiness',
						location: 'src/a.ts:1',
						detail: 'Add final readiness guard before project close.',
						evidence: 'critic concern',
					},
				],
			}),
			verdict('reviewer', {
				verdict: 'CONCERNS',
				findings: [
					{
						severity: 'LOW',
						category: 'docs',
						location: 'src/a.ts:1',
						detail: 'Remove final readiness guard before project close.',
						evidence: 'reviewer concern',
					},
				],
			}),
			...members
				.filter((member) => member !== 'critic' && member !== 'reviewer')
				.map((member) => verdict(member)),
		];

		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 2,
				projectSummary: 'Project complete with multiple concerns.',
				verdicts: concernVerdicts,
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.overallVerdict).toBe('CONCERNS');
		expect(parsed.verdict).toBe('rejected');
		expect(parsed.unresolvedConflictsCount).toBeGreaterThan(0);

		const content = await fs.promises.readFile(
			path.join(tempDir, '.swarm', 'evidence', 'final-council.json'),
			'utf-8',
		);
		const entry = JSON.parse(content).entries[0];
		expect(entry.rawCouncilVerdict).toBe('CONCERNS');
		expect(entry.unresolvedConflicts.length).toBeGreaterThan(0);
		expect(entry.advisoryFindings).toHaveLength(2);
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

	test('validates roundNumber boundaries and defaults to round 1', async () => {
		const defaultRound = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: 'Default round number',
					verdicts: allApprovedVerdicts(),
				},
				tempDir,
			),
		);
		expect(defaultRound.success).toBe(true);
		expect(defaultRound.roundNumber).toBe(1);

		const maxRound = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: 'Max round number',
					roundNumber: 10,
					verdicts: allApprovedVerdicts(),
				},
				tempDir,
			),
		);
		expect(maxRound.success).toBe(true);
		expect(maxRound.roundNumber).toBe(10);

		for (const roundNumber of [0, 11]) {
			const invalidRound = JSON.parse(
				await executeWriteFinalCouncilEvidence(
					{
						phase: 1,
						projectSummary: 'Invalid round number',
						roundNumber,
						verdicts: allApprovedVerdicts(),
					},
					tempDir,
				),
			);
			expect(invalidRound.success).toBe(false);
			expect(invalidRound.reason).toBe('invalid arguments');
			expect(invalidRound.errors[0].path).toBe('roundNumber');
		}
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

	test('returns a graceful error when final council synthesis throws', async () => {
		_internals.synthesizeFinalCouncilAdvisory = () => {
			throw new Error('synthesis unavailable');
		};

		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Synthesis failure test',
				verdicts: allApprovedVerdicts(),
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.phase).toBe(1);
		expect(parsed.message).toBe('synthesis unavailable');
	});

	test('returns a graceful error when plan loading throws', async () => {
		_internals.loadPlan = async () => {
			throw new Error('plan ledger unavailable');
		};

		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Plan failure test',
				verdicts: allApprovedVerdicts(),
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.phase).toBe(1);
		expect(parsed.message).toBe('plan ledger unavailable');
	});

	test('returns a graceful error when swarm path validation fails', async () => {
		_internals.validateSwarmPath = () => {
			throw new Error('path escaped .swarm');
		};

		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Path validation failure test',
				verdicts: allApprovedVerdicts(),
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.phase).toBe(1);
		expect(parsed.message).toBe('path escaped .swarm');
	});

	test('uses atomic temp+rename pattern', async () => {
		const writeFileSpy = spyOn(fs.promises, 'writeFile');
		const renameSpy = spyOn(fs.promises, 'rename');

		try {
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
			expect(tempPath).toContain('.final-council.json.');
			expect(tempPath.endsWith('.tmp')).toBe(true);
			expect(renameFrom).toBe(tempPath);
			expect(renameTo).toBe(
				path.join(tempDir, '.swarm', 'evidence', 'final-council.json'),
			);
		} finally {
			writeFileSpy.mockRestore();
			renameSpy.mockRestore();
		}
	});

	test('preserves previous evidence when replacement fails after backup', async () => {
		const finalPath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'final-council.json',
		);
		const firstResult = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Original final council evidence',
				verdicts: allApprovedVerdicts(),
			},
			tempDir,
		);
		expect(JSON.parse(firstResult).success).toBe(true);
		const originalContent = await fs.promises.readFile(finalPath, 'utf-8');

		const originalRename = fs.promises.rename;
		const renameSpy = spyOn(fs.promises, 'rename');
		let tempToFinalAttempts = 0;
		renameSpy.mockImplementation(async (from, to) => {
			const fromPath = from.toString();
			const toPath = to.toString();
			if (fromPath.endsWith('.tmp') && toPath === finalPath) {
				tempToFinalAttempts++;
				const error = new Error(
					tempToFinalAttempts === 1
						? 'destination already exists'
						: 'replacement denied',
				) as NodeJS.ErrnoException;
				error.code = tempToFinalAttempts === 1 ? 'EEXIST' : 'EACCES';
				throw error;
			}
			await originalRename(from, to);
		});

		try {
			const secondResult = await executeWriteFinalCouncilEvidence(
				{
					phase: 2,
					projectSummary: 'Replacement should fail safely',
					verdicts: allApprovedVerdicts(),
				},
				tempDir,
			);
			const parsed = JSON.parse(secondResult);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('replacement denied');
			expect(await fs.promises.readFile(finalPath, 'utf-8')).toBe(
				originalContent,
			);

			const leftovers = (
				await fs.promises.readdir(path.dirname(finalPath))
			).filter((name) => name.endsWith('.tmp') || name.endsWith('.bak'));
			expect(leftovers).toEqual([]);
		} finally {
			renameSpy.mockRestore();
		}
	});

	test('falls back to copying backup when restore rename fails', async () => {
		const finalPath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'final-council.json',
		);
		const firstResult = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Original final council evidence',
				verdicts: allApprovedVerdicts(),
			},
			tempDir,
		);
		expect(JSON.parse(firstResult).success).toBe(true);
		const originalContent = await fs.promises.readFile(finalPath, 'utf-8');

		const originalRename = fs.promises.rename;
		const renameSpy = spyOn(fs.promises, 'rename');
		let tempToFinalAttempts = 0;
		renameSpy.mockImplementation(async (from, to) => {
			const fromPath = from.toString();
			const toPath = to.toString();
			if (fromPath.endsWith('.tmp') && toPath === finalPath) {
				tempToFinalAttempts++;
				const error = new Error(
					tempToFinalAttempts === 1
						? 'destination already exists'
						: 'replacement denied',
				) as NodeJS.ErrnoException;
				error.code = tempToFinalAttempts === 1 ? 'EEXIST' : 'EACCES';
				throw error;
			}
			if (fromPath.endsWith('.bak') && toPath === finalPath) {
				const error = new Error('restore denied') as NodeJS.ErrnoException;
				error.code = 'EACCES';
				throw error;
			}
			await originalRename(from, to);
		});

		try {
			const secondResult = await executeWriteFinalCouncilEvidence(
				{
					phase: 2,
					projectSummary: 'Replacement should restore via copy fallback',
					verdicts: allApprovedVerdicts(),
				},
				tempDir,
			);
			const parsed = JSON.parse(secondResult);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('replacement denied');
			expect(await fs.promises.readFile(finalPath, 'utf-8')).toBe(
				originalContent,
			);

			const leftovers = (
				await fs.promises.readdir(path.dirname(finalPath))
			).filter((name) => name.endsWith('.tmp') || name.endsWith('.bak'));
			expect(leftovers).toEqual([]);
		} finally {
			renameSpy.mockRestore();
		}
	});

	test('removes backup when both restore rename and copy fallback fail', async () => {
		const finalPath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'final-council.json',
		);
		const firstResult = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Original final council evidence',
				verdicts: allApprovedVerdicts(),
			},
			tempDir,
		);
		expect(JSON.parse(firstResult).success).toBe(true);

		const originalRename = fs.promises.rename;
		const renameSpy = spyOn(fs.promises, 'rename');
		let tempToFinalAttempts = 0;
		renameSpy.mockImplementation(async (from, to) => {
			const fromPath = from.toString();
			const toPath = to.toString();
			if (fromPath.endsWith('.tmp') && toPath === finalPath) {
				tempToFinalAttempts++;
				const error = new Error(
					tempToFinalAttempts === 1
						? 'destination already exists'
						: 'replacement denied',
				) as NodeJS.ErrnoException;
				error.code = tempToFinalAttempts === 1 ? 'EEXIST' : 'EACCES';
				throw error;
			}
			if (fromPath.endsWith('.bak') && toPath === finalPath) {
				const error = new Error('restore denied') as NodeJS.ErrnoException;
				error.code = 'EACCES';
				throw error;
			}
			await originalRename(from, to);
		});

		const copyFileSpy = spyOn(fs.promises, 'copyFile');
		copyFileSpy.mockImplementation(async () => {
			const error = new Error('copy fallback denied') as NodeJS.ErrnoException;
			error.code = 'EACCES';
			throw error;
		});

		try {
			const secondResult = await executeWriteFinalCouncilEvidence(
				{
					phase: 2,
					projectSummary: 'Replacement should clean failed backup',
					verdicts: allApprovedVerdicts(),
				},
				tempDir,
			);
			const parsed = JSON.parse(secondResult);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toContain('replacement denied');
			const leftovers = (
				await fs.promises.readdir(path.dirname(finalPath))
			).filter((name) => name.endsWith('.tmp') || name.endsWith('.bak'));
			expect(leftovers).toEqual([]);
		} finally {
			renameSpy.mockRestore();
			copyFileSpy.mockRestore();
		}
	});

	test('reports success when backup cleanup fails after replacement', async () => {
		const finalPath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'final-council.json',
		);
		const firstResult = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Original final council evidence',
				verdicts: allApprovedVerdicts(),
			},
			tempDir,
		);
		expect(JSON.parse(firstResult).success).toBe(true);

		const originalRename = fs.promises.rename;
		const renameSpy = spyOn(fs.promises, 'rename');
		let tempToFinalAttempts = 0;
		renameSpy.mockImplementation(async (from, to) => {
			const fromPath = from.toString();
			const toPath = to.toString();
			if (fromPath.endsWith('.tmp') && toPath === finalPath) {
				tempToFinalAttempts++;
				if (tempToFinalAttempts === 1) {
					const error = new Error(
						'destination already exists',
					) as NodeJS.ErrnoException;
					error.code = 'EEXIST';
					throw error;
				}
			}
			await originalRename(from, to);
		});

		const originalRm = fs.promises.rm;
		const rmSpy = spyOn(fs.promises, 'rm');
		rmSpy.mockImplementation(async (target, options) => {
			if (target.toString().endsWith('.bak')) {
				const error = new Error(
					'backup cleanup denied',
				) as NodeJS.ErrnoException;
				error.code = 'EACCES';
				throw error;
			}
			await originalRm(target, options);
		});

		try {
			const secondResult = await executeWriteFinalCouncilEvidence(
				{
					phase: 2,
					projectSummary: 'Replacement should succeed despite cleanup issue',
					verdicts: allApprovedVerdicts(),
				},
				tempDir,
			);
			const parsed = JSON.parse(secondResult);

			expect(parsed.success).toBe(true);
			const entry = JSON.parse(await fs.promises.readFile(finalPath, 'utf-8'))
				.entries[0];
			expect(entry.phase).toBe(2);
		} finally {
			renameSpy.mockRestore();
			rmSpy.mockRestore();
		}
	});
});
