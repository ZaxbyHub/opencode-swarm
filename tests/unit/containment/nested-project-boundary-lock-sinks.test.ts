import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeCouncilEvidence } from '../../../src/council/council-evidence-writer.js';
import { writeCriteria } from '../../../src/council/criteria-store.js';
import type { CouncilSynthesis } from '../../../src/council/types.js';
import type {
	EvaluationTaskV1,
	TestConsumptionClaimV1,
} from '../../../src/evaluation/contracts.js';
import {
	type GateGroundTruthV1,
	saveGateGroundTruth,
} from '../../../src/evaluation/gate-ground-truth.js';
import { computeTaskInputContentHash } from '../../../src/evaluation/hashing.js';
import {
	admitEvaluationTask,
	claimHeldOutTest,
} from '../../../src/evaluation/store.js';
import { withTaskEvidenceLock } from '../../../src/evidence/task-file.js';
import { withSafeTestDir } from '../../helpers/safe-test-dir.js';

function createOuterProject(base: string): string {
	const outer = path.join(base, 'outer');
	fs.mkdirSync(path.join(outer, '.swarm'), { recursive: true });
	fs.writeFileSync(path.join(outer, 'package.json'), '{}\n');
	return outer;
}

function createNested(
	outer: string,
	name: string,
	boundary?: 'git-file' | 'opencode-dir',
): string {
	const nested = path.join(outer, name);
	fs.mkdirSync(nested, { recursive: true });
	if (boundary === 'git-file') {
		fs.writeFileSync(path.join(nested, '.git'), 'gitdir: ../metadata\n');
	} else if (boundary === 'opencode-dir') {
		fs.mkdirSync(path.join(nested, '.opencode'));
	}
	return nested;
}

function snapshotTree(root: string): string[] {
	const entries: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of fs
			.readdirSync(directory, { withFileTypes: true })
			.sort((left, right) => left.name.localeCompare(right.name))) {
			const absolute = path.join(directory, entry.name);
			const relative = path.relative(root, absolute);
			if (entry.isDirectory()) {
				entries.push(`dir:${relative}`);
				visit(absolute);
			} else {
				entries.push(
					`file:${relative}:${fs.readFileSync(absolute).toString('base64')}`,
				);
			}
		}
	};
	visit(root);
	return entries;
}

async function expectRejectedWithoutMutation(
	directory: string,
	action: () => Promise<unknown>,
): Promise<number> {
	const before = snapshotTree(directory);
	let rejection: unknown;
	try {
		await action();
	} catch (error) {
		rejection = error;
	}
	expect(rejection).toBeInstanceOf(Error);
	expect((rejection as Error).message).toContain('parent directory');
	expect(snapshotTree(directory)).toEqual(before);
	return 1;
}

async function makeTask(root: string): Promise<EvaluationTaskV1> {
	fs.mkdirSync(path.join(root, 'fixtures', 'project'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'fixtures', 'instruction.md'),
		'Complete the task.\n',
	);
	const taskWithoutHash = {
		v: 1 as const,
		id: 'task-1',
		source: 'curated' as const,
		split: 'validation' as const,
		category: 'correctness',
		protected: false,
		instructionPath: path.join('fixtures', 'instruction.md'),
		environment: {
			kind: 'fixture' as const,
			path: path.join('fixtures', 'project'),
		},
		scorer: {
			kind: 'builtin' as const,
			argv: ['score-v1'],
			timeoutMs: 1_000,
			scoreRange: [0, 1] as [number, number],
		},
		provenance: { origin: 'repository', license: 'MIT' },
	};
	return {
		...taskWithoutHash,
		contentHash: await computeTaskInputContentHash(
			root,
			taskWithoutHash as EvaluationTaskV1,
		),
	} as EvaluationTaskV1;
}

function claim(runId: string): TestConsumptionClaimV1 {
	return {
		v: 1,
		runId,
		taskSetHash: '1'.repeat(64),
		baselineHash: '2'.repeat(64),
		candidateHash: '3'.repeat(64),
		claimedAt: '2026-08-12T12:00:00.000Z',
	};
}

function truth(runId: string): GateGroundTruthV1[] {
	return [
		{
			v: 1,
			runId,
			taskId: 'task-1',
			candidateId: 'candidate-1',
			model: 'configured',
			gate: 'quality',
			repetition: 0,
			source: 'test-impact',
			classification: 'clean',
			observedAt: '2026-08-12T12:00:00.000Z',
		},
	];
}

function synthesis(): CouncilSynthesis {
	return {
		taskId: '1.1',
		swarmId: 'swarm-lock-sink-test',
		timestamp: '2026-08-12T12:00:00.000Z',
		overallVerdict: 'APPROVE',
		vetoedBy: null,
		memberVerdicts: [],
		unresolvedConflicts: [],
		requiredFixes: [],
		advisoryFindings: [],
		unifiedFeedbackMd: '',
		roundNumber: 1,
		allCriteriaMet: true,
		quorumSize: 3,
		blockingConcernsCount: 0,
	};
}

describe('nested project boundaries — regression: lock-backed sinks (Stage B)', () => {
	test('rejects every direct ordinary-descendant writer without changing state', async () => {
		await withSafeTestDir(async (base) => {
			const outer = createOuterProject(base);
			let rejected = 0;

			const lockTarget = createNested(outer, 'lock-target');
			let lockCallbackCalls = 0;
			rejected += await expectRejectedWithoutMutation(lockTarget, () =>
				withTaskEvidenceLock(lockTarget, '1.1', 'test', async () => {
					lockCallbackCalls += 1;
				}),
			);
			expect(lockCallbackCalls).toBe(0);

			const admissionTarget = createNested(outer, 'admission-target');
			const task = await makeTask(admissionTarget);
			rejected += await expectRejectedWithoutMutation(admissionTarget, () =>
				admitEvaluationTask(admissionTarget, task),
			);

			const claimTarget = createNested(outer, 'claim-target');
			rejected += await expectRejectedWithoutMutation(claimTarget, () =>
				claimHeldOutTest(claimTarget, claim('claim-rejected')),
			);

			const truthTarget = createNested(outer, 'truth-target');
			rejected += await expectRejectedWithoutMutation(truthTarget, () =>
				saveGateGroundTruth(
					truthTarget,
					'truth-rejected',
					truth('truth-rejected'),
				),
			);

			const councilTarget = createNested(outer, 'council-target');
			rejected += await expectRejectedWithoutMutation(councilTarget, () =>
				writeCouncilEvidence(councilTarget, synthesis()),
			);

			const criteriaTarget = createNested(outer, 'criteria-target');
			rejected += await expectRejectedWithoutMutation(criteriaTarget, () =>
				writeCriteria(criteriaTarget, '1.1', [
					{ id: 'C1', description: 'Contain state', mandatory: true },
				]),
			);

			// Previous code reached every mkdir/lock sink first. A non-zero count of
			// six proves each concrete writer now rejects before any mutation.
			expect(rejected).toBe(6);
		});
	});

	test('allows every writer at direct .git and .opencode nested roots', async () => {
		await withSafeTestDir(async (base) => {
			const outer = createOuterProject(base);
			let completed = 0;
			for (const [name, boundary] of [
				['git-root', 'git-file'],
				['opencode-root', 'opencode-dir'],
			] as const) {
				const root = createNested(outer, name, boundary);
				const runId = `audit-${name}`;
				const admittedTask = await makeTask(root);

				await withTaskEvidenceLock(root, '9.9', 'test', async () => {
					completed += 1;
				});
				expect(await admitEvaluationTask(root, admittedTask)).toEqual(
					admittedTask,
				);
				completed += 1;
				expect(await claimHeldOutTest(root, claim(`claim-${name}`))).toEqual(
					claim(`claim-${name}`),
				);
				completed += 1;
				expect(
					await saveGateGroundTruth(root, runId, truth(runId)),
				).toHaveLength(1);
				completed += 1;
				await writeCouncilEvidence(root, synthesis());
				completed += 1;
				await writeCriteria(root, '1.1', [
					{ id: 'C1', description: 'Contain state', mandatory: true },
				]);
				completed += 1;

				expect(
					fs.existsSync(
						path.join(
							root,
							'.swarm',
							'evolution',
							'tasks',
							'validation',
							'task-1.json',
						),
					),
				).toBe(true);
				expect(
					fs.existsSync(path.join(root, '.swarm', 'evidence', '1.1.json')),
				).toBe(true);
			}

			expect(completed).toBe(12);
		});
	});
});
