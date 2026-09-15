/**
 * j08 — restart policy reconciliation through the real registered host
 * (issue #2668). Durable plan identity and session-scoped QA policy are
 * recovered on boot B; ephemeral auto-proceed authority is intentionally
 * absent. The journey also inspects an interrupted task through the host,
 * then directly exercises the settlement classifier and proves that a late
 * result from the old workflow generation cannot clear the newly accepted one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { handleAutoProceedCommand } from '../../../src/commands/auto-proceed';
import { handleQaGatesCommand } from '../../../src/commands/qa-gates';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import {
	resetSwarmState,
	resetSwarmStatePreservingSingletons,
	swarmState,
} from '../../../src/state';
import { classifySettlementWalState } from '../../../src/workflow/task-recovery-status';
import type { CoderSettlementWalState } from '../../../src/workflow/workflow-wal-schema';
import {
	bootJourneyHost,
	commitWorkingTree,
	createJourneyProject,
	JourneyDriver,
	journeyPlanArgs,
	parseToolResult,
} from '../../helpers/execute-journey-driver';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

const TASK_ID = '1.1';
const FILE = 'src/restart-feature.ts';

function oldSettlement(
	directory: string,
	generation: number,
): CoderSettlementWalState {
	return {
		taskId: TASK_ID,
		state: 'DISPATCHED',
		transitionId: 'journey-j08-old-generation',
		actor: 'coder',
		processId: 0,
		runtimeId: '00000000-0000-4000-8000-000000000000',
		expectedGeneration: generation,
		context: {
			baseline: {
				directory,
				gitHead: null,
				dirtyHash: null,
				prHeadSha: null,
				scope: null,
				changedFiles: [],
			},
			declaredFiles: [FILE],
		},
		accepted: true,
		recordedAt: '2026-01-01T00:00:00.000Z',
	} as unknown as CoderSettlementWalState;
}

function passPayload(): Record<string, unknown> {
	return {
		gates_passed: true,
		batch_status: 'completed',
		total_duration_ms: 1,
		lint: { ran: true, duration_ms: 1 },
		secretscan: {
			ran: true,
			duration_ms: 1,
			result: {
				count: 0,
				findings: [],
				files_scanned: 1,
				incomplete_files: 0,
				incomplete_paths: [],
			},
		},
		sast_scan: { ran: true, duration_ms: 1, result: { verdict: 'pass' } },
		quality_budget: { ran: false, duration_ms: 0 },
	};
}

describe('restart policy reconciliation through the registered host plus direct settlement classification (#2668)', () => {
	let project: ReturnType<typeof createJourneyProject> | null = null;
	let cleanupEnv: (() => void) | null = null;

	beforeEach(() => {
		cleanupEnv = createIsolatedTestEnv().cleanup;
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		cleanupEnv?.();
		cleanupEnv = null;
		project?.cleanup();
		project = null;
	});

	test('durable policy and approved identity survive restart while process-local authority expires', async () => {
		project = createJourneyProject('swarm-j08-');
		const bootA = await bootJourneyHost({ directory: project.directory });
		const driverA = new JourneyDriver(bootA);
		await driverA.configure();
		await driverA.specify(journeyPlanArgs({ taskId: TASK_ID, file: FILE }));

		// Persist one gate through the registered tool and the second through the
		// production qa-gates enable command.  Both are plan policy, not session
		// authority, and must be visible after the process reset.
		const persisted = parseToolResult(
			await bootA.host.tool.set_qa_gates.execute(
				{ test_engineer: true },
				{ directory: project.directory, sessionID: driverA.sessionID },
			),
		);
		expect(persisted.success).toBe(true);
		const enable = await handleQaGatesCommand(
			project.directory,
			['enable', 'reviewer'],
			driverA.sessionID,
		);
		expect(enable).toContain('Enabled gates persisted');

		// The QA override is durable session-scoped policy; auto-proceed is a
		// process-local execution control that must expire across restart.
		const override = await handleQaGatesCommand(
			project.directory,
			['override', 'sast_enabled'],
			driverA.sessionID,
		);
		expect(override).toContain('Session overrides updated');
		expect(
			await handleAutoProceedCommand(
				project.directory,
				['on'],
				driverA.sessionID,
			),
		).toContain('Auto-proceed is now ON');
		expect(
			swarmState.agentSessions.get(driverA.sessionID)?.autoProceedOverride,
		).toBe(true);
		expect(
			swarmState.agentSessions.get(driverA.sessionID)?.qaGateSessionOverrides
				?.sast_enabled,
		).toBe(true);

		const { approval, binding: bindingA } = await driverA.approve(
			'journey fixture j08 approval',
		);
		expect(bindingA.success).toBe(true);
		await driverA.executeCoder({
			taskId: TASK_ID,
			file: FILE,
			mutate: () =>
				writeFileSync(
					path.join(project!.directory, FILE),
					'export const restarted = 1;\n',
				),
		});
		const beforeRestart = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(beforeRestart.state).toBe('coder_delegated');

		// Simulated process death retains durable stores but drops all session
		// execution authority and in-memory ownership.
		resetSwarmStatePreservingSingletons();
		const bootB = await bootJourneyHost({ directory: project.directory });
		const driverB = new JourneyDriver(bootB);
		await driverB.configure();

		const profile = parseToolResult(
			await bootB.host.tool.get_qa_gate_profile.execute(
				{},
				{ directory: project.directory, sessionID: driverB.sessionID },
			),
		);
		expect(profile.success).toBe(true);
		expect(profile.profile.gates.reviewer).toBe(true);
		expect(profile.profile.gates.test_engineer).toBe(true);
		const bindingB = parseToolResult(
			await bootB.host.tool.get_approved_plan.execute(
				{ summary_only: true },
				{ directory: project.directory, sessionID: driverB.sessionID },
			),
		);
		expect(bindingB.success).toBe(true);
		expect(bindingB.drift_detected).toBe(false);
		expect(String(approval.plan_id)).toBe(String(driverA.planBinding?.planId));
		expect(String(driverA.planBinding?.approvedPayloadHash)).toBe(
			String((bindingB.approved_plan as Record<string, unknown>).payload_hash),
		);
		expect(
			swarmState.agentSessions.get(driverB.sessionID)?.autoProceedOverride,
		).toBeUndefined();
		expect(
			swarmState.agentSessions.get(driverB.sessionID)?.qaGateSessionOverrides,
		).toEqual({ sast_enabled: true });
		expect(
			await handleQaGatesCommand(
				project.directory,
				['show'],
				driverB.sessionID,
			),
		).toContain(
			'Session overrides (ratchet-tighter only):\n  - sast_enabled: on (override)',
		);

		const inspect = await driverB.inspectTask({ taskId: TASK_ID });
		expect(inspect.workflow).toMatchObject({
			state: 'coder_delegated',
			generation: 1,
		});

		// Owner-visible inspection remains bounded and typed after restart:
		// interrupted/dead is repairable, cancelled is terminal, a live foreign
		// owner is uncertain, and unreadable evidence is corrupt.
		const interrupted = classifySettlementWalState(
			oldSettlement(project.directory, beforeRestart.generation),
			beforeRestart,
		);
		expect(interrupted.category).toBe('stale');
		expect(interrupted.repairAllowed).toBe(true);
		const cancelled = classifySettlementWalState(
			{
				...oldSettlement(project.directory, 1),
				state: 'ABORTED',
			} as CoderSettlementWalState,
			beforeRestart,
		);
		expect(cancelled.category).toBe('healthy');
		const uncertain = classifySettlementWalState(
			{
				...oldSettlement(project.directory, 1),
				ownedByLiveForeignPid: true,
				processId: 99,
			} as CoderSettlementWalState,
			beforeRestart,
		);
		expect(uncertain.category).toBe('ambiguous');
		expect(uncertain.uncertainExternalEffect).toBe(true);
		const corrupt = classifySettlementWalState(
			{
				...oldSettlement(project.directory, 1),
				state: 'unreadable',
			} as CoderSettlementWalState,
			null,
		);
		expect(corrupt.category).toBe('corrupt');
		expect(corrupt.repairAllowed).toBe(false);

		// Re-dispatch through the registered journey to open a new generation.
		const lateCallID = 'journey-j08-late-old';
		await bootB.host.hooks['tool.execute.before'](
			{
				tool: 'pre_check_batch',
				sessionID: driverB.sessionID,
				callID: lateCallID,
			},
			{ args: { files: [FILE], directory: project.directory } },
		);
		expect(
			(await driverB.preCheck({ taskId: TASK_ID, file: FILE })).gates_passed,
		).toBe(true);
		await driverB.dispatchStageB({
			role: 'reviewer',
			taskId: TASK_ID,
			file: FILE,
			verdictLine: `[REVIEWED] | task-${TASK_ID} | REJECTED | restart rework`,
		});
		commitWorkingTree(project.directory, 'test: commit j08 round one');
		await driverB.driveTaskDelegation({
			role: 'coder',
			callID: 'journey-j08-new-generation',
			taskId: TASK_ID,
			file: FILE,
			mutate: () =>
				writeFileSync(
					path.join(project!.directory, FILE),
					'export const restarted = 2;\n',
				),
			output: { state: 'completed', output: 'new generation accepted' },
		});
		const newGeneration = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(newGeneration.state).toBe('coder_delegated');
		expect(newGeneration.generation).toBeGreaterThan(beforeRestart.generation);

		await bootB.host.hooks['tool.execute.after'](
			{
				tool: 'pre_check_batch',
				sessionID: driverB.sessionID,
				callID: lateCallID,
			},
			{ output: JSON.stringify(passPayload()), metadata: null },
		);
		const afterLate = getTaskWorkflowSnapshot(
			await readTaskEvidence(project.directory, TASK_ID),
		);
		expect(afterLate.state).toBe(newGeneration.state);
		expect(afterLate.generation).toBe(newGeneration.generation);
	}, 180_000);
});
