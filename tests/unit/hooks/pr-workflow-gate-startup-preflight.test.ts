import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as checkoutInternals,
	executePreparePrWorkflowCheckout,
} from '../../../src/tools/prepare-pr-workflow-checkout.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';

const GIT_TIMEOUT_MS = 30_000;
let directory = '';
const originalClassifyGitState = checkoutInternals.classifyGitState;

async function runGit(
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: GIT_TIMEOUT_MS,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			proc.stdout.text(),
			proc.stderr.text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		try {
			proc.kill();
		} catch {
			// Best-effort cleanup.
		}
	}
}

async function expectGitSuccess(args: string[]): Promise<string> {
	const result = await runGit(args);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return result.stdout;
}

async function initializeRepository(): Promise<void> {
	await expectGitSuccess(['init', '-b', 'main']);
	await expectGitSuccess(['config', 'user.email', 'test@example.com']);
	await expectGitSuccess(['config', 'user.name', 'Gate Test']);
	await fs.writeFile(path.join(directory, 'tracked.txt'), 'base\n', 'utf-8');
	await expectGitSuccess(['add', 'tracked.txt']);
	await expectGitSuccess(['commit', '-m', 'initial']);
}

async function createMergeConflict(): Promise<void> {
	await initializeRepository();
	await expectGitSuccess(['checkout', '-b', 'feature']);
	await fs.writeFile(path.join(directory, 'tracked.txt'), 'feature\n', 'utf-8');
	await expectGitSuccess(['commit', '-am', 'feature']);
	await expectGitSuccess(['checkout', 'main']);
	await fs.writeFile(path.join(directory, 'tracked.txt'), 'main\n', 'utf-8');
	await expectGitSuccess(['commit', '-am', 'main']);
	const merge = await runGit(['merge', 'feature']);
	expect(merge.exitCode).not.toBe(0);
}

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-startup-preflight-')),
	);
	_test_exports.resetTrackedStateCache();
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	checkoutInternals.classifyGitState = originalClassifyGitState;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('activatePrWorkflow checkout preflight', () => {
	test('does not persist a gate when Git inspection is indeterminate', async () => {
		await expect(
			activatePrWorkflow(directory, 'indeterminate-session', 'PR_REVIEW', {
				requireCheckoutPreflight: true,
			}),
		).rejects.toThrow(/requires manual Git recovery before activation/i);
		expect(
			await readPrWorkflowGateState(directory, 'indeterminate-session'),
		).toBeNull();
	});

	test('does not persist a gate when the index is unmerged', async () => {
		await createMergeConflict();

		await expect(
			activatePrWorkflow(directory, 'conflicted-session', 'PR_REVIEW', {
				requireCheckoutPreflight: true,
			}),
		).rejects.toThrow(/code=UNMERGED_INDEX/);
		expect(
			await readPrWorkflowGateState(directory, 'conflicted-session'),
		).toBeNull();
	});

	test('activates successfully when the checkout is only stashable dirt', async () => {
		await initializeRepository();
		await fs.writeFile(path.join(directory, 'tracked.txt'), 'dirty\n', 'utf-8');

		const state = await activatePrWorkflow(
			directory,
			'stashable-session',
			'PR_REVIEW',
			{ requireCheckoutPreflight: true },
		);
		expect(state.mode).toBe('PR_REVIEW');
		expect(state.checkoutRecovery).toBeUndefined();
		expect(
			await readPrWorkflowGateState(directory, 'stashable-session'),
		).toMatchObject({
			mode: 'PR_REVIEW',
		});
	});

	test('persists checkout recovery once and blocks non-recovery tools on retry', async () => {
		await initializeRepository();
		await activatePrWorkflow(directory, 'recovery-session', 'PR_REVIEW');
		let classifyCalls = 0;
		checkoutInternals.classifyGitState = async () => {
			classifyCalls++;
			return {
				kind: 'recovery-required',
				code: 'GIT_OPERATION_IN_PROGRESS',
				retryable: false,
				requiredAction: 'Complete or abort the active Git operation manually.',
				evidence: {
					worktreeRoot: directory,
					gitDir: path.join(directory, '.git'),
					operations: ['merge'],
					unmergedCodes: [],
					paths: ['tracked.txt'],
					trackedCount: 1,
					untrackedCount: 0,
					pathsTruncated: false,
				},
			};
		};

		const first = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: 'recovery-session',
			}),
		);
		expect(first).toMatchObject({
			success: false,
			code: 'GIT_OPERATION_IN_PROGRESS',
		});
		expect(classifyCalls).toBe(1);

		checkoutInternals.classifyGitState = async () => {
			throw new Error('classification must not rerun after durable recovery');
		};
		const second = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: 'recovery-session',
			}),
		);
		expect(second).toEqual(first);
		await expect(
			enforcePrWorkflowToolBefore(directory, 'recovery-session', 'shell', {
				command: 'git status --porcelain',
			}),
		).resolves.toBeUndefined();
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				'recovery-session',
				'dispatch_lanes_async',
				{ mode: 'swarm-pr-review:base' },
			),
		).rejects.toThrow(/requires manual Git recovery/i);
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				'recovery-session',
				'test_runner',
				{
					files: ['tests/unit/example.test.ts'],
				},
			),
		).rejects.toThrow(/requires manual Git recovery/i);
	});
});
