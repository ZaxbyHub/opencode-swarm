import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	BackgroundTaskChangeContext,
	BackgroundWorktreeDescriptor,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import {
	awaitingMergeByCallID,
	standardWorktreeByCallID,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	recordWorktreeProvisioningOwner,
	scanWorktreeProvisioningOwnersForRecovery,
} from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import {
	_internals,
	beginCoderSettlement,
	recordCoderMergeProvenance,
	recoverCoderSettlement,
	settleCoderDispatch,
} from '../../../src/workflow/coder-settlement';
import type { MergeOperationProvenance } from '../../../src/worktree/merge';

const TASK_ID = '1.1';

function git(directory: string, args: string[]): string {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 256 * 1024,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

interface Fixture {
	root: string;
	repo: string;
	worktree: string;
	branch: string;
	callID: string;
	transitionId: string;
	descriptor: BackgroundWorktreeDescriptor;
	context: BackgroundTaskChangeContext;
}

function createFixture(
	label: string,
	canonicalDirectoryScope = false,
): Fixture {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `coder-wt-recovery-${label}-`)),
	);
	const repo = path.join(root, 'repo');
	const worktree = path.join(root, 'lane');
	fs.mkdirSync(repo);
	git(repo, ['init']);
	git(repo, ['config', 'user.email', 'tests@example.com']);
	git(repo, ['config', 'user.name', 'Tests']);
	fs.mkdirSync(path.join(repo, 'src', 'nested'), { recursive: true });
	fs.writeFileSync(
		path.join(repo, 'src', 'nested', 'feature.ts'),
		'export const feature = 1;\n',
	);
	git(repo, ['add', '.']);
	git(repo, ['commit', '-m', 'test: seed']);

	const callID = `call-${label}`;
	const transitionId = `coder:${label}`;
	const branch = `swarm-lane/session-${label}/lane-1`;
	git(repo, ['worktree', 'add', '-b', branch, worktree]);
	const context: BackgroundTaskChangeContext = {
		declaredFiles: [
			canonicalDirectoryScope ? path.join(worktree, 'src') : 'src',
		],
		baseline: captureWorkspaceSnapshot(worktree),
		workflowGeneration: 0,
	};
	const descriptor: BackgroundWorktreeDescriptor = {
		callID,
		parentSessionId: `parent-${label}`,
		taskId: TASK_ID,
		planTaskId: TASK_ID,
		worktreePath: worktree,
		branchName: branch,
		worktreeId: 'lane-1',
		worktreeSessionId: `session-${label}`,
		mergeStrategy: 'merge',
		laneIndex: 1,
		worktreeDir: null,
	};
	return {
		root,
		repo,
		worktree,
		branch,
		callID,
		transitionId,
		descriptor,
		context,
	};
}

function commitAndLand(fixture: Fixture): MergeOperationProvenance {
	fs.writeFileSync(
		path.join(fixture.worktree, 'src', 'nested', 'feature.ts'),
		'export const feature = 2;\n',
	);
	git(fixture.worktree, ['add', '.']);
	git(fixture.worktree, ['commit', '-m', 'feat: isolated mutation']);
	const provenance: MergeOperationProvenance = {
		operationId: fixture.transitionId,
		sourceHead: git(fixture.worktree, ['rev-parse', 'HEAD']),
		targetHeadBefore: git(fixture.repo, ['rev-parse', 'HEAD']),
		branchName: fixture.branch,
		strategy: 'merge',
	};
	git(fixture.repo, ['merge', '--no-edit', fixture.branch]);
	return provenance;
}

function recordOwner(fixture: Fixture): void {
	recordWorktreeProvisioningOwner(fixture.repo, {
		callID: fixture.callID,
		parentSessionId: fixture.descriptor.parentSessionId,
		worktreeSessionId: fixture.descriptor.worktreeSessionId,
		taskId: TASK_ID,
	});
}

function walPath(fixture: Fixture): string {
	return path.join(
		fixture.repo,
		'.swarm',
		'coder-settlements',
		`${TASK_ID}.json`,
	);
}

function readWal(fixture: Fixture): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(walPath(fixture), 'utf8')) as Record<
		string,
		unknown
	>;
}

function writePreparedWal(
	fixture: Fixture,
	provenance: MergeOperationProvenance,
): void {
	const wal = readWal(fixture);
	fs.writeFileSync(
		walPath(fixture),
		`${JSON.stringify(
			{
				...wal,
				state: 'PREPARED',
				observedFiles: ['src/nested/feature.ts'],
				mergeProvenance: provenance,
				accepted: true,
				testEngineerExempt: false,
				settlementFailed: false,
			},
			null,
			2,
		)}\n`,
	);
}

function branchExists(fixture: Fixture): boolean {
	const result = spawnSync(
		'git',
		[
			'-C',
			fixture.repo,
			'show-ref',
			'--verify',
			'--quiet',
			`refs/heads/${fixture.branch}`,
		],
		{
			cwd: fixture.repo,
			stdio: ['ignore', 'ignore', 'ignore'],
			timeout: 10_000,
			windowsHide: true,
		},
	);
	if (result.error) throw result.error;
	return result.status === 0;
}

function expectCleanup(fixture: Fixture): void {
	expect(fs.existsSync(fixture.worktree)).toBe(false);
	expect(branchExists(fixture)).toBe(false);
	expect(scanWorktreeProvisioningOwnersForRecovery(fixture.repo)).toEqual({
		status: 'ok',
		owners: [],
	});
	expect(readWal(fixture)).toMatchObject({
		state: 'COMMITTED',
		cleanupComplete: true,
	});
}

describe('issue #2098 coder settlement isolated-worktree recovery', () => {
	const roots: string[] = [];

	beforeEach(() => {
		_internals.liveDispatches.clear();
		standardWorktreeByCallID.clear();
		awaitingMergeByCallID.clear();
	});

	afterEach(() => {
		_internals.liveDispatches.clear();
		standardWorktreeByCallID.clear();
		awaitingMergeByCallID.clear();
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	async function begin(fixture: Fixture): Promise<void> {
		roots.push(fixture.root);
		await beginCoderSettlement({
			directory: fixture.repo,
			taskId: TASK_ID,
			transitionId: fixture.transitionId,
			actor: 'architect',
			expectedGeneration: 0,
			context: fixture.context,
			worktree: fixture.descriptor,
		});
		recordOwner(fixture);
	}

	test('PREPARED landed merge recovers one accepted mutation and completes cleanup', async () => {
		const fixture = createFixture('prepared');
		await begin(fixture);
		const provenance = commitAndLand(fixture);
		writePreparedWal(fixture, provenance);
		_internals.liveDispatches.clear();

		const recovered = await recoverCoderSettlement(fixture.repo, TASK_ID);
		expect(recovered).toMatchObject({ accepted: true, alreadyApplied: false });
		expect(getTaskWorkflowSnapshot(recovered?.evidence ?? null)).toMatchObject({
			state: 'coder_delegated',
			generation: 1,
			lastTransitionId: fixture.transitionId,
		});
		expectCleanup(fixture);

		const evidenceAfter = fs.readFileSync(
			path.join(fixture.repo, '.swarm', 'evidence', `${TASK_ID}.json`),
			'utf8',
		);
		expect(await recoverCoderSettlement(fixture.repo, TASK_ID)).toBeNull();
		expect(
			fs.readFileSync(
				path.join(fixture.repo, '.swarm', 'evidence', `${TASK_ID}.json`),
				'utf8',
			),
		).toBe(evidenceAfter);
	});

	test('COMMITTED-before-cleanup retry removes residue and is idempotent', async () => {
		const fixture = createFixture('committed');
		await begin(fixture);
		commitAndLand(fixture);
		await settleCoderDispatch({
			directory: fixture.repo,
			taskId: TASK_ID,
			transitionId: fixture.transitionId,
			accepted: true,
			testEngineerExempt: false,
		});
		expect(readWal(fixture)).toMatchObject({
			state: 'COMMITTED',
			cleanupComplete: false,
		});

		expect(await recoverCoderSettlement(fixture.repo, TASK_ID)).toBeNull();
		expectCleanup(fixture);
		const walAfter = fs.readFileSync(walPath(fixture), 'utf8');
		expect(await recoverCoderSettlement(fixture.repo, TASK_ID)).toBeNull();
		expect(fs.readFileSync(walPath(fixture), 'utf8')).toBe(walAfter);
	});

	test('canonical directory scope accepts an observed descendant during landed recovery', async () => {
		const fixture = createFixture('canonical-scope', true);
		await begin(fixture);
		const provenance = commitAndLand(fixture);
		await recordCoderMergeProvenance({
			directory: fixture.repo,
			taskId: TASK_ID,
			transitionId: fixture.transitionId,
			provenance,
			observedFiles: [
				path.join(fixture.worktree, 'src', 'nested', 'feature.ts'),
			],
		});
		_internals.liveDispatches.clear();

		const recovered = await recoverCoderSettlement(fixture.repo, TASK_ID);
		expect(recovered?.accepted).toBe(true);
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(fixture.repo, TASK_ID)),
		).toMatchObject({ state: 'coder_delegated', generation: 1 });
		expectCleanup(fixture);
	});

	test('uncertain branch verification preserves COMMITTED cleanup debt and owner', async () => {
		const fixture = createFixture('uncertain-branch');
		await begin(fixture);
		commitAndLand(fixture);
		await settleCoderDispatch({
			directory: fixture.repo,
			taskId: TASK_ID,
			transitionId: fixture.transitionId,
			accepted: true,
			testEngineerExempt: false,
		});
		git(fixture.repo, ['worktree', 'remove', '--force', fixture.worktree]);
		fs.renameSync(
			path.join(fixture.repo, '.git'),
			path.join(fixture.repo, '.git-unavailable'),
		);

		await expect(recoverCoderSettlement(fixture.repo, TASK_ID)).rejects.toThrow(
			'CODER_SETTLEMENT_CLEANUP_UNCERTAIN',
		);
		expect(readWal(fixture)).toMatchObject({
			state: 'COMMITTED',
			cleanupComplete: false,
		});
		const ownerScan = scanWorktreeProvisioningOwnersForRecovery(fixture.repo);
		expect(ownerScan.status).toBe('ok');
		if (ownerScan.status === 'ok') {
			expect(ownerScan.owners.map((owner) => owner.callID)).toEqual([
				fixture.callID,
			]);
		}
	});
});
