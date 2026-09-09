import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
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
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realAcquireFinalizeLock = closeInternals.acquireFinalizeLock;
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

const notGitRepository = () => ({
	isRepo: false as const,
	reason: 'not_git_repo' as const,
	message: 'test fixture is not a git repository',
});

function tempProject(): string {
	const directory = canonicalMkdtemp('close-confirm-2508-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({ title: 'confirmation test', phases: [] }),
	);
	return directory;
}

describe('/swarm close confirmation gate (#2508)', () => {
	let directory: string;

	beforeEach(() => {
		directory = tempProject();
		closeInternals.getGitRepositoryStatus = notGitRepository;
	});

	afterEach(() => {
		closeInternals.acquireFinalizeLock = realAcquireFinalizeLock;
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

	function installPipelineSpies(calls: Record<string, number>): void {
		closeInternals.acquireFinalizeLock = async () => ({
			acquired: true,
			release: async () => {},
		});
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

	function tokenFromPreview(preview: string): string {
		const token = /--confirm=([0-9a-f]{24})/.exec(preview)?.[1];
		expect(token).toBeDefined();
		return token as string;
	}

	test('previews and arms the exact cleanup scope without invoking destructive stages', async () => {
		const calls = { finalize: 0, archive: 0, clean: 0, align: 0 };
		installPipelineSpies(calls);
		let lockCalls = 0;
		closeInternals.acquireFinalizeLock = async () => {
			lockCalls++;
			return { acquired: false };
		};

		const output = await handleCloseCommand(directory, []);

		expect(output).toContain('destructive confirmation required');
		expect(output).toContain('plan.json');
		expect(output).toContain('--confirm=');
		expect(lockCalls).toBe(0);
		expect(calls).toEqual({ finalize: 0, archive: 0, clean: 0, align: 0 });
		expect(fs.existsSync(path.join(directory, '.swarm', 'plan.json'))).toBe(
			true,
		);
	});

	test('claims confirmation before the lock and performs no finalize work when lock acquisition fails', async () => {
		const preview = await handleCloseCommand(directory, []);
		const token = tokenFromPreview(preview);

		let lockCalls = 0;
		closeInternals.acquireFinalizeLock = async () => {
			lockCalls++;
			return { acquired: false };
		};
		const output = await handleCloseCommand(directory, [`--confirm=${token}`]);

		expect(lockCalls).toBe(1);
		expect(output).toContain('Another /swarm finalize is already running');
		expect(fs.existsSync(path.join(directory, '.swarm', 'plan.json'))).toBe(
			true,
		);
	});

	test('consumes an exact token once and rejects replay before the lock', async () => {
		const calls = { finalize: 0, archive: 0, clean: 0, align: 0 };
		const token = tokenFromPreview(await handleCloseCommand(directory, []));
		let lockCalls = 0;
		installPipelineSpies(calls);
		closeInternals.acquireFinalizeLock = async () => {
			lockCalls += 1;
			return { acquired: true, release: async () => {} };
		};

		const completed = await handleCloseCommand(directory, [
			`--confirm=${token}`,
		]);

		expect(completed).toContain('Swarm finalized');
		expect(calls).toEqual({ finalize: 1, archive: 1, clean: 1, align: 1 });
		expect(lockCalls).toBe(1);

		const replay = await handleCloseCommand(directory, [`--confirm=${token}`]);

		expect(replay).toContain('Close confirmation rejected');
		expect(lockCalls).toBe(1);
		expect(calls).toEqual({ finalize: 1, archive: 1, clean: 1, align: 1 });
	});

	test('rejects inventory drift observed immediately after lock acquisition', async () => {
		const calls = { finalize: 0, archive: 0, clean: 0, align: 0 };
		const token = tokenFromPreview(await handleCloseCommand(directory, []));
		installPipelineSpies(calls);
		closeInternals.acquireFinalizeLock = async () => {
			fs.writeFileSync(path.join(directory, '.swarm', 'context.md'), 'drift');
			return { acquired: true, release: async () => {} };
		};

		const output = await handleCloseCommand(directory, [`--confirm=${token}`]);

		expect(output).toContain('destructive inventory changed');
		expect(calls).toEqual({ finalize: 0, archive: 0, clean: 0, align: 0 });
	});

	test('rejects a same-name branch whose frozen tip changes before finalization', async () => {
		const calls = { finalize: 0, archive: 0, clean: 0, align: 0 };
		let inventoryCalls = 0;
		closeInternals.getGitRepositoryStatus = () => ({ isRepo: true });
		closeInternals.getGitDestructiveInventory = () => {
			const tipSha = inventoryCalls++ < 2 ? 'tip-old' : 'tip-new';
			return {
				paths: [],
				branchLabels: ['feature'],
				branchFingerprints: [`feature\0${tipSha}\0automatic prior branch`],
				headLabels: [],
			};
		};

		const token = tokenFromPreview(await handleCloseCommand(directory, []));
		installPipelineSpies(calls);
		const output = await handleCloseCommand(directory, [`--confirm=${token}`]);

		expect(output).toContain('destructive inventory changed');
		expect(calls).toEqual({ finalize: 0, archive: 0, clean: 0, align: 0 });
	});

	test('binds clean HEAD divergence and covers cautious alignment fallback', async () => {
		let aggressiveCalls = 0;
		let cautiousCalls = 0;
		closeInternals.getGitRepositoryStatus = () => ({ isRepo: true });
		closeInternals.getGitDestructiveInventory = () => ({
			paths: [],
			branchLabels: [],
			headLabels: ['feature:head-feature->origin/main:head-main'],
		});
		closeInternals.resetToMainAfterMerge = async () => {
			aggressiveCalls += 1;
			return {
				success: false,
				targetBranch: 'origin/main',
				previousBranch: 'feature',
				message: 'aggressive refused',
				branchDeleted: false,
				changesDiscarded: false,
				warnings: [],
			};
		};
		closeInternals.resetToRemoteBranch = async () => {
			cautiousCalls += 1;
			return {
				success: true,
				targetBranch: 'origin/main',
				localBranch: 'feature',
				message: 'cautious fallback aligned',
				alreadyAligned: false,
				prunedBranches: [],
				warnings: [],
			};
		};
		const calls = { finalize: 0, archive: 0, clean: 0, align: 0 };
		const preview = await handleCloseCommand(directory, []);
		expect(preview).toContain('Git alignment may reset or checkout HEAD');
		const token = tokenFromPreview(preview);
		installPipelineSpies(calls);
		closeInternals.runAlignStage = realRunAlignStage;
		closeInternals.getGitRepositoryStatus = () => ({ isRepo: true });
		closeInternals.getGitDestructiveInventory = () => ({
			paths: [],
			branchLabels: [],
			headLabels: ['feature:head-feature->origin/main:head-main'],
		});
		closeInternals.resetToMainAfterMerge = async () => {
			aggressiveCalls += 1;
			return {
				success: false,
				targetBranch: 'origin/main',
				previousBranch: 'feature',
				message: 'aggressive refused',
				branchDeleted: false,
				changesDiscarded: false,
				warnings: [],
			};
		};
		closeInternals.resetToRemoteBranch = async () => {
			cautiousCalls += 1;
			return {
				success: true,
				targetBranch: 'origin/main',
				localBranch: 'feature',
				message: 'cautious fallback aligned',
				alreadyAligned: false,
				prunedBranches: [],
				warnings: [],
			};
		};

		const output = await handleCloseCommand(directory, [`--confirm=${token}`]);

		expect(output).toContain('cautious fallback aligned');
		expect(aggressiveCalls).toBe(1);
		expect(cautiousCalls).toBe(1);
	});

	test('finalize and deprecated close advertise the same confirmation argument', () => {
		expect(COMMAND_REGISTRY.finalize.args).toContain('--confirm=<token>');
		expect(COMMAND_REGISTRY.close.args).toContain('--confirm=<token>');
		expect(COMMAND_REGISTRY.close.aliasOf).toBe('finalize');
	});
});
