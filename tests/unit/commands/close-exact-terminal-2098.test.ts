import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { PluginConfigSchema } from '../../../src/config/schema';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { savePlan } from '../../../src/plan/manager';
import { seedStageBGates } from '../../helpers/task-workflow-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { handleCloseCommand, _internals, closeReceiptLifecycleInternals } =
	await import('../../../src/commands/close.js');

const real = {
	loadPluginConfigWithMeta: _internals.loadPluginConfigWithMeta,
	curateAndStoreSwarm: _internals.curateAndStoreSwarm,
	checkHivePromotions: _internals.checkHivePromotions,
	getGitRepositoryStatus: _internals.getGitRepositoryStatus,
	resetToMainAfterMerge: _internals.resetToMainAfterMerge,
	resetToRemoteBranch: _internals.resetToRemoteBranch,
	resetSwarmStatePreservingSingletons:
		_internals.resetSwarmStatePreservingSingletons,
	runFinalizeRewardSweep: _internals.runFinalizeRewardSweep,
	archiveEvidence: _internals.archiveEvidence,
	endAgentSession: _internals.endAgentSession,
	flushAndDrainTelemetry: _internals.flushAndDrainTelemetry,
	recordPhaseCloseIntent: closeReceiptLifecycleInternals.recordPhaseCloseIntent,
	reconcilePhaseClose: closeReceiptLifecycleInternals.reconcilePhaseClose,
};

function plan(status: 'completed' | 'in_progress'): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Exact close command',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: status === 'completed' ? 'complete' : 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status,
						size: 'small',
						description: 'Close against exact evidence',
						depends: [],
						files_touched: ['src/close.ts'],
					},
				],
			},
		],
	};
}

function archivedJson(directory: string, relativePath: string): unknown {
	const archiveRoot = path.join(directory, '.swarm', 'archive');
	const bundle = fs
		.readdirSync(archiveRoot)
		.find((entry) => entry.startsWith('swarm-'));
	if (!bundle) throw new Error('archive bundle missing');
	return JSON.parse(
		fs.readFileSync(path.join(archiveRoot, bundle, relativePath), 'utf8'),
	);
}

describe('issue #2098 real close command exact terminalization', () => {
	let directory: string;
	let rewardSweep: ReturnType<typeof mock>;

	beforeEach(async () => {
		directory = canonicalMkdtemp('close-command-exact-2098-');
		fs.mkdirSync(path.join(directory, '.git'));
		rewardSweep = mock(async () => {});
		_internals.loadPluginConfigWithMeta = () => ({
			config: PluginConfigSchema.parse({
				guardrails: { enabled: true },
				knowledge: { enabled: false },
				curator: { enabled: false },
			}),
			loadedFromFile: null,
		});
		_internals.curateAndStoreSwarm = mock(async () => ({ stored: 0 }));
		_internals.checkHivePromotions = mock(async () => ({
			new_promotions: 0,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 0,
		}));
		_internals.getGitRepositoryStatus = () => ({
			isRepo: false,
			reason: 'not_git_repo',
			message: 'test disables git alignment',
		});
		_internals.resetToMainAfterMerge = () => ({
			success: true,
			targetBranch: 'main',
			previousBranch: 'main',
			message: 'no-op',
			branchDeleted: false,
			warnings: [],
		});
		_internals.resetToRemoteBranch = () => ({
			success: true,
			targetBranch: 'main',
			localBranch: 'main',
			message: 'no-op',
			alreadyAligned: true,
			prunedBranches: [],
			warnings: [],
		});
		_internals.resetSwarmStatePreservingSingletons = () => {};
		_internals.runFinalizeRewardSweep = rewardSweep;
		_internals.archiveEvidence = mock(async () => {});
		_internals.endAgentSession = mock(async () => {});
		_internals.flushAndDrainTelemetry = mock(async () => {});
	});

	afterEach(() => {
		Object.assign(_internals, real);
		closeReceiptLifecycleInternals.recordPhaseCloseIntent =
			real.recordPhaseCloseIntent;
		closeReceiptLifecycleInternals.reconcilePhaseClose =
			real.reconcilePhaseClose;
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('already-terminal plan with missing evidence is reconciled before archive cleanup', async () => {
		await savePlan(directory, plan('completed'));

		const output = await handleCloseCommand(directory, [], {
			sessionID: 'close-command-test',
		});

		expect(output).toContain('finalized');
		expect(
			archivedJson(directory, path.join('evidence', '1.1.json')),
		).toMatchObject({
			taskId: '1.1',
			workflow: { state: 'complete', lastOutcome: 'task_completed' },
		});
		expect(
			archivedJson(directory, path.join('task-terminals', '1.1.json')),
		).toMatchObject({ version: 2, state: 'COMMITTED' });
		expect(fs.existsSync(path.join(directory, '.swarm', 'evidence'))).toBe(
			false,
		);
	});

	test('authoritative success is preserved and receives no negative close reward', async () => {
		await savePlan(directory, plan('in_progress'));
		const generation = await seedStageBGates(directory, '1.1');
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'task_completed',
			expectedGeneration: generation,
			transitionId: 'already-complete',
		});

		const output = await handleCloseCommand(directory, ['--force'], {
			sessionID: 'close-command-test',
		});

		expect(output).toContain('0 incomplete task(s) marked closed');
		expect(rewardSweep).toHaveBeenCalledTimes(1);
		expect(rewardSweep.mock.calls[0]?.[0]).toMatchObject({
			closedTaskIds: [],
		});
		expect(
			archivedJson(directory, path.join('evidence', '1.1.json')),
		).toMatchObject({
			workflow: { state: 'complete', lastTransitionId: 'already-complete' },
		});
	});

	test('authoritative contradiction pauses before reward, archive, and cleanup', async () => {
		await savePlan(directory, plan('completed'));
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'task_blocked',
			expectedGeneration: 0,
			transitionId: 'blocked-before-close',
		});

		const output = await handleCloseCommand(directory, [], {
			sessionID: 'close-command-test',
		});

		expect(output).toContain('❌ Close paused');
		expect(output).toContain('CLOSE_TERMINAL_EVIDENCE_CONTRADICTION');
		expect(rewardSweep).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(directory, '.swarm', 'archive'))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'evidence', '1.1.json')),
		).toBe(true);
	});

	test('receipt intent ambiguity hard-stops before reward, archive, cleanup, teardown, and alignment', async () => {
		await savePlan(directory, plan('completed'));
		const gitStatus = mock(() => ({
			isRepo: false,
			reason: 'not_git_repo' as const,
			message: 'test disables git alignment',
		}));
		const teardown = mock(() => {});
		const endSession = mock(async () => {});
		_internals.getGitRepositoryStatus = gitStatus;
		_internals.resetSwarmStatePreservingSingletons = teardown;
		_internals.endAgentSession = endSession;
		closeReceiptLifecycleInternals.recordPhaseCloseIntent = mock(
			async () =>
				({
					ok: false,
					code: 'store_unavailable',
					detail:
						'receipt lifecycle scope is ambiguous without an exact session identity',
				}) as never,
		);

		const output = await handleCloseCommand(directory, [], {
			sessionID: 'close-command-test',
		});

		expect(output).toContain('❌ Close paused before reward, archive, cleanup');
		expect(output).toContain(
			'Receipt phase-close intent failed for phase 1: receipt lifecycle scope is ambiguous without an exact session identity. Plan terminalization was not attempted.',
		);
		expect(rewardSweep).not.toHaveBeenCalled();
		expect(gitStatus).not.toHaveBeenCalled();
		expect(teardown).not.toHaveBeenCalled();
		expect(endSession).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(directory, '.swarm', 'archive'))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'close-summary.md')),
		).toBe(false);
		expect(fs.existsSync(path.join(directory, '.swarm', 'plan.json'))).toBe(
			true,
		);
		expect(
			fs.existsSync(
				path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
			),
		).toBe(false);
	});

	test('receipt reconciliation failure hard-stops before reward, archive, cleanup, teardown, and alignment', async () => {
		await savePlan(directory, plan('completed'));
		const gitStatus = mock(() => ({
			isRepo: false,
			reason: 'not_git_repo' as const,
			message: 'test disables git alignment',
		}));
		const teardown = mock(() => {});
		const endSession = mock(async () => {});
		_internals.getGitRepositoryStatus = gitStatus;
		_internals.resetSwarmStatePreservingSingletons = teardown;
		_internals.endAgentSession = endSession;
		closeReceiptLifecycleInternals.reconcilePhaseClose = mock(
			async (_directory, phase: string) => {
				if (phase.startsWith('Phase 1')) {
					return {
						ok: false,
						code: 'store_corrupt',
						detail: 'receipt archive contains an invalid authoritative summary',
					};
				}
				return { ok: true, reconciled: true };
			},
		);

		const output = await handleCloseCommand(directory, [], {
			sessionID: 'close-command-test',
		});

		expect(output).toContain('❌ Close paused before reward, archive, cleanup');
		expect(output).toContain(
			'Receipt phase-close reconciliation failed for phase 1: receipt archive contains an invalid authoritative summary',
		);
		expect(rewardSweep).not.toHaveBeenCalled();
		expect(gitStatus).not.toHaveBeenCalled();
		expect(teardown).not.toHaveBeenCalled();
		expect(endSession).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(directory, '.swarm', 'archive'))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'close-summary.md')),
		).toBe(false);
		expect(fs.existsSync(path.join(directory, '.swarm', 'plan.json'))).toBe(
			true,
		);
		expect(
			fs.existsSync(
				path.join(directory, '.swarm', 'task-terminals', '1.1.json'),
			),
		).toBe(true);
		expect(
			fs.existsSync(path.join(directory, '.swarm', 'evidence', '1.1.json')),
		).toBe(true);
	});
});
