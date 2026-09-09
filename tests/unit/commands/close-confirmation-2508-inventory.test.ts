import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals as closeInternals,
	handleCloseCommand,
} from '../../../src/commands/close.js';
import {
	COMMAND_REGISTRY,
	_internals as registryInternals,
} from '../../../src/commands/registry.js';
import { _internals as gitInternals } from '../../../src/git/branch.js';
import { publishWorktreeRecoveryAuthority } from '../../../src/hooks/delegation-gate/worktree-recovery-authority.js';

const realRunFinalizeStage = closeInternals.runFinalizeStage;
const realRunArchiveStage = closeInternals.runArchiveStage;
const realRunCleanStage = closeInternals.runCleanStage;
const realRunAlignStage = closeInternals.runAlignStage;
const realCloseSnapshotCoordinationInitialization =
	closeInternals.closeSnapshotCoordinationInitialization;
const realRunFinalizeRewardSweep = closeInternals.runFinalizeRewardSweep;
const realResetSwarmStatePreservingSingletons =
	closeInternals.resetSwarmStatePreservingSingletons;
const realEndAgentSession = closeInternals.endAgentSession;
const realDetectFullAuto = closeInternals.detectFullAuto;
const realGetGitRepositoryStatus = closeInternals.getGitRepositoryStatus;
const realGetGitDestructiveInventory =
	closeInternals.getGitDestructiveInventory;
const realResetToMainAfterMerge = closeInternals.resetToMainAfterMerge;
const realResetToRemoteBranch = closeInternals.resetToRemoteBranch;
const realGitExec = gitInternals.gitExec;
const realDetectDefaultRemoteBranch = gitInternals.detectDefaultRemoteBranch;

function tempProject(): string {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), 'close-confirm-2508-inventory-'),
	);
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({ title: 'confirmation inventory test', phases: [] }),
	);
	return directory;
}

function tokenFromPreview(preview: string): string {
	const token = /--confirm=([0-9a-f]{24})/.exec(preview)?.[1];
	expect(token).toBeDefined();
	return token as string;
}

function installPipelineSpies(calls: Record<string, number>): void {
	closeInternals.closeSnapshotCoordinationInitialization = async () => {};
	closeInternals.detectFullAuto = () => false;
	closeInternals.runFinalizeStage = async () => {
		calls.finalize += 1;
	};
	closeInternals.runFinalizeRewardSweep = async () => {};
	closeInternals.runArchiveStage = async () => {
		calls.archive += 1;
	};
	closeInternals.runCleanStage = async () => {
		calls.clean += 1;
		return {
			cleanedFiles: [],
			configBackupsRemoved: 0,
			swarmPlanFilesRemoved: 0,
			residueQuarantined: 0,
			residuePreserved: 0,
		};
	};
	closeInternals.runAlignStage = async () => {
		calls.align += 1;
		return { gitAlignResult: 'alignment stub', prunedBranches: [] };
	};
	closeInternals.resetSwarmStatePreservingSingletons = () => {};
	closeInternals.endAgentSession = () => {};
}

function publishRetainedAuthority(
	directory: string,
	laneBranch = 'lane/review',
) {
	const published = publishWorktreeRecoveryAuthority(directory, {
		originalCallID: `call-${laneBranch}`,
		parentSessionId: 'session-retained',
		taskId: `task-${laneBranch}`,
		reservationId: `reservation-${laneBranch}`,
		generation: 1,
		canonicalBranch: 'main',
		canonicalPath: directory,
		laneBranch,
		lanePath: path.join(directory, '.swarm-worktrees', laneBranch),
		expectedPrimaryHead: 'a'.repeat(40),
		sourceBaseOid: 'b'.repeat(40),
		sourceHeadOid: 'c'.repeat(40),
		targetHeadOid: 'd'.repeat(40),
		strategy: 'squash',
		resultTree: 'e'.repeat(40),
		changedPaths: [],
	});
	if (!published.ok) throw new Error(published.reason);
	return published.authority;
}

describe('close confirmation inventory and retained recovery (#2508)', () => {
	let directory: string;

	beforeEach(() => {
		directory = tempProject();
		closeInternals.getGitRepositoryStatus = () => ({
			isRepo: false,
			reason: 'not_git_repo',
			message: 'test fixture is not a git repository',
		});
	});

	afterEach(() => {
		closeInternals.runFinalizeStage = realRunFinalizeStage;
		closeInternals.runArchiveStage = realRunArchiveStage;
		closeInternals.runCleanStage = realRunCleanStage;
		closeInternals.runAlignStage = realRunAlignStage;
		closeInternals.closeSnapshotCoordinationInitialization =
			realCloseSnapshotCoordinationInitialization;
		closeInternals.runFinalizeRewardSweep = realRunFinalizeRewardSweep;
		closeInternals.resetSwarmStatePreservingSingletons =
			realResetSwarmStatePreservingSingletons;
		closeInternals.endAgentSession = realEndAgentSession;
		closeInternals.detectFullAuto = realDetectFullAuto;
		closeInternals.getGitRepositoryStatus = realGetGitRepositoryStatus;
		closeInternals.getGitDestructiveInventory = realGetGitDestructiveInventory;
		closeInternals.resetToMainAfterMerge = realResetToMainAfterMerge;
		closeInternals.resetToRemoteBranch = realResetToRemoteBranch;
		gitInternals.gitExec = realGitExec;
		gitInternals.detectDefaultRemoteBranch = realDetectDefaultRemoteBranch;
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('wiring inventory binds clean HEAD and the resolved alignment target', () => {
		gitInternals.detectDefaultRemoteBranch = () => 'main';
		gitInternals.gitExec = (args) => {
			if (args[0] === 'status') return '';
			if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref')
				return 'feature\n';
			if (args[0] === 'rev-parse' && args[1] === 'HEAD')
				return 'head-feature\n';
			if (args[0] === 'rev-parse' && args[1] === 'origin/main')
				return 'head-main\n';
			if (args[0] === 'branch' && args[1] === '--merged') return '* main\n';
			if (args[0] === 'branch' && args[1] === '-vv') return '';
			return '';
		};

		const inventory = realGetGitDestructiveInventory(directory, false);

		expect(inventory.error).toBeUndefined();
		expect(inventory.headLabels).toEqual([
			'feature:head-feature->origin/main:head-main',
		]);
	});

	test('inventories external purge-pattern files but excludes internal authorization records', () => {
		const internalPending =
			'.swarm/pending-purge-0123456789abcdef01234567.json';
		const internalClaimed =
			'.swarm/pending-purge-0123456789abcdef01234567-' +
			'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210.claimed.json';
		const externalPending = 'pending-purge-0123456789abcdef01234567.json';
		const externalClaimed =
			'pending-purge-0123456789abcdef01234567-' +
			'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210.claimed.json';
		gitInternals.detectDefaultRemoteBranch = () => null;
		gitInternals.gitExec = (args) => {
			if (args[0] === 'status') {
				return [
					`?? ${internalPending}`,
					`?? ${internalClaimed}`,
					`?? ${externalPending}`,
					`?? ${externalClaimed}`,
				].join('\0');
			}
			if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref')
				return 'feature\n';
			if (args[0] === 'rev-parse' && args[1] === 'HEAD')
				return 'head-feature\n';
			return '';
		};

		const inventory = realGetGitDestructiveInventory(directory, false);
		const paths = inventory.paths.map((candidate) =>
			path.relative(directory, candidate).replaceAll('\\', '/'),
		);

		expect(paths).toContain(externalPending);
		expect(paths).toContain(externalClaimed);
		expect(paths).not.toContain(internalPending);
		expect(paths).not.toContain(internalClaimed);
	});

	test('inventories both staged and unstaged rename/copy paths, including whitespace', () => {
		gitInternals.detectDefaultRemoteBranch = () => null;
		gitInternals.gitExec = (args) => {
			if (args[0] === 'status') {
				return [
					'R  renamed file.txt',
					'old file.txt',
					' C copied file.txt',
					'source file.txt',
				].join('\0');
			}
			if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref')
				return 'feature\n';
			if (args[0] === 'rev-parse' && args[1] === 'HEAD')
				return 'head-feature\n';
			return '';
		};

		const inventory = realGetGitDestructiveInventory(directory, false);
		const paths = inventory.paths.map((candidate) =>
			path.relative(directory, candidate).replaceAll('\\', '/'),
		);

		expect(paths).toEqual([
			'renamed file.txt',
			'old file.txt',
			'copied file.txt',
			'source file.txt',
		]);
	});

	test('binds an unresolved default and rejects a remote appearing after preview', async () => {
		const calls = { finalize: 0, archive: 0, clean: 0, align: 0 };
		closeInternals.getGitRepositoryStatus = () => ({ isRepo: true });
		let detectionCalls = 0;
		gitInternals.detectDefaultRemoteBranch = () =>
			detectionCalls++ === 0 ? null : 'main';
		gitInternals.gitExec = (args) => {
			if (args[0] === 'status') return '';
			if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref')
				return 'feature\n';
			if (args[0] === 'rev-parse' && args[1] === 'HEAD')
				return 'head-feature\n';
			if (args[0] === 'rev-parse' && args[1] === 'origin/main')
				throw new Error('missing remote');
			return '';
		};

		const preview = await handleCloseCommand(directory, []);
		expect(preview).toContain('origin/HEAD:unavailable');
		const token = tokenFromPreview(preview);
		installPipelineSpies(calls);

		const output = await handleCloseCommand(directory, [`--confirm=${token}`]);

		expect(output).toContain('purge scope changed');
		expect(calls).toEqual({ finalize: 0, archive: 0, clean: 0, align: 0 });
	});

	test('retained squash authority is removed only after its exact branch disappears', () => {
		const authority = publishRetainedAuthority(directory);
		gitInternals.gitExec = (args) =>
			args[0] === 'rev-parse' && args[1] === 'refs/heads/lane/review'
				? (() => {
						throw new Error('branch deleted');
					})()
				: '';

		const result = closeInternals.removeConfirmedRecoveryAuthority(directory, {
			authorityDigest: authority.authorityDigest,
			branchName: 'lane/review',
			branchTipSha: 'lane-tip',
		});

		expect(result).toEqual({ ok: true });
		expect(
			fs.existsSync(
				path.join(directory, '.swarm', 'worktree-merge-recovery-v2.json'),
			),
		).toBe(false);
	});

	test('preserves retained authority when its branch tip no longer matches', () => {
		const authority = publishRetainedAuthority(directory, 'lane/moved');
		gitInternals.gitExec = () => 'new-tip\n';

		const result = closeInternals.removeConfirmedRecoveryAuthority(directory, {
			authorityDigest: authority.authorityDigest,
			branchName: 'lane/moved',
			branchTipSha: 'old-tip',
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain('tip changed');
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'worktree-merge-recovery-v2.json'),
					'utf8',
				),
			).authorities,
		).toHaveLength(1);
	});

	test('retained-authority cleanup serializes behind the authority-store lock', () => {
		const authority = publishRetainedAuthority(directory);
		const lockPath = path.join(
			directory,
			'.swarm',
			'locks',
			'worktree-recovery-authority.lock',
		);
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(
			lockPath,
			JSON.stringify({
				nonce: 'held',
				acquiredAt: Date.now(),
				pid: process.pid,
			}),
		);

		const result = closeInternals.removeConfirmedRecoveryAuthority(directory, {
			authorityDigest: authority.authorityDigest,
			branchName: 'lane/review',
			branchTipSha: 'lane-tip',
		});

		expect(result).toEqual({
			ok: false,
			reason: 'recovery authority store is locked',
		});
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'worktree-merge-recovery-v2.json'),
					'utf8',
				),
			).authorities,
		).toHaveLength(1);
	});

	test('deprecated close resolves to the exact finalize handler', () => {
		expect(COMMAND_REGISTRY.finalize.args).toContain('--confirm=<token>');
		expect(COMMAND_REGISTRY.close.args).toContain('--confirm=<token>');
		expect(COMMAND_REGISTRY.close.aliasOf).toBe('finalize');
		const alias = registryInternals.resolveCommand(['close']);
		const canonical = registryInternals.resolveCommand(['finalize']);
		expect(alias?.entry.handler).toBe(canonical?.entry.handler);
		expect(alias?.warning).toContain('Use "/swarm finalize" instead');
	});
});
