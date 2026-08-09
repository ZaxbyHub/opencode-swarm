import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { withEvidenceLock } from '../../../src/evidence/lock.js';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

function writePlanFixture(dir: string): void {
	mkdirSync(join(dir, '.swarm'), { recursive: true });
	writeFileSync(
		join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Issue 2022 Final Council Plan',
			swarm: 'test-swarm',
			current_phase: 3,
			phases: [
				{
					id: 3,
					name: 'Phase 3',
					status: 'completed',
					tasks: [
						{
							id: '3.1',
							phase: 3,
							status: 'completed',
							description: 'Final council regression fixture',
						},
					],
				},
			],
		}),
	);
}

function makeVerdict(
	agent: 'critic' | 'reviewer' | 'sme' | 'test_engineer' | 'explorer',
	verdict: 'APPROVE' | 'CONCERNS' | 'REJECT' = 'APPROVE',
) {
	return {
		agent,
		verdict,
		confidence: 0.9,
		findings:
			verdict === 'CONCERNS'
				? [
						{
							severity: 'HIGH',
							category: 'logic',
							location: 'src/final.ts:10',
							detail: 'Project close is still unsafe.',
							evidence: 'regression fixture',
						},
					]
				: [],
		criteriaAssessed: ['project-scope'],
		criteriaUnmet: [],
		durationMs: 25,
	};
}

function allMembers(
	concernMember?: 'critic' | 'reviewer' | 'sme' | 'test_engineer' | 'explorer',
) {
	const members = [
		'critic',
		'reviewer',
		'sme',
		'test_engineer',
		'explorer',
	] as const;
	return members.map((member) =>
		makeVerdict(member, member === concernMember ? 'CONCERNS' : 'APPROVE'),
	);
}

function collectAttemptJsonlFiles(dir: string): string[] {
	const root = join(dir, '.swarm', 'council', 'attempts');
	if (!existsSync(root)) {
		return [];
	}

	const files: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
				continue;
			}
			if (entry.isFile() && fullPath.endsWith('.jsonl')) {
				files.push(fullPath);
			}
		}
	}

	return files.sort();
}

function finalizedDispositions(dir: string): string[] {
	return collectAttemptJsonlFiles(dir).flatMap((file) =>
		readFileSync(file, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { event: string; disposition: string })
			.filter((record) => record.event === 'finalized')
			.map((record) => record.disposition),
	);
}

async function waitForPendingStates(
	dir: string,
	expected: number,
): Promise<void> {
	const stateDir = join(dir, '.swarm', 'council', 'round-state');
	for (let attempt = 0; attempt < 200; attempt++) {
		if (existsSync(stateDir)) {
			const pending = readdirSync(stateDir).filter((file) =>
				readFileSync(join(stateDir, file), 'utf8').includes('"pending"'),
			).length;
			if (pending >= expected) return;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${expected} pending final states`);
}

describe('write_final_council_evidence — issue #2022 final parity', () => {
	test('records the missing-plan early return without advancing the round', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-attempt-final-no-plan-'),
		);
		try {
			const { executeWriteFinalCouncilEvidence } = await import(
				'../../../src/tools/write-final-council-evidence'
			);
			const missing = JSON.parse(
				await executeWriteFinalCouncilEvidence(
					{
						phase: 1,
						projectSummary: 'No plan is present.',
						verdicts: allMembers(),
					},
					tempDir,
				),
			);
			expect(missing.reason).toBe('plan_not_found');
			expect(missing.authoritativeRound).toBe(1);
			expect(missing.nextRound).toBe(1);
			const audit = collectAttemptJsonlFiles(tempDir)
				.map((file) => readFileSync(file, 'utf8'))
				.join('\n');
			expect(audit).toContain('plan_not_found');
			expect(finalizedDispositions(tempDir)).toContain('plan_not_found');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('blocking final submissions are durably audited before the early return', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-attempt-final-'),
		);
		try {
			writePlanFixture(tempDir);
			const { executeWriteFinalCouncilEvidence } = await import(
				'../../../src/tools/write-final-council-evidence'
			);

			const blocked = JSON.parse(
				await executeWriteFinalCouncilEvidence(
					{
						phase: 3,
						projectSummary: 'Project summary.',
						roundNumber: 1,
						verdicts: allMembers('critic'),
					},
					tempDir,
				),
			);

			expect(blocked.success).toBe(false);
			expect(blocked.reason).toBe('blocking_concerns_unresolved');

			const attemptFiles = collectAttemptJsonlFiles(tempDir);
			expect(attemptFiles.length).toBeGreaterThan(0);
			expect(
				readFileSync(attemptFiles[0], 'utf8').trim().length,
			).toBeGreaterThan(0);
			expect(finalizedDispositions(tempDir)).toContain(
				'blocking_concerns_unresolved',
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('finalizes invalid evidence-path failures through the actual entry point', async () => {
		const tempDir = mkdtempSync(join(canonicalTmpDir(), 'council-final-path-'));
		try {
			writePlanFixture(tempDir);
			const finalTool = await import(
				'../../../src/tools/write-final-council-evidence'
			);
			const original = finalTool._internals.validateSwarmPath;
			finalTool._internals.validateSwarmPath = () => {
				throw new Error('synthetic containment failure');
			};
			try {
				const result = JSON.parse(
					await finalTool.executeWriteFinalCouncilEvidence(
						{
							phase: 3,
							projectSummary: 'Path failure.',
							verdicts: allMembers(),
						},
						tempDir,
					),
				);
				expect(result.success).toBe(false);
				expect(finalizedDispositions(tempDir)).toContain(
					'invalid_evidence_path',
				);
			} finally {
				finalTool._internals.validateSwarmPath = original;
			}
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('final submissions reject a stale client round after a prior blocked round advanced server state', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-final-round-mismatch-'),
		);
		try {
			writePlanFixture(tempDir);
			const { executeWriteFinalCouncilEvidence } = await import(
				'../../../src/tools/write-final-council-evidence'
			);

			await executeWriteFinalCouncilEvidence(
				{
					phase: 3,
					projectSummary: 'Project summary.',
					roundNumber: 1,
					verdicts: allMembers('critic'),
				},
				tempDir,
			);

			const mismatch = JSON.parse(
				await executeWriteFinalCouncilEvidence(
					{
						phase: 3,
						projectSummary: 'Project summary.',
						roundNumber: 1,
						verdicts: allMembers(),
					},
					tempDir,
				),
			);

			expect(mismatch.success).toBe(false);
			expect(mismatch.reason).toBe('council_round_mismatch');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('requires and permits a fresh final review after the plan generation changes', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-final-plan-drift-'),
		);
		try {
			writePlanFixture(tempDir);
			const { executeWriteFinalCouncilEvidence } = await import(
				'../../../src/tools/write-final-council-evidence'
			);
			const first = JSON.parse(
				await executeWriteFinalCouncilEvidence(
					{
						phase: 3,
						projectSummary: 'Initial completed project.',
						verdicts: allMembers(),
					},
					tempDir,
				),
			);
			expect(first.success).toBe(true);

			const planPath = join(tempDir, '.swarm', 'plan.json');
			const plan = JSON.parse(readFileSync(planPath, 'utf8'));
			plan.title = 'Issue 2022 Final Council Plan — revised';
			writeFileSync(planPath, JSON.stringify(plan), 'utf8');

			const reviewedAgain = JSON.parse(
				await executeWriteFinalCouncilEvidence(
					{
						phase: 3,
						projectSummary: 'Revised completed project.',
						verdicts: allMembers(),
					},
					tempDir,
				),
			);
			expect(reviewedAgain.success).toBe(true);
			expect(reviewedAgain.authoritativeRound).toBe(1);
			expect(collectAttemptJsonlFiles(tempDir)).toHaveLength(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('prevents an older concurrent plan generation from overwriting newer evidence', async () => {
		const tempDir = mkdtempSync(join(canonicalTmpDir(), 'council-final-race-'));
		let releasePublication!: () => void;
		let publicationLocked!: () => void;
		const release = new Promise<void>((resolve) => {
			releasePublication = resolve;
		});
		const locked = new Promise<void>((resolve) => {
			publicationLocked = resolve;
		});
		try {
			writePlanFixture(tempDir);
			const blocker = withEvidenceLock(
				tempDir,
				join('evidence', 'final-council.json'),
				'test',
				'publication-race',
				async () => {
					publicationLocked();
					await release;
				},
			);
			await locked;
			const { executeWriteFinalCouncilEvidence } = await import(
				'../../../src/tools/write-final-council-evidence'
			);
			const older = executeWriteFinalCouncilEvidence(
				{
					phase: 3,
					projectSummary: 'Older generation.',
					verdicts: allMembers(),
				},
				tempDir,
			);
			await waitForPendingStates(tempDir, 1);
			const planPath = join(tempDir, '.swarm', 'plan.json');
			const plan = JSON.parse(readFileSync(planPath, 'utf8'));
			plan.title = 'Issue 2022 Final Council Plan — concurrent revision';
			writeFileSync(planPath, JSON.stringify(plan), 'utf8');
			const newer = executeWriteFinalCouncilEvidence(
				{
					phase: 3,
					projectSummary: 'Newer generation.',
					verdicts: allMembers(),
				},
				tempDir,
			);
			await waitForPendingStates(tempDir, 2);
			releasePublication();
			const [olderResult, newerResult] = await Promise.all([older, newer]);
			await blocker;
			expect(JSON.parse(olderResult).reason).toBe(
				'council_round_state_persistence_failed',
			);
			expect(JSON.parse(newerResult).success).toBe(true);
			const evidence = JSON.parse(
				readFileSync(
					join(tempDir, '.swarm', 'evidence', 'final-council.json'),
					'utf8',
				),
			);
			expect(evidence.entries[0].projectSummary).toBe('Newer generation.');
		} finally {
			releasePublication?.();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
