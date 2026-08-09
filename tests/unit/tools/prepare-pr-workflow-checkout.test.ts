import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordPendingDelegation } from '../../../src/background/pending-delegations.js';
import { AGENT_TOOL_MAP } from '../../../src/config/constants.js';
import {
	abortPrWorkflow,
	activatePrWorkflow,
	bindPrWorkflowHead,
	enforcePrWorkflowToolBefore,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import {
	_internals as checkoutInternals,
	executePreparePrWorkflowCheckout,
	prepare_pr_workflow_checkout,
} from '../../../src/tools/prepare-pr-workflow-checkout.js';
import { TOOL_NAMES } from '../../../src/tools/tool-names.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';

const SESSION_ID = 'checkout-controller';
const GIT_TIMEOUT_MS = 30_000;
let directory = '';
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalRename = gateInternals.rename;
const originalRunGit = checkoutInternals.runGit;

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
			// Best-effort cleanup; Git may already have exited.
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
	await expectGitSuccess(['config', 'user.name', 'Checkout Test']);
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		'.swarm/\n',
	);
	await fs.mkdir(path.join(directory, '.opencode'), { recursive: true });
	await fs.writeFile(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		'{"enabled":true}\n',
		'utf-8',
	);
	await fs.writeFile(path.join(directory, 'unrelated.txt'), 'base\n', 'utf-8');
	await expectGitSuccess(['add', '.']);
	await expectGitSuccess(['commit', '-m', 'initial']);
}

beforeEach(async () => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-workflow-checkout-')),
	);
	await initializeRepository();
});

afterEach(async () => {
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.rename = originalRename;
	checkoutInternals.runGit = originalRunGit;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('prepare_pr_workflow_checkout', () => {
	test('is registered as an architect-only PR workflow controller', async () => {
		expect(TOOL_NAMES).toContain('prepare_pr_workflow_checkout');
		expect(TOOL_MANIFEST.prepare_pr_workflow_checkout).toBeDefined();
		expect(AGENT_TOOL_MAP.architect).toContain('prepare_pr_workflow_checkout');
		expect(AGENT_TOOL_MAP.explorer).not.toContain(
			'prepare_pr_workflow_checkout',
		);
		expect(prepare_pr_workflow_checkout.args.paths).toBeDefined();

		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				SESSION_ID,
				'prepare_pr_workflow_checkout',
				{ paths: ['.opencode/opencode-swarm.json'] },
			),
		).resolves.toBeUndefined();
	});

	test('PRR-BOOTSTRAP-001 regression: preserves the reported dirty config path without admitting generic git stash', async () => {
		// Previous behavior rejected the canonical skill's exact dirty-tree
		// preservation command as a generic read-only shell mutation, leaving the
		// architect unable to reach the required PR-head checkout.
		await fs.writeFile(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			'{"enabled":false}\n',
			'utf-8',
		);
		await expectGitSuccess(['add', '--', '.opencode/opencode-swarm.json']);
		await fs.writeFile(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			'{"enabled":"working-tree"}\n',
			'utf-8',
		);
		const activation = await activatePrWorkflow(
			directory,
			SESSION_ID,
			'PR_REVIEW',
		);
		let renameAttempts = 0;
		gateInternals.rename = async (...args) => {
			renameAttempts++;
			if (renameAttempts < 3) {
				throw Object.assign(new Error('busy receipt directory'), {
					code: 'EPERM',
				});
			}
			return originalRename(...args);
		};
		const result = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: ['.opencode/opencode-swarm.json'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result).toMatchObject({
			success: true,
			paths: ['.opencode/opencode-swarm.json'],
		});
		expect(renameAttempts).toBe(3);
		expect(result.stash_oid).toMatch(/^[0-9a-f]{40,64}$/i);
		expect(result.recovery).toContain(
			`git stash apply --index ${result.stash_oid}`,
		);
		expect(
			(
				await expectGitSuccess([
					'status',
					'--porcelain',
					'--',
					'.opencode/opencode-swarm.json',
				])
			).trim(),
		).toBe('');
		const stashedPaths = (
			await expectGitSuccess([
				'stash',
				'show',
				'--name-only',
				'--format=',
				'-z',
				result.stash_oid,
			])
		).split('\0');
		expect(stashedPaths).toContain('.opencode/opencode-swarm.json');
		const receiptRoot = path.join(directory, '.swarm', 'pr-workflow-checkouts');
		const [sessionReceiptDirectory] = await fs.readdir(receiptRoot);
		const [receiptName] = await fs.readdir(
			path.join(receiptRoot, sessionReceiptDirectory),
		);
		expect(
			JSON.parse(
				await fs.readFile(
					path.join(receiptRoot, sessionReceiptDirectory, receiptName),
					'utf-8',
				),
			),
		).toMatchObject({
			stashOid: result.stash_oid,
			paths: ['.opencode/opencode-swarm.json'],
			mode: 'PR_REVIEW',
			gateActivatedAt: activation.activatedAt,
		});
		expect(
			await fs.readFile(
				path.join(directory, '.swarm', 'events.jsonl'),
				'utf-8',
			),
		).toContain('pr_workflow_checkout_prepared');
		await expect(
			enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
				command:
					'git stash push -m "pr-review-stash" -- .opencode/opencode-swarm.json',
			}),
		).rejects.toThrow(/read-only and fail-closed/i);
		const head = (await expectGitSuccess(['rev-parse', 'HEAD'])).trim();
		// The temporary repo does not run plugin init, so its generated .swarm
		// receipt is not in .git/info/exclude. This seam covers only the real-git
		// bind assertion below; dirty-checkout behavior is covered by hook tests.
		gateInternals.resolveIsWorkingTreeClean = () => true;
		await bindPrWorkflowHead(directory, SESSION_ID, head);
		const postBind = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: ['.opencode/opencode-swarm.json'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(postBind.success).toBe(false);
		expect(postBind.message).toContain('only before the PR head is bound');
		await expectGitSuccess(['stash', 'apply', '--index', result.stash_oid]);
		expect(
			(
				await runGit([
					'diff',
					'--cached',
					'--quiet',
					'--',
					'.opencode/opencode-swarm.json',
				])
			).exitCode,
		).toBe(1);
		expect(
			(await runGit(['diff', '--quiet', '--', '.opencode/opencode-swarm.json']))
				.exitCode,
		).toBe(1);
	});

	test('refuses a partial dirty-path request so success always leaves a bindable checkout', async () => {
		await fs.writeFile(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			'{"enabled":false}\n',
			'utf-8',
		);
		await fs.writeFile(
			path.join(directory, 'unrelated.txt'),
			'changed\n',
			'utf-8',
		);
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		const result = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: ['.opencode/opencode-swarm.json'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('exactly cover every dirty tracked path');
		expect(
			await expectGitSuccess(['status', '--porcelain', '--', 'unrelated.txt']),
		).toContain('unrelated.txt');
		expect(await expectGitSuccess(['stash', 'list'])).toBe('');
	});

	test('refuses untracked files before creating any stash', async () => {
		await fs.writeFile(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			'{"enabled":false}\n',
			'utf-8',
		);
		await fs.writeFile(path.join(directory, 'untracked.txt'), 'new\n', 'utf-8');
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		const result = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: ['.opencode/opencode-swarm.json'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('refuses untracked paths');
		expect(await expectGitSuccess(['stash', 'list'])).toBe('');
	});

	test('serializes concurrent preparations so only the first authorized request can create a stash', async () => {
		await fs.writeFile(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			'{"enabled":false}\n',
			'utf-8',
		);
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		let signalStashStart!: () => void;
		const stashStarted = new Promise<void>((resolve) => {
			signalStashStart = resolve;
		});
		let releaseStash!: () => void;
		const stashRelease = new Promise<void>((resolve) => {
			releaseStash = resolve;
		});
		checkoutInternals.runGit = async (gitDirectory, args, options) => {
			if (args[0] === 'stash' && args[1] === 'push') {
				signalStashStart();
				await stashRelease;
			}
			return originalRunGit(gitDirectory, args, options);
		};

		const first = executePreparePrWorkflowCheckout(
			{ paths: ['.opencode/opencode-swarm.json'] },
			directory,
			{ sessionID: SESSION_ID },
		);
		await stashStarted;
		const abort = abortPrWorkflow(directory, SESSION_ID);
		const second = executePreparePrWorkflowCheckout(
			{ paths: ['.opencode/opencode-swarm.json'] },
			directory,
			{ sessionID: SESSION_ID },
		);
		releaseStash();

		expect(JSON.parse(await first).success).toBe(true);
		expect(await abort).toMatchObject({ mode: 'PR_REVIEW', openLanes: 0 });
		const secondResult = JSON.parse(await second);
		expect(secondResult.success).toBe(false);
		expect(secondResult.message).toContain('no active PR workflow gate');
		expect(
			(await expectGitSuccess(['stash', 'list'])).trim().split('\n').length,
		).toBe(1);
	});

	test('records its marked stash rather than a later concurrent stash', async () => {
		await fs.writeFile(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			'{"enabled":false}\n',
			'utf-8',
		);
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		checkoutInternals.runGit = async (gitDirectory, args, options) => {
			const result = await originalRunGit(gitDirectory, args, options);
			if (args[0] === 'stash' && args[1] === 'push') {
				await fs.writeFile(path.join(directory, 'unrelated.txt'), 'later\n');
				await originalRunGit(
					gitDirectory,
					['stash', 'push', '--message=interloper', '--', 'unrelated.txt'],
					options,
				);
			}
			return result;
		};

		const result = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: ['.opencode/opencode-swarm.json'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result.success).toBe(true);
		expect(
			await expectGitSuccess([
				'stash',
				'show',
				'--name-only',
				'--format=',
				result.stash_oid,
			]),
		).toContain('.opencode/opencode-swarm.json');
		expect(
			await expectGitSuccess([
				'stash',
				'show',
				'--name-only',
				'--format=',
				'stash@{0}',
			]),
		).toContain('unrelated.txt');
	});

	test('rejects non-literal, untracked, clean, and child-session preparation requests', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
		for (const paths of [
			['../outside.txt'],
			['.git/config'],
			['foo/../bar.txt'],
			['src\\windows.txt'],
			[':(glob)*.ts'],
			['untracked.txt'],
			['unrelated.txt'],
		]) {
			const result = JSON.parse(
				await executePreparePrWorkflowCheckout({ paths }, directory, {
					sessionID: SESSION_ID,
				}),
			);
			expect(result.success).toBe(false);
		}
		await fs.writeFile(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			'{"enabled":false}\n',
			'utf-8',
		);
		const childResult = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: ['.opencode/opencode-swarm.json'] },
				directory,
				{ sessionID: 'child-session' },
			),
		);
		expect(childResult.success).toBe(false);
		expect(childResult.message).toContain('no active PR workflow gate');
	});

	test('supports the same controlled bootstrap for PR_FEEDBACK and rejects live lanes', async () => {
		await fs.writeFile(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			'{"enabled":false}\n',
			'utf-8',
		);
		await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
		await recordPendingDelegation(directory, {
			correlationId: 'unrelated-non-workflow-lane',
			jobId: null,
			subagentSessionId: 'sub-unrelated',
			parentSessionId: 'other-session',
			callID: 'call-unrelated',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
		});
		const feedbackResult = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: ['.opencode/opencode-swarm.json'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(feedbackResult.success).toBe(true);

		await fs.writeFile(
			path.join(directory, 'unrelated.txt'),
			'changed\n',
			'utf-8',
		);
		await recordPendingDelegation(directory, {
			correlationId: 'checkout-lane',
			jobId: null,
			subagentSessionId: 'sub-1',
			parentSessionId: SESSION_ID,
			callID: 'call-1',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'batch-1',
			laneId: 'lane-1',
			mode: 'swarm-pr-review:base',
			workflowLane: 'intent-architecture',
			workspace: {
				directory,
				gitHead: 'abc123',
				dirtyHash: null,
				prHeadSha: 'abc123',
				scope: null,
			},
		});
		const blocked = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: ['unrelated.txt'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(blocked.success).toBe(false);
		expect(blocked.message).toContain('lane(s) are in flight');
	});
});
