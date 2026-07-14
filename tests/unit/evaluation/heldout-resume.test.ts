import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	EvaluationCandidateV1,
	EvaluationTaskV1,
} from '../../../src/evaluation/contracts.js';
import { TestConsumptionClaimV1Schema } from '../../../src/evaluation/contracts.js';
import {
	computeCandidateInputContentHash,
	computeTaskInputContentHash,
} from '../../../src/evaluation/hashing.js';
import { _internals, runEvaluation } from '../../../src/evaluation/runner.js';

const originalFingerprint = _internals.captureWorkingTreeFingerprint;
const originalDisposableWorktree = _internals.withDisposableWorktree;

afterEach(() => {
	_internals.captureWorkingTreeFingerprint = originalFingerprint;
	_internals.withDisposableWorktree = originalDisposableWorktree;
});

async function candidate(
	root: string,
	id: string,
	kind: 'baseline' | 'skill',
): Promise<EvaluationCandidateV1> {
	const draft = {
		v: 1 as const,
		id,
		kind,
		payloadPath: `${id}.md`,
		model: 'configured',
	};
	return {
		...draft,
		contentHash: await computeCandidateInputContentHash(root, draft),
	};
}

describe('held-out run restart safety', () => {
	test('resumes after a post-claim crash without consuming the test twice', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'eval-heldout-resume-')),
		);
		try {
			fs.mkdirSync(path.join(root, 'fixture'));
			fs.writeFileSync(path.join(root, 'fixture', 'subject.ts'), 'export {}\n');
			const instructionPath = path.join(root, 'instruction.md');
			const originalInstruction = 'Return a verdict.\n';
			fs.writeFileSync(instructionPath, originalInstruction);
			fs.writeFileSync(path.join(root, 'baseline.md'), 'baseline\n');
			fs.writeFileSync(path.join(root, 'candidate.md'), 'candidate\n');
			const draft = {
				v: 1 as const,
				id: 'heldout-task',
				source: 'curated' as const,
				split: 'test' as const,
				category: 'correctness',
				protected: true,
				instructionPath: 'instruction.md',
				environment: { kind: 'fixture' as const, path: 'fixture' },
				scorer: {
					kind: 'builtin' as const,
					argv: ['builtin'],
					timeoutMs: 1_000,
					scoreRange: [0, 1] as [number, number],
				},
				provenance: { origin: 'unit-test', license: 'MIT' },
			};
			const task: EvaluationTaskV1 = {
				...draft,
				contentHash: await computeTaskInputContentHash(root, draft),
			};
			_internals.captureWorkingTreeFingerprint = async () => ({
				head: 'a'.repeat(40),
				porcelainHash: 'b'.repeat(64),
			});
			_internals.withDisposableWorktree = async ({ baseRef, run }) => {
				const isolated = fs.realpathSync(
					fs.mkdtempSync(path.join(os.tmpdir(), 'eval-heldout-worktree-')),
				);
				try {
					return await run({ path: isolated, baseSha: baseRef });
				} finally {
					fs.rmSync(isolated, { recursive: true, force: true });
				}
			};
			let corruptOnce = true;
			const options = {
				projectRoot: root,
				tasks: [task],
				baseline: await candidate(root, 'baseline', 'baseline'),
				candidate: await candidate(root, 'candidate', 'skill'),
				split: 'test' as const,
				seed: 'heldout-resume',
				models: ['configured'],
				budgets: {
					maxTasks: 1,
					maxRepetitions: 1,
					maxConcurrency: 2,
					maxTaskTimeMs: 1_000,
					maxRetries: 0,
					maxOutputBytes: 1_024,
				},
				executor: async () => {
					if (corruptOnce) {
						corruptOnce = false;
						fs.writeFileSync(instructionPath, 'changed after claim\n');
					}
					return {
						status: 'completed' as const,
						text: '{"v":1,"caught":true}',
						durationMs: 1,
						cost: { source: 'reported' as const, usd: 0 },
					};
				},
			};

			await expect(runEvaluation(options)).rejects.toThrow(
				'changed during evaluation',
			);
			const ledgerPath = path.join(
				root,
				'.swarm',
				'evolution',
				'test-consumption.jsonl',
			);
			const firstLedgerText = fs.readFileSync(ledgerPath, 'utf8');
			const firstLedgerLines = firstLedgerText.trim().split(/\r?\n/);
			expect(firstLedgerLines).toHaveLength(1);
			const firstClaim = TestConsumptionClaimV1Schema.parse(
				JSON.parse(firstLedgerLines[0]!),
			);
			fs.writeFileSync(instructionPath, originalInstruction);
			const resumed = await runEvaluation(options);
			expect(resumed.status).toBe('complete');
			const resumedLedgerText = fs.readFileSync(ledgerPath, 'utf8');
			expect(resumedLedgerText).toBe(firstLedgerText);
			expect(firstClaim).toMatchObject({
				v: 1,
				runId: resumed.runId,
				taskSetHash: resumed.taskSet.contentHash,
				baselineHash: resumed.baseline.contentHash,
				candidateHash: resumed.candidate.contentHash,
			});
			expect(Number.isNaN(Date.parse(firstClaim.claimedAt))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
