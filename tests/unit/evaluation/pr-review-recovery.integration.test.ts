import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	computeCandidateInputContentHash,
	sha256,
} from '../../../src/evaluation/hashing.js';
import type { EvaluationModelDispatcher } from '../../../src/evaluation/model-dispatcher.js';
import {
	evaluatePrReviewRecoveryV1,
	PR_REVIEW_RECOVERY_BASE_SHA,
} from '../../../src/evaluation/pr-review-recovery.js';
import { evaluationV1 } from '../../../src/evaluation/public-api.js';
import { runExternalTool } from '../../../src/utils/external-tool-runner.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const packageRoot = path.resolve(import.meta.dir, '../../..');
const fixtureRoot = path.join(
	packageRoot,
	'evaluation-fixtures',
	'pr-review-recovery',
);

async function git(root: string, args: string[]): Promise<string> {
	const result = await runExternalTool({
		executable: 'git',
		args: ['-C', root, ...args],
		cwd: root,
		timeoutMs: 30_000,
		maxStdoutBytes: 256 * 1024,
		maxStderrBytes: 64 * 1024,
		stdin: 'ignore',
	});
	if (result.status !== 'completed' || result.exitCode !== 0) {
		throw new Error(result.stderr || result.message || 'git failed');
	}
	return result.stdout;
}

async function createGitProject(): Promise<string> {
	const root = canonicalMkdtemp('pr-review-recovery-eval-');
	await git(root, ['init']);
	await git(root, ['config', 'user.email', 'evaluation@example.invalid']);
	await git(root, ['config', 'user.name', 'Evaluation Test']);
	fs.writeFileSync(path.join(root, 'tracked.txt'), 'clean\n');
	await git(root, ['add', 'tracked.txt']);
	await git(root, ['commit', '-m', 'base']);
	return root;
}

function passingResponse(): string {
	return fs.readFileSync(
		path.join(fixtureRoot, 'scorer-fixtures', 'passing', 'model-output.json'),
		'utf8',
	);
}

describe('PR-review recovery evaluation', () => {
	test('pins baseline bytes and manifest to the same source SHA', async () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.join(fixtureRoot, 'baseline-manifest.json'), 'utf8'),
		) as { sourceSha: string; sha256: string; payloadPath: string };
		const baseline = fs.readFileSync(
			path.join(packageRoot, manifest.payloadPath),
		);
		const source = await git(packageRoot, [
			'show',
			`${PR_REVIEW_RECOVERY_BASE_SHA}:.opencode/skills/swarm-pr-review/SKILL.md`,
		]);
		expect(manifest.sourceSha).toBe(PR_REVIEW_RECOVERY_BASE_SHA);
		expect(baseline.equals(Buffer.from(source))).toBe(true);
		expect(sha256(baseline)).toBe(manifest.sha256);
	});

	test('does not disclose the passing scorer response in the task instruction', () => {
		const instruction = fs.readFileSync(
			path.join(fixtureRoot, 'instruction.md'),
			'utf8',
		);
		const passing = JSON.parse(passingResponse()).text as string;
		expect(instruction).not.toContain(passing);
	});

	test('rejects a caller-supplied baseline SHA mismatch before dispatch', async () => {
		let dispatched = false;
		const dispatcher: EvaluationModelDispatcher = async () => {
			dispatched = true;
			throw new Error('should not dispatch');
		};
		await expect(
			evaluatePrReviewRecoveryV1({
				projectRoot: packageRoot,
				packageRoot,
				dispatcher,
				baselineSourceSha: '0'.repeat(40),
			}),
		).rejects.toThrow('baseline source SHA');
		expect(dispatched).toBe(false);
	});

	test('rejects baseline bytes that do not match the pinned manifest hash', async () => {
		const inputRoot = canonicalMkdtemp('pr-review-recovery-input-');
		try {
			const target = path.join(
				inputRoot,
				'evaluation-fixtures',
				'pr-review-recovery',
			);
			fs.mkdirSync(path.join(target, 'baseline'), { recursive: true });
			fs.copyFileSync(
				path.join(fixtureRoot, 'baseline-manifest.json'),
				path.join(target, 'baseline-manifest.json'),
			);
			fs.writeFileSync(path.join(target, 'baseline', 'SKILL.md'), 'corrupt\n');
			await expect(
				evaluatePrReviewRecoveryV1({
					projectRoot: packageRoot,
					packageRoot: inputRoot,
					dispatcher: async () => {
						throw new Error('should not dispatch');
					},
				}),
			).rejects.toThrow('baseline payload hash');
		} finally {
			fs.rmSync(inputRoot, { recursive: true, force: true });
		}
	});

	test('rejects a baseline manifest pinned to a different source SHA', async () => {
		const inputRoot = canonicalMkdtemp('pr-review-recovery-sha-');
		try {
			const target = path.join(
				inputRoot,
				'evaluation-fixtures',
				'pr-review-recovery',
			);
			fs.mkdirSync(path.join(target, 'baseline'), { recursive: true });
			const manifest = JSON.parse(
				fs.readFileSync(
					path.join(fixtureRoot, 'baseline-manifest.json'),
					'utf8',
				),
			) as Record<string, unknown>;
			fs.writeFileSync(
				path.join(target, 'baseline-manifest.json'),
				JSON.stringify({ ...manifest, sourceSha: '0'.repeat(40) }),
			);
			fs.copyFileSync(
				path.join(fixtureRoot, 'baseline', 'SKILL.md'),
				path.join(target, 'baseline', 'SKILL.md'),
			);
			await expect(
				evaluatePrReviewRecoveryV1({
					projectRoot: packageRoot,
					packageRoot: inputRoot,
					dispatcher: async () => {
						throw new Error('should not dispatch');
					},
				}),
			).rejects.toThrow('baseline source SHA');
		} finally {
			fs.rmSync(inputRoot, { recursive: true, force: true });
		}
	});

	test('is wired through the callable public namespace and real runner', async () => {
		expect(evaluationV1.evaluatePrReviewRecovery).toBe(
			evaluatePrReviewRecoveryV1,
		);
		const projectRoot = await createGitProject();
		const payloads: string[] = [];
		try {
			const dispatcher: EvaluationModelDispatcher = async (request) => {
				payloads.push(request.system ?? '');
				return {
					status: 'completed',
					modelId: request.modelId,
					agentName: request.agentName,
					text: JSON.parse(passingResponse()).text,
					durationMs: 1,
				};
			};
			const run = await evaluatePrReviewRecoveryV1({
				projectRoot,
				packageRoot,
				dispatcher,
				seed: 'integration',
			});
			expect(run.status).toBe('complete');
			expect(run.results).toHaveLength(2);
			expect(run.results.every((result) => result.score === 1)).toBe(true);
			expect(run.candidate.payloadPath).toBe(
				'.opencode/skills/swarm-pr-review/SKILL.md',
			);
			expect(
				await computeCandidateInputContentHash(packageRoot, run.candidate),
			).toBe(run.candidate.contentHash);
			expect(payloads).toHaveLength(2);
			expect(payloads).toContain(
				fs.readFileSync(
					path.join(packageRoot, '.opencode/skills/swarm-pr-review/SKILL.md'),
					'utf8',
				),
			);
			expect(payloads).toContain(
				fs.readFileSync(path.join(fixtureRoot, 'baseline', 'SKILL.md'), 'utf8'),
			);
		} finally {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});
