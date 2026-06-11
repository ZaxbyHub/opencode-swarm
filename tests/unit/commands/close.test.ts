/**
 * Tests for handleCloseCommand
 * Verifies the command handler for /swarm close
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initLedger } from '../../../src/plan/ledger.js';
import { derivePlanId } from '../../../src/plan/utils.js';

/**
 * After /swarm close, plan.json is moved to the timestamped archive bundle and
 * removed from .swarm/ so the next session starts clean. Tests that used to
 * read .swarm/plan.json directly must now read the archived copy.
 */
function readArchivedPlanJson(testDirectory: string): {
	title?: string;
	phases: Array<{
		id: number;
		name?: string;
		status: string;
		tasks: Array<{ id: string; status: string }>;
	}>;
} {
	const archiveRoot = path.join(testDirectory, '.swarm', 'archive');
	const entries = readdirSync(archiveRoot, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name.startsWith('swarm-'))
		.map((e) => e.name)
		.sort();
	if (entries.length === 0) {
		throw new Error(`No archive bundle found in ${archiveRoot}`);
	}
	const latest = entries[entries.length - 1];
	const archivedPlanPath = path.join(archiveRoot, latest, 'plan.json');
	return JSON.parse(readFileSync(archivedPlanPath, 'utf-8'));
}

type TestPlanInput = {
	title?: string;
	swarm?: string;
	current_phase?: number;
	phases: Array<{
		id: number;
		name: string;
		status: string;
		tasks: Array<Record<string, unknown> & { id: string; status?: string }>;
	}>;
};

function canonicalPlan(input: TestPlanInput) {
	return {
		schema_version: '1.0.0',
		swarm: input.swarm ?? 'test-swarm',
		current_phase: input.current_phase ?? 1,
		...input,
		phases: input.phases.map((phase) => ({
			...phase,
			tasks: phase.tasks.map((task) => ({
				phase: phase.id,
				description: `Task ${task.id}`,
				...task,
				status: task.status === 'complete' ? 'completed' : task.status,
			})),
		})),
	};
}

async function writeCanonicalPlan(
	testDirectory: string,
	input: TestPlanInput,
) {
	const plan = canonicalPlan(input);
	writeFileSync(
		path.join(testDirectory, '.swarm', 'plan.json'),
		JSON.stringify(plan),
	);
	await initLedger(testDirectory, derivePlanId(plan));
	return plan;
}

// Mock dependencies before importing the module
const mockExecuteWriteRetro = mock(async (_args: unknown, _directory: string) =>
	JSON.stringify({
		success: true,
		phase: 1,
		task_id: 'retro-1',
		message: 'Done',
	}),
);

const mockCurateAndStoreSwarm = mock(async () => {});

const mockArchiveEvidence = mock(async () => {});

const mockFlushPendingSnapshot = mock(async () => {});

const mockPromoteToHive = mock(
	async (_dir: string, _lesson: string, _category: string) => {},
);

let forceSkillReviewConfigError = false;
let configLoadCallCount = 0;
const mockLoadPluginConfigWithMeta = mock((_directory: string) => {
	configLoadCallCount++;
	if (forceSkillReviewConfigError && configLoadCallCount > 1) {
		throw new Error('bad config');
	}
	return {
		config: {
			skill_improver: {
				enabled: true,
				max_calls_per_day: 10,
				trigger: 'manual',
				targets: ['skills', 'spec', 'architect_prompt', 'knowledge'],
				write_mode: 'proposal',
				require_user_approval: true,
				quota_window: 'utc',
				allow_deterministic_fallback: true,
			},
		},
		loadedFromFile: null,
	};
});

const mockRunSkillImprover = mock(async () => ({
	ran: true,
	proposalPath: path.join(
		testDir,
		'.swarm',
		'skill-improver',
		'proposals',
		'proposal.md',
	),
	source: 'deterministic_fallback',
	quota: { date: '2026-05-11', calls_used: 1, max_calls: 10 },
}));

let forceSkillReviewTimeout = false;
let observedSkillReviewSignal: AbortSignal | undefined;
let observedSkillReviewAborted = false;

mock.module('../../../src/tools/write-retro.js', () => ({
	executeWriteRetro: mockExecuteWriteRetro,
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mockCurateAndStoreSwarm,
}));

mock.module('../../../src/hooks/hive-promoter.js', () => ({
	isHiveEligible: () => false,
	promoteToHive: mockPromoteToHive,
}));

mock.module('../../../src/evidence/manager.js', () => ({
	archiveEvidence: mockArchiveEvidence,
}));

mock.module('../../../src/session/snapshot-writer.js', () => ({
	flushPendingSnapshot: mockFlushPendingSnapshot,
}));

mock.module('../../../src/config.js', () => ({
	loadPluginConfigWithMeta: mockLoadPluginConfigWithMeta,
}));

mock.module('../../../src/config/index.js', () => ({
	loadPluginConfigWithMeta: mockLoadPluginConfigWithMeta,
}));

mock.module('../../../src/services/skill-improver.js', () => ({
	runSkillImprover: mock(async (req: { signal?: AbortSignal } = {}) => {
		observedSkillReviewSignal = req.signal;
		if (forceSkillReviewTimeout) {
			req.signal?.addEventListener(
				'abort',
				() => {
					observedSkillReviewAborted = true;
				},
				{ once: true },
			);
			return await new Promise<never>(() => {});
		}
		return await mockRunSkillImprover(req);
	}),
}));

// Shared mock for swarmState + reset counter so tests can verify the full
// state reset path (Issue 1 C1).
const mockSwarmState = {
	activeToolCalls: new Map(),
	toolAggregates: new Map(),
	activeAgent: new Map(),
	delegationChains: new Map(),
	pendingEvents: 0,
	lastBudgetPct: 0,
	agentSessions: new Map(),
	pendingRehydrations: new Set(),
	opencodeClient: { sentinel: 'preserved-client' } as unknown as null,
	fullAutoEnabledInConfig: true,
	environmentProfiles: new Map(),
	curatorInitAgentNames: [] as string[],
	curatorPhaseAgentNames: [] as string[],
	skillImproverAgentNames: [] as string[],
};

let resetSwarmStateCallCount = 0;
function mockResetSwarmState(): void {
	resetSwarmStateCallCount++;
	mockSwarmState.activeToolCalls.clear();
	mockSwarmState.toolAggregates.clear();
	mockSwarmState.activeAgent.clear();
	mockSwarmState.delegationChains.clear();
	mockSwarmState.pendingEvents = 0;
	mockSwarmState.lastBudgetPct = 0;
	mockSwarmState.agentSessions.clear();
	mockSwarmState.pendingRehydrations.clear();
	// Simulate the real resetSwarmState: it would null the client and flag
	mockSwarmState.opencodeClient = null;
	mockSwarmState.fullAutoEnabledInConfig = false;
	mockSwarmState.environmentProfiles.clear();
	mockSwarmState.curatorInitAgentNames = [];
	mockSwarmState.curatorPhaseAgentNames = [];
	mockSwarmState.skillImproverAgentNames = [];
}

mock.module('../../../src/state.js', () => ({
	swarmState: mockSwarmState,
	endAgentSession: () => {},
	resetSwarmState: mockResetSwarmState,
}));

// Import after mock setup
const { handleCloseCommand, _internals } = await import(
	'../../../src/commands/close.js'
);

// ── DI Conversion Summary ────────────────────────────────────────────
//
// WITHIN-MODULE MOCKS: NONE POSSIBLE
// close.ts imports all functions directly (flushPendingSnapshot, swarmState,
// resetSwarmState, archiveEvidence, executeWriteRetro, curateAndStoreSwarm) and
// does NOT route any through _internals. The _internals DI seam only works when
// the consuming module uses _internals (e.g., full-auto-intercept.ts imports
// state._internals directly). Since close.ts has no _internals usage, none of
// its imports can be intercepted via _internals.
//
// CROSS-MODULE MOCKS: All mocks remain as mock.module
// - executeWriteRetro (tools/write-retro.ts)
// - curateAndStoreSwarm (hooks/knowledge-curator.ts)
// - archiveEvidence (evidence/manager.ts) — not in manager._internals
// - flushPendingSnapshot (session/snapshot-writer.ts) — close.ts imports directly
// - swarmState + resetSwarmState (state.ts) — close.ts imports directly
//
// All mock.module calls require afterEach(mock.restore()) cleanup.
// ─────────────────────────────────────────────────────────────────────

let testDir: string;

describe('handleCloseCommand', () => {
	beforeEach(() => {
		mockExecuteWriteRetro.mockClear();
		mockCurateAndStoreSwarm.mockClear();
		mockArchiveEvidence.mockClear();
		mockFlushPendingSnapshot.mockClear();
		mockPromoteToHive.mockClear();
		mockLoadPluginConfigWithMeta.mockClear();
		mockRunSkillImprover.mockClear();
		forceSkillReviewTimeout = false;
		observedSkillReviewSignal = undefined;
		observedSkillReviewAborted = false;
		forceSkillReviewConfigError = false;
		configLoadCallCount = 0;
		resetSwarmStateCallCount = 0;
		// Re-seed the mock state for each test so reset assertions are isolated.
		mockSwarmState.opencodeClient = {
			sentinel: 'preserved-client',
		} as unknown as null;
		mockSwarmState.fullAutoEnabledInConfig = true;
		mockSwarmState.curatorInitAgentNames = [
			'curator_init',
			'swarm2_curator_init',
		];
		mockSwarmState.curatorPhaseAgentNames = ['curator_phase'];
		mockSwarmState.skillImproverAgentNames = [
			'skill_improver',
			'swarm2_skill_improver',
		];
		mockSwarmState.activeToolCalls.set('tool-a', { stale: true });
		mockSwarmState.agentSessions.set('session-1', { stale: true });
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-command-test-'));
		mkdirSync(path.join(testDir, '.swarm', 'session'), { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		// Restore all mock.module mocks to prevent cross-test pollution
		mock.restore();
	});

	describe('Writes retrospective for in-progress phases', () => {
		it('should call executeWriteRetro for each in-progress phase', async () => {
			const planData = canonicalPlan({
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'complete',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
					{
						id: 2,
						name: 'Phase 2',
						status: 'in_progress',
						tasks: [
							{ id: '2.1', status: 'complete' },
							{ id: '2.2', status: 'in_progress' },
						],
					},
				],
			});
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			await handleCloseCommand(testDir, []);

			expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(1);
			expect(mockExecuteWriteRetro).toHaveBeenCalledWith(
				expect.objectContaining({
					phase: 2,
					summary: 'Phase closed via /swarm close',
					task_count: 2,
				}),
				testDir,
			);
		});

		it('should call executeWriteRetro for multiple in-progress phases', async () => {
			await writeCanonicalPlan(testDir, {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
					{
						id: 2,
						name: 'Phase 2',
						status: 'in_progress',
						tasks: [{ id: '2.1', status: 'in_progress' }],
					},
					{
						id: 3,
						name: 'Phase 3',
						status: 'complete',
						tasks: [],
					},
				],
			});

			await handleCloseCommand(testDir, []);

			expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(2);
		});
	});

	describe('Curates lessons', () => {
		it('should call curateAndStoreSwarm to curate lessons', async () => {
			const planData = {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
				],
			};
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			await handleCloseCommand(testDir, []);

			expect(mockCurateAndStoreSwarm).toHaveBeenCalledTimes(1);
			expect(mockCurateAndStoreSwarm).toHaveBeenCalledWith(
				[],
				'Test Project',
				{ phase_number: 0 },
				testDir,
				expect.any(Object),
			);
		});
	});

	describe('Sets closed status', () => {
		it('should set in-progress phases to closed status', async () => {
			await writeCanonicalPlan(testDir, {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{ id: '1.1', status: 'complete' },
							{ id: '1.2', status: 'in_progress' },
						],
					},
				],
			});

			await handleCloseCommand(testDir, []);

			const updatedPlan = readArchivedPlanJson(testDir);
			expect(updatedPlan.phases[0].status).toBe('closed');
			expect(updatedPlan.phases[0].tasks[0].status).toBe('completed');
			expect(updatedPlan.phases[0].tasks[1].status).toBe('closed');
		});

		it('should close pending phases that were never started', async () => {
			await writeCanonicalPlan(testDir, {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'complete',
						tasks: [{ id: '1.1', status: 'completed' }],
					},
					{
						id: 2,
						name: 'Phase 2',
						status: 'pending',
						tasks: [{ id: '2.1', status: 'pending' }],
					},
				],
			});

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('finalized');
			const updatedPlan = readArchivedPlanJson(testDir);
			expect(updatedPlan.phases[0].status).toBe('complete');
			expect(updatedPlan.phases[1].status).toBe('closed');
			expect(updatedPlan.phases[1].tasks[0].status).toBe('closed');
			// No retros for pending phases (never started)
			expect(mockExecuteWriteRetro).not.toHaveBeenCalled();
			// Pending phase and task should be counted in close summary
			expect(result).toContain('1 phase(s) closed');
			expect(result).toContain('1 incomplete task(s) marked closed');
		});

		it('should preserve completed (alias) phase status', async () => {
			await writeCanonicalPlan(testDir, {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'completed',
						tasks: [{ id: '1.1', status: 'completed' }],
					},
					{
						id: 2,
						name: 'Phase 2',
						status: 'in_progress',
						tasks: [{ id: '2.1', status: 'in_progress' }],
					},
				],
			});

			await handleCloseCommand(testDir, []);

			const updatedPlan = readArchivedPlanJson(testDir);
			expect(updatedPlan.phases[0].status).toBe('completed');
			expect(updatedPlan.phases[0].tasks[0].status).toBe('completed');
			expect(updatedPlan.phases[1].status).toBe('closed');
		});

		it('should set complete phases to closed status', async () => {
			await writeCanonicalPlan(testDir, {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'complete',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
					{
						id: 2,
						name: 'Phase 2',
						status: 'in_progress',
						tasks: [{ id: '2.1', status: 'in_progress' }],
					},
				],
			});

			await handleCloseCommand(testDir, []);

			const updatedPlan = readArchivedPlanJson(testDir);
			// When closing, all non-complete phases get closed
			// complete phases remain complete since allDone is false (due to in_progress phase)
			expect(updatedPlan.phases[0].status).toBe('complete');
			expect(updatedPlan.phases[1].status).toBe('closed');
		});
	});

	describe('Archives evidence', () => {
		it('should call archiveEvidence with correct parameters', async () => {
			const planData = canonicalPlan({
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
				],
			});
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			await handleCloseCommand(testDir, []);

			expect(mockArchiveEvidence).toHaveBeenCalledTimes(1);
			expect(mockArchiveEvidence).toHaveBeenCalledWith(testDir, 30, 10);
		});
	});

	describe('Writes summary', () => {
		it('should write close-summary.md file', async () => {
			const planData = {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{ id: '1.1', status: 'complete' },
							{ id: '1.2', status: 'in_progress' },
						],
					},
				],
			};
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			await handleCloseCommand(testDir, []);

			const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
			expect(existsSync(summaryPath)).toBe(true);

			const summary = readFileSync(summaryPath, 'utf-8');
			expect(summary).toContain('# Swarm Close Summary');
			expect(summary).toContain('**Project:** Test Project');
			expect(summary).toContain('## Retrospective');
			expect(summary).toContain('- Phase 1 closed');
			expect(summary).toContain('**Tasks marked closed:** 1');
			expect(summary).toContain('- 1.2');
			expect(summary).toContain('## Lessons Committed');
			expect(summary).toContain('Archived');
			expect(summary).toContain(
				'- Cleared agent sessions and delegation chains',
			);
			expect(summary).toContain(
				'- Set non-completed phases/tasks to closed status',
			);
		});

		it('should handle case with no incomplete tasks', async () => {
			const planData = {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
				],
			};
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			await handleCloseCommand(testDir, []);

			const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
			const summary = readFileSync(summaryPath, 'utf-8');
			expect(summary).toContain('## Lessons Committed');
			expect(summary).toContain('_No lessons committed_');
		});
	});

	describe('Clears state', () => {
		it('should NOT call flushPendingSnapshot during close', async () => {
			// flushPendingSnapshot was removed — close clears session state instead of flushing it
			const planData = {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
				],
			};
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			await handleCloseCommand(testDir, []);

			expect(mockFlushPendingSnapshot).not.toHaveBeenCalled();
		});
	});

	describe('Is idempotent', () => {
		it('should return already closed message when no in-progress phases', async () => {
			const planData = {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'complete',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
					{
						id: 2,
						name: 'Phase 2',
						status: 'blocked',
						tasks: [{ id: '2.1', status: 'blocked' }],
					},
				],
			};
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			const result = await handleCloseCommand(testDir, []);

			// New behavior: returns "Plan was already complete" with cleanup steps applied
			expect(result).toContain('Session finalized');
			expect(result).toContain('terminal state');
			expect(result).not.toContain('No action taken');
			expect(mockExecuteWriteRetro).not.toHaveBeenCalled();
			// Cleanup runs even for terminal plans
			expect(mockArchiveEvidence).toHaveBeenCalledTimes(1);
		});

		it('should return already closed message when all phases are complete', async () => {
			const planData = {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'complete',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
				],
			};
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			const result = await handleCloseCommand(testDir, []);

			// New behavior: returns "terminal state" with cleanup steps applied
			expect(result).toContain('Session finalized');
			expect(result).toContain('terminal state');
			expect(mockExecuteWriteRetro).not.toHaveBeenCalled();
			// Cleanup runs even for terminal plans
			expect(mockArchiveEvidence).toHaveBeenCalledTimes(1);
		});

		it('should be safe to run twice - second run operates as plan-free close', async () => {
			const planData = {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
				],
			};
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			// First run — has an in-progress phase, archives & removes plan.json
			const result1 = await handleCloseCommand(testDir, []);
			expect(result1).toContain('finalized');

			// Second run — plan.json was archived by the first run, so this behaves
			// as a plan-free close. The command remains idempotent/safe to re-run.
			const result2 = await handleCloseCommand(testDir, []);

			expect(result2).toContain('Swarm finalized');
			expect(result2).toContain('0 phase(s) closed');
			// Cleanup runs twice (once per run)
			expect(mockArchiveEvidence).toHaveBeenCalledTimes(2);
			// First run wrote 1 phase retro; second run wrote 1 session-level retro
			expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(2);
		});

		it('should handle plan.json with no phases', async () => {
			const planData = {
				title: 'Test Project',
				phases: [],
			};
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			const result = await handleCloseCommand(testDir, []);

			// Empty phases array runs normally, not as terminal state
			expect(result).toContain('finalized');
			expect(result).not.toContain('terminal state');
			expect(result).toContain('0 phase(s) closed');
			expect(mockExecuteWriteRetro).not.toHaveBeenCalled();
			// Cleanup runs even for empty phases
			expect(mockArchiveEvidence).toHaveBeenCalledTimes(1);
		});
	});

	describe('Error handling', () => {
		// FIXED: Test now expects plan-free session to succeed (old behavior was error on missing plan.json)
		it('should succeed when plan.json is absent (plan-free session)', async () => {
			// No plan.json written — plan-free session
			const result = await handleCloseCommand(testDir, []);

			// Should succeed, not error
			expect(result).toContain('finalized');
			expect(result).not.toContain('Failed to read plan.json');
			// curateAndStoreSwarm should still have been called
			expect(mockCurateAndStoreSwarm).toHaveBeenCalledTimes(1);
			// archiveEvidence should still have been called
			expect(mockArchiveEvidence).toHaveBeenCalledTimes(1);
		});

		it('should handle executeWriteRetro returning non-success', async () => {
			mockExecuteWriteRetro.mockImplementation(async () =>
				JSON.stringify({ success: false, message: 'Failed' }),
			);

			const planData = {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
				],
			};
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('finalized');
			expect(result).toContain('Warnings');
			expect(result).toContain('Retrospective write failed for phase 1');
		});

		it('should handle executeWriteRetro returning non-JSON', async () => {
			mockExecuteWriteRetro.mockImplementation(
				async () => 'NOT JSON {{{{' as any,
			);

			const planData = {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
				],
			};
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			const result = await handleCloseCommand(testDir, []);

			// Non-JSON response is not treated as an error
			expect(result).toContain('finalized');
		});
	});

	describe('Return message format', () => {
		it('should return success message with correct counts', async () => {
			const planData = {
				title: 'Test Project',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{ id: '1.1', status: 'complete' },
							{ id: '1.2', status: 'in_progress' },
							{ id: '1.3', status: 'in_progress' },
						],
					},
				],
			};
			writeFileSync(
				path.join(testDir, '.swarm', 'plan.json'),
				JSON.stringify(planData),
			);

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('✅ Swarm finalized');
			expect(result).toContain('1 phase(s) closed');
			expect(result).toContain('2 incomplete task(s) marked closed');
		});
	});

	// -------------------------------------------------------------------------
	// NEW TESTS — New fixes (plan-free, context reset, backup cleanup, branch pruning, lessons)
	// -------------------------------------------------------------------------
	describe('New fixes (plan-free, context reset, backup cleanup, branch pruning, lessons)', () => {
		// =====================================================================
		// Group: Plan-free session (Fix 1)
		// =====================================================================

		describe('Plan-free session (Fix 1)', () => {
			it('PF1: No plan.json → succeeds, returns "finalized"', async () => {
				// No plan.json — plan-free session
				const result = await handleCloseCommand(testDir, []);

				expect(result).toContain('finalized');
			});

			it('PF2: No plan.json → session-level retro IS called with retro-session task_id', async () => {
				// No plan.json — plan-free session
				await handleCloseCommand(testDir, []);

				// Session-level retro is called exactly once for plan-free closes so
				// the archive + knowledge curator still have something to record.
				expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(1);
				expect(mockExecuteWriteRetro).toHaveBeenCalledWith(
					expect.objectContaining({
						phase: 1,
						task_id: 'retro-session',
						metadata: expect.objectContaining({ session_scope: 'plan_free' }),
					}),
					expect.any(String),
				);
			});

			it('PF3: No plan.json → archiveEvidence IS called', async () => {
				// No plan.json — plan-free session
				await handleCloseCommand(testDir, []);

				expect(mockArchiveEvidence).toHaveBeenCalledTimes(1);
			});

			it('PF4: No plan.json → curateAndStoreSwarm IS called', async () => {
				// No plan.json — plan-free session
				await handleCloseCommand(testDir, []);

				expect(mockCurateAndStoreSwarm).toHaveBeenCalledTimes(1);
			});

			it('PF5: No plan.json → flushPendingSnapshot is NOT called', async () => {
				// No plan.json — plan-free session
				await handleCloseCommand(testDir, []);

				expect(mockFlushPendingSnapshot).not.toHaveBeenCalled();
			});

			it('PF6: Malformed plan.json (exists but invalid JSON) → returns error containing "Failed to read plan.json"', async () => {
				// Write invalid JSON to plan.json
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					'NOT VALID JSON {{{',
				);

				const result = await handleCloseCommand(testDir, []);

				expect(result).toContain('Failed to read plan.json');
			});

			it('PF7: Empty phases array (plan exists, phases: []) → runs cleanup and returns finalized', async () => {
				// Plan with empty phases array
				const planData = {
					title: 'Test Project',
					phases: [],
				};
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify(planData),
				);

				const result = await handleCloseCommand(testDir, []);

				// Empty phases: runs cleanup and returns normal success (not terminal state)
				expect(result).toContain('finalized');
				expect(result).not.toContain('terminal state');
				// Cleanup runs
				expect(mockArchiveEvidence).toHaveBeenCalledTimes(1);
				// No phases AND plan exists → no retros (session retro only runs when
				// !planExists)
				expect(mockExecuteWriteRetro).not.toHaveBeenCalled();
			});

			it('PF8: Plan-free --force → session retro flagged as forced', async () => {
				await handleCloseCommand(testDir, ['--force']);

				expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(1);
				const callArgs = mockExecuteWriteRetro.mock.calls[0]?.[0] as {
					summary: string;
					task_id: string;
				};
				expect(callArgs.task_id).toBe('retro-session');
				expect(callArgs.summary).toContain('force');
			});

			it('PF9: Phased close does NOT write session retro (phase retros are enough)', async () => {
				const planData = {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'in_progress',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				};
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify(planData),
				);

				await handleCloseCommand(testDir, []);

				// Exactly 1 retro (the phase retro) — session retro must NOT fire
				expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(1);
				const callArgs = mockExecuteWriteRetro.mock.calls[0]?.[0] as {
					task_id?: string;
				};
				expect(callArgs.task_id).toBeUndefined();
			});
		});

		// =====================================================================
		// Group: plan.json archive-and-remove (Claim E)
		// =====================================================================

		describe('plan.json archive-and-remove (Claim E)', () => {
			it('AR1: After close, plan.json no longer exists in .swarm/', async () => {
				const planData = {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'in_progress',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				};
				const planPath = path.join(testDir, '.swarm', 'plan.json');
				writeFileSync(planPath, JSON.stringify(planData));

				await handleCloseCommand(testDir, []);

				expect(existsSync(planPath)).toBe(false);
			});

			it('AR2: After close, plan.json IS present in the archive bundle', async () => {
				await writeCanonicalPlan(testDir, {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'in_progress',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				});

				await handleCloseCommand(testDir, []);

				const archived = readArchivedPlanJson(testDir);
				expect(archived.title).toBe('Test Project');
				expect(archived.phases[0].status).toBe('closed');
			});

			it('AR3: Terminal-state plan is also archived and removed', async () => {
				const planData = {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'complete',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				};
				const planPath = path.join(testDir, '.swarm', 'plan.json');
				writeFileSync(planPath, JSON.stringify(planData));

				await handleCloseCommand(testDir, []);

				// plan.json removed from active dir
				expect(existsSync(planPath)).toBe(false);
				// But present in archive
				const archived = readArchivedPlanJson(testDir);
				expect(archived.phases[0].status).toBe('complete');
			});

			it('AR4: plan-free close does NOT warn about failed plan.json archive', async () => {
				// No plan.json written — plan-free session
				const result = await handleCloseCommand(testDir, []);

				// Because plan.json never existed, it cannot be "preserved because not
				// archived". The preserve warning is only for files that existed but
				// failed to copy.
				expect(result).not.toContain('Preserved plan.json');
			});
		});

		// =====================================================================
		// Group: context.md reset (Fix 2)
		// =====================================================================

		describe('context.md reset (Fix 2)', () => {
			it('CM1: After close, .swarm/context.md is written', async () => {
				// No plan.json to keep it simple
				await handleCloseCommand(testDir, []);

				const contextPath = path.join(testDir, '.swarm', 'context.md');
				expect(existsSync(contextPath)).toBe(true);
			});

			it('CM2: context.md contains "No active plan. Next session starts fresh."', async () => {
				// No plan.json to keep it simple
				await handleCloseCommand(testDir, []);

				const contextPath = path.join(testDir, '.swarm', 'context.md');
				const context = readFileSync(contextPath, 'utf-8');
				expect(context).toContain('No active plan. Next session starts fresh.');
			});

			it('CM3: context.md contains the project name from plan title', async () => {
				const planData = {
					title: 'My Special Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'in_progress',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				};
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify(planData),
				);

				await handleCloseCommand(testDir, []);

				const contextPath = path.join(testDir, '.swarm', 'context.md');
				const context = readFileSync(contextPath, 'utf-8');
				expect(context).toContain('My Special Project');
			});

			it('CM4: context.md content is correct after already-terminal plan close', async () => {
				const planData = {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'complete',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				};
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify(planData),
				);
				await handleCloseCommand(testDir, []);
				const contextPath = path.join(testDir, '.swarm', 'context.md');
				expect(existsSync(contextPath)).toBe(true);
				const content = readFileSync(contextPath, 'utf-8');
				expect(content).toContain('No active plan. Next session starts fresh.');
				expect(content).toContain('Test Project');
				expect(content).not.toContain('## Agent Activity');
			});
		});

		// =====================================================================
		// Group: Config-backup cleanup (Fix 3)
		// Note: These tests use in_progress phase to prevent early return (allDone=true)
		// =====================================================================

		describe('Config-backup cleanup (Fix 3)', () => {
			it('CB1: Config-backup files are removed after close', async () => {
				// Create some backup files
				writeFileSync(
					path.join(testDir, '.swarm', 'config-backup-001.json'),
					'{}',
				);
				writeFileSync(
					path.join(testDir, '.swarm', 'config-backup-002.json'),
					'{}',
				);

				// Write a plan WITH in-progress phase so allDone=false and cleanup code runs
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				await handleCloseCommand(testDir, []);

				// Backup files should be gone
				expect(
					existsSync(path.join(testDir, '.swarm', 'config-backup-001.json')),
				).toBe(false);
				expect(
					existsSync(path.join(testDir, '.swarm', 'config-backup-002.json')),
				).toBe(false);
			});

			it('CB2: Non-backup .swarm files are NOT removed', async () => {
				// Create a non-backup file
				writeFileSync(
					path.join(testDir, '.swarm', 'some-other-file.json'),
					'{}',
				);
				// Create a backup file
				writeFileSync(
					path.join(testDir, '.swarm', 'config-backup-001.json'),
					'{}',
				);

				// Write a plan WITH in-progress phase so allDone=false
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				await handleCloseCommand(testDir, []);

				// Non-backup file should still exist
				expect(
					existsSync(path.join(testDir, '.swarm', 'some-other-file.json')),
				).toBe(true);
				// Backup file should be gone
				expect(
					existsSync(path.join(testDir, '.swarm', 'config-backup-001.json')),
				).toBe(false);
			});

			it('CB3: No backup files present → no error, still succeeds', async () => {
				// No backup files, just a plan WITH in-progress phase
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				const result = await handleCloseCommand(testDir, []);

				expect(result).toContain('finalized');
			});
		});

		// =====================================================================
		// Group: Lesson injection (Fix 5)
		// Note: Lesson injection happens BEFORE the early return check (lines 119-146 vs 58-75),
		// so it works even with empty phases array. But using in_progress phase for consistency.
		// =====================================================================

		describe('Lesson injection (Fix 5)', () => {
			it('LN1: close-lessons.md with two lessons → curateAndStoreSwarm called with those lessons', async () => {
				// Create lessons file
				writeFileSync(
					path.join(testDir, '.swarm', 'close-lessons.md'),
					'Lesson one about testing\nLesson two about deployment',
				);

				// Write a plan WITH in-progress phase
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test Project',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				await handleCloseCommand(testDir, []);

				// curateAndStoreSwarm should have been called with the lessons
				expect(mockCurateAndStoreSwarm).toHaveBeenCalledWith(
					['Lesson one about testing', 'Lesson two about deployment'],
					'Test Project',
					{ phase_number: 0 },
					testDir,
					expect.any(Object),
				);
			});

			it('LN2: close-lessons.md absent → curateAndStoreSwarm called with []', async () => {
				// No lessons file - just a plan with in-progress phase
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test Project',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				await handleCloseCommand(testDir, []);

				// curateAndStoreSwarm should have been called with empty array
				expect(mockCurateAndStoreSwarm).toHaveBeenCalledWith(
					[],
					'Test Project',
					{ phase_number: 0 },
					testDir,
					expect.any(Object),
				);
			});

			it('LN3: close-lessons.md with comment lines → comment lines filtered out, only real lessons passed', async () => {
				// Create lessons file with comments
				writeFileSync(
					path.join(testDir, '.swarm', 'close-lessons.md'),
					'# This is a comment\nReal lesson about code review\n# Another comment\nAnother real lesson',
				);

				// Write a plan with in-progress phase
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test Project',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				await handleCloseCommand(testDir, []);

				// Only non-comment lines should be passed
				expect(mockCurateAndStoreSwarm).toHaveBeenCalledWith(
					['Real lesson about code review', 'Another real lesson'],
					'Test Project',
					{ phase_number: 0 },
					testDir,
					expect.any(Object),
				);
			});

			it('LN4: close-lessons.md → file deleted after processing', async () => {
				// Create lessons file
				writeFileSync(
					path.join(testDir, '.swarm', 'close-lessons.md'),
					'Some lesson',
				);

				// Write a plan with in-progress phase
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test Project',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				await handleCloseCommand(testDir, []);

				// Lessons file should be deleted
				expect(
					existsSync(path.join(testDir, '.swarm', 'close-lessons.md')),
				).toBe(false);
			});

			it("LN5: curateAndStoreSwarm throws → lessons file is NOT deleted (so lessons aren't lost)", async () => {
				mockCurateAndStoreSwarm.mockImplementationOnce(async () => {
					throw new Error('curation failed');
				});

				// Create lessons file
				writeFileSync(
					path.join(testDir, '.swarm', 'close-lessons.md'),
					'Lesson that should be preserved',
				);

				// Write a plan with in-progress phase
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test Project',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				const result = await handleCloseCommand(testDir, []);

				// Command should still succeed despite curation failure (non-blocking)
				expect(result).toContain('finalized');
				// Lessons file should still exist because curation threw before deletion
				expect(
					existsSync(path.join(testDir, '.swarm', 'close-lessons.md')),
				).toBe(true);
				// Previously silent — curation failure must now surface as a warning.
				expect(result).toContain('Warnings');
				expect(result).toContain('Lessons curation failed');
				expect(result).toContain('curation failed');
			});

			it('LN6: Retro evidence with lessons → curateAndStoreSwarm receives merged explicit + retro lessons', async () => {
				// Create explicit lessons file
				writeFileSync(
					path.join(testDir, '.swarm', 'close-lessons.md'),
					'Explicit lesson about testing',
				);

				// Create retro evidence directory with lessons
				const evidenceDir = path.join(testDir, '.swarm', 'evidence', 'retro-1');
				mkdirSync(evidenceDir, { recursive: true });
				writeFileSync(
					path.join(evidenceDir, 'evidence.json'),
					JSON.stringify({
						entries: [
							{
								lessons_learned: [
									'Retro lesson about deployment',
									'Retro lesson about code review',
								],
							},
						],
					}),
				);

				// Write a plan with in-progress phase
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test Project',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				await handleCloseCommand(testDir, []);

				// Both explicit and retro lessons should be passed (merged, deduplicated)
				expect(mockCurateAndStoreSwarm).toHaveBeenCalledWith(
					[
						'Explicit lesson about testing',
						'Retro lesson about deployment',
						'Retro lesson about code review',
					],
					'Test Project',
					{ phase_number: 0 },
					testDir,
					expect.any(Object),
				);
			});

			it('LN7: Retro evidence without lessons + explicit lessons → curateAndStoreSwarm receives only explicit lessons', async () => {
				// Create explicit lessons file
				writeFileSync(
					path.join(testDir, '.swarm', 'close-lessons.md'),
					'Explicit lesson only',
				);

				// Create retro evidence directory with NO lessons_learned
				const evidenceDir = path.join(testDir, '.swarm', 'evidence', 'retro-1');
				mkdirSync(evidenceDir, { recursive: true });
				writeFileSync(
					path.join(evidenceDir, 'evidence.json'),
					JSON.stringify({
						entries: [
							{
								phase: 1,
								summary: 'Some retro without lessons',
							},
						],
					}),
				);

				// Write a plan with in-progress phase
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test Project',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				await handleCloseCommand(testDir, []);

				// Only explicit lessons should be passed (retro had none)
				expect(mockCurateAndStoreSwarm).toHaveBeenCalledWith(
					['Explicit lesson only'],
					'Test Project',
					{ phase_number: 0 },
					testDir,
					expect.any(Object),
				);
			});

			it('LN8: Multiple retro evidence bundles → all lessons extracted and deduplicated', async () => {
				// Create explicit lessons
				writeFileSync(
					path.join(testDir, '.swarm', 'close-lessons.md'),
					'Explicit lesson',
				);

				// Create first retro evidence bundle
				const evidenceDir1 = path.join(
					testDir,
					'.swarm',
					'evidence',
					'retro-1',
				);
				mkdirSync(evidenceDir1, { recursive: true });
				writeFileSync(
					path.join(evidenceDir1, 'evidence.json'),
					JSON.stringify({
						entries: [{ lessons_learned: ['Retro lesson 1'] }],
					}),
				);

				// Create second retro evidence bundle
				const evidenceDir2 = path.join(
					testDir,
					'.swarm',
					'evidence',
					'retro-2',
				);
				mkdirSync(evidenceDir2, { recursive: true });
				writeFileSync(
					path.join(evidenceDir2, 'evidence.json'),
					JSON.stringify({
						entries: [{ lessons_learned: ['Retro lesson 2'] }],
					}),
				);

				// Write a plan with in-progress phase
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test Project',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				await handleCloseCommand(testDir, []);

				// All lessons from both bundles plus explicit should be present
				expect(mockCurateAndStoreSwarm).toHaveBeenCalledWith(
					['Explicit lesson', 'Retro lesson 1', 'Retro lesson 2'],
					'Test Project',
					{ phase_number: 0 },
					testDir,
					expect.any(Object),
				);
			});

			it('LN9: Retro lesson duplicates explicit lesson → deduplicated to one', async () => {
				// Create explicit lessons with a specific lesson
				writeFileSync(
					path.join(testDir, '.swarm', 'close-lessons.md'),
					'Shared lesson',
				);

				// Create retro evidence with the same lesson
				const evidenceDir = path.join(testDir, '.swarm', 'evidence', 'retro-1');
				mkdirSync(evidenceDir, { recursive: true });
				writeFileSync(
					path.join(evidenceDir, 'evidence.json'),
					JSON.stringify({
						entries: [{ lessons_learned: ['Shared lesson'] }],
					}),
				);

				// Write a plan with in-progress phase
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test Project',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				await handleCloseCommand(testDir, []);

				// Shared lesson should appear only once (deduplicated via Set)
				expect(mockCurateAndStoreSwarm).toHaveBeenCalledWith(
					['Shared lesson'],
					'Test Project',
					{ phase_number: 0 },
					testDir,
					expect.any(Object),
				);
			});
		});

		// =====================================================================
		// Group: Session state reset (Issue 1 C1)
		// =====================================================================

		describe('Session state reset', () => {
			it('invokes resetSwarmState exactly once during close', async () => {
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Reset Test',
						phases: [
							{
								id: 1,
								name: 'P1',
								status: 'in_progress',
								tasks: [{ id: '1.1', status: 'in_progress' }],
							},
						],
					}),
				);

				expect(resetSwarmStateCallCount).toBe(0);
				await handleCloseCommand(testDir, []);
				expect(resetSwarmStateCallCount).toBe(1);
			});

			it('clears stale per-session collections via resetSwarmState', async () => {
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Reset Test',
						phases: [
							{
								id: 1,
								name: 'P1',
								status: 'in_progress',
								tasks: [],
							},
						],
					}),
				);

				// Pre-seed state collections with stale entries from prior sessions.
				expect(mockSwarmState.activeToolCalls.size).toBe(1);
				expect(mockSwarmState.agentSessions.size).toBe(1);

				await handleCloseCommand(testDir, []);

				// Both collections must be cleared — previously only agentSessions
				// and delegationChains were cleared, leaving activeToolCalls (and
				// others) leaking across sessions.
				expect(mockSwarmState.activeToolCalls.size).toBe(0);
				expect(mockSwarmState.agentSessions.size).toBe(0);
			});

			it('preserves opencodeClient and fullAutoEnabledInConfig across reset', async () => {
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Reset Test',
						phases: [
							{
								id: 1,
								name: 'P1',
								status: 'in_progress',
								tasks: [],
							},
						],
					}),
				);

				// The mock reset nulls these fields; close.ts must save and
				// restore them because these are plugin-init singletons with no
				// re-init path inside a plugin lifetime.
				await handleCloseCommand(testDir, []);

				expect(mockSwarmState.opencodeClient).toEqual({
					sentinel: 'preserved-client',
				});
				expect(mockSwarmState.fullAutoEnabledInConfig).toBe(true);
				// Curator agent names are populated once at plugin init in
				// src/index.ts and must survive session reset or curator-llm-factory
				// silently breaks until plugin reload.
				expect(mockSwarmState.curatorInitAgentNames).toEqual([
					'curator_init',
					'swarm2_curator_init',
				]);
				expect(mockSwarmState.curatorPhaseAgentNames).toEqual([
					'curator_phase',
				]);
				expect(mockSwarmState.skillImproverAgentNames).toEqual([
					'skill_improver',
					'swarm2_skill_improver',
				]);
			});
		});

		// =====================================================================
		// Group: Skill review hint and opt-in review (Issue #802)
		// =====================================================================

		describe('Skill review hint and opt-in review (Issue #802)', () => {
			it('shows skill compilation hint when close curation stores knowledge entries', async () => {
				mockCurateAndStoreSwarm.mockImplementationOnce(async () => ({
					stored: 2,
					skipped: 0,
					rejected: 0,
				}));
				writeFileSync(
					path.join(testDir, '.swarm', 'close-lessons.md'),
					'Capture recurring test setup as a reusable skill\nCapture release note checklist',
				);
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Skill Hint Test',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				const result = await handleCloseCommand(testDir, []);
				const summary = readFileSync(
					path.join(testDir, '.swarm', 'close-summary.md'),
					'utf-8',
				);

				expect(result).toContain('2 knowledge entries created this session');
				expect(result).toContain('skill_improve');
				expect(result).toContain('skill_generate');
				expect(summary).toContain('2 knowledge entries created this session');
			});

			it('does not show skill compilation hint when no knowledge entries were created', async () => {
				mockCurateAndStoreSwarm.mockImplementationOnce(async () => ({
					stored: 0,
					skipped: 0,
					rejected: 0,
				}));

				const result = await handleCloseCommand(testDir, []);
				const summary = readFileSync(
					path.join(testDir, '.swarm', 'close-summary.md'),
					'utf-8',
				);

				expect(result).not.toContain('knowledge entries created this session');
				expect(result).not.toContain('skill_improve');
				expect(summary).not.toContain('knowledge entries created this session');
			});

			it('counts knowledge entries at and after session start while ignoring older and invalid timestamps', async () => {
				mockSwarmState.agentSessions.set('session-1', {
					lastAgentEventTime: Date.parse('2026-05-11T10:00:00.000Z'),
				});
				mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
				writeFileSync(
					path.join(testDir, '.swarm', 'knowledge.jsonl'),
					[
						{
							id: 'before',
							lesson: 'Old lesson',
							category: 'process',
							created_at: '2026-05-11T09:59:59.999Z',
						},
						{
							id: 'equal',
							lesson: 'Boundary lesson',
							category: 'process',
							created_at: '2026-05-11T10:00:00.000Z',
						},
						{
							id: 'after',
							lesson: 'Fresh lesson',
							category: 'process',
							created_at: '2026-05-11T10:01:00.000Z',
						},
						{
							id: 'invalid',
							lesson: 'Invalid timestamp lesson',
							category: 'process',
							created_at: 'not-a-date',
						},
					]
						.map((entry) => JSON.stringify(entry))
						.join('\n'),
				);

				const result = await handleCloseCommand(testDir, []);

				expect(result).toContain('2 knowledge entries created this session');
			});

			it('count helper falls back when session start is missing or invalid', () => {
				const entries = [
					{ created_at: '2026-05-11T10:00:00.000Z' },
					{ created_at: '2026-05-11T10:01:00.000Z' },
				];

				expect(
					_internals.countSessionKnowledgeEntries(entries, undefined, 4),
				).toBe(4);
				expect(
					_internals.countSessionKnowledgeEntries(entries, 'not-a-date', 3),
				).toBe(3);
			});

			it('does not call skill improver on the default close path', async () => {
				await handleCloseCommand(testDir, []);

				expect(mockRunSkillImprover).not.toHaveBeenCalled();
			});

			it('runs skill improver in proposal mode when --skill-review is passed', async () => {
				const result = await handleCloseCommand(testDir, ['--skill-review'], {
					sessionID: 'session-802',
				});

				expect(mockRunSkillImprover).toHaveBeenCalledTimes(1);
				expect(mockRunSkillImprover).toHaveBeenCalledWith(
					expect.objectContaining({
						directory: testDir,
						targets: ['skills', 'knowledge'],
						mode: 'proposal',
						sessionId: 'session-802',
					}),
				);
				expect(result).toContain('Skill review proposal generated');
				expect(result).toContain('proposal.md');
			});

			it('reports skill improver refusal without blocking close', async () => {
				mockRunSkillImprover.mockImplementationOnce(async () => ({
					ran: false,
					reason: 'quota exhausted',
					quota: { date: '2026-05-11', calls_used: 10, max_calls: 10 },
				}));

				const result = await handleCloseCommand(testDir, ['--skill-review']);

				expect(result).toContain('finalized');
				expect(result).toContain('Skill review skipped: quota exhausted');
			});

			it('reports skill improver throws without blocking close', async () => {
				mockRunSkillImprover.mockImplementationOnce(async () => {
					throw new Error('service exploded');
				});

				const result = await handleCloseCommand(testDir, ['--skill-review']);

				expect(result).toContain('finalized');
				expect(result).toContain('Skill review failed: service exploded');
			});

			it('reports skill improver timeout without blocking close', async () => {
				forceSkillReviewTimeout = true;

				const result = await handleCloseCommand(testDir, ['--skill-review'], {
					skillReviewTimeoutMs: 1,
				});

				expect(result).toContain('finalized');
				expect(result).toContain('skill_review exceeded');
				expect(observedSkillReviewSignal).toBeDefined();
				expect(observedSkillReviewAborted).toBe(true);
			});

			it('reports skill-review config load failures without blocking close', async () => {
				forceSkillReviewConfigError = true;

				const result = await handleCloseCommand(testDir, ['--skill-review']);

				expect(result).toContain('finalized');
				expect(result).toContain('Skill review failed: bad config');
			});
		});

		// =====================================================================
		// Group: Git branch pruning (Fix 4)
		// =====================================================================

		describe('Git branch pruning (Fix 4)', () => {
			it('BP1: --prune-branches NOT passed → succeeds even in non-git dir (git not invoked, no crash)', async () => {
				// No git repo, no --prune-branches flag
				const result = await handleCloseCommand(testDir, []);

				expect(result).toContain('finalized');
			});

			it('BP2: --prune-branches passed in non-git dir → succeeds (non-blocking failure)', async () => {
				// No git repo but --prune-branches flag passed
				const result = await handleCloseCommand(testDir, ['--prune-branches']);

				// Should still succeed (non-blocking failure)
				expect(result).toContain('finalized');
			});

			it('BP3: --prune-branches passed in real git repo → succeeds with no gone branches to prune', async () => {
				// Create a real git repo (disable signing to avoid environment-specific failures)
				const { execSync } = await import('node:child_process');
				execSync('git init', { cwd: testDir, stdio: 'pipe' });
				execSync('git config user.email "test@test.com"', {
					cwd: testDir,
					stdio: 'pipe',
				});
				execSync('git config user.name "Test"', {
					cwd: testDir,
					stdio: 'pipe',
				});
				execSync('git config commit.gpgsign false', {
					cwd: testDir,
					stdio: 'pipe',
				});
				execSync('git commit --allow-empty -m "init"', {
					cwd: testDir,
					stdio: 'pipe',
				});

				// Write plan.json WITH in-progress phase so the command has something to work with
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify({
						title: 'Test',
						phases: [
							{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] },
						],
					}),
				);

				const result = await handleCloseCommand(testDir, ['--prune-branches']);

				expect(result).toContain('finalized');
				// No branches pruned since none are gone
			});
		});

		// =====================================================================
		// Group: allDone path now runs cleanup (Fix P1)
		// =====================================================================

		describe('allDone path now runs cleanup (Fix P1)', () => {
			it('PF_P1_A: Plan with all phases complete → archiveEvidence is still called (cleanup runs)', async () => {
				const planData = {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'complete',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				};
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify(planData),
				);

				await handleCloseCommand(testDir, []);

				// Cleanup runs even when plan is already done
				expect(mockArchiveEvidence).toHaveBeenCalledTimes(1);
			});

			it('PF_P1_B: Plan with all phases complete → executeWriteRetro is NOT called (retros skipped)', async () => {
				const planData = {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'complete',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				};
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify(planData),
				);

				await handleCloseCommand(testDir, []);

				// No retros for already-complete phases
				expect(mockExecuteWriteRetro).not.toHaveBeenCalled();
			});

			it('PF_P1_C: Plan with all phases complete → result contains "Plan was already complete"', async () => {
				const planData = {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'complete',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				};
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify(planData),
				);

				const result = await handleCloseCommand(testDir, []);

				expect(result).toContain('terminal state');
			});

			it('PF_P1_D: Plan with all phases complete → flushPendingSnapshot is NOT called', async () => {
				const planData = {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'complete',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				};
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify(planData),
				);

				await handleCloseCommand(testDir, []);

				// State is cleared, not flushed
				expect(mockFlushPendingSnapshot).not.toHaveBeenCalled();
			});
		});

		// =====================================================================
		// Group: Wrong directory detection (Fix P2)
		// =====================================================================

		describe('Wrong directory detection (Fix P2)', () => {
			it('P2_A: missing .swarm/ directory returns error', async () => {
				// Create a temp dir WITHOUT .swarm/ directory
				const emptyDir = mkdtempSync(path.join(os.tmpdir(), 'close-no-swarm-'));
				try {
					const result = await handleCloseCommand(emptyDir, []);

					expect(result).toContain('No .swarm/ directory found');
				} finally {
					rmSync(emptyDir, { recursive: true, force: true });
				}
			});

			it('P2_B: .swarm/ exists but no plan.json → plan-free success (existing behavior preserved)', async () => {
				// .swarm/ directory exists but plan.json is absent
				// (beforeEach already creates .swarm/session, just don't create plan.json)
				const result = await handleCloseCommand(testDir, []);

				// Should succeed as plan-free session
				expect(result).toContain('finalized');
				expect(result).not.toContain('Failed to read plan.json');
			});
		});

		// =====================================================================
		// Group: Additional GPT 5.4 coverage tests
		// =====================================================================

		describe('Additional GPT 5.4 coverage', () => {
			it('Test A: executeWriteRetro throws → cleanup still runs, warning in result', async () => {
				// Setup: mock executeWriteRetro to throw
				mockExecuteWriteRetro.mockImplementationOnce(async () => {
					throw new Error('retro write failed');
				});

				// Create a plan with one in-progress phase so the retro loop runs
				const planData = {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'in_progress',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				};
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify(planData),
				);

				const result = await handleCloseCommand(testDir, []);

				// Should still return "finalized" (not rethrow)
				expect(result).toContain('finalized');
				// Cleanup ran despite the error
				expect(mockArchiveEvidence).toHaveBeenCalledTimes(1);
				expect(mockFlushPendingSnapshot).not.toHaveBeenCalled();
				// Warning mentions the thrown error
				expect(result).toContain('Warnings');
				expect(result).toContain('retro write failed');
			});

			it('Test B: close-summary.md for already-terminal plan has correct actions (no false retro/mutation lines)', async () => {
				// Create a plan with one complete phase (already terminal)
				const planData = {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'complete',
							tasks: [{ id: '1.1', status: 'complete' }],
						},
					],
				};
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify(planData),
				);

				await handleCloseCommand(testDir, []);

				const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
				expect(existsSync(summaryPath)).toBe(true);

				const summary = readFileSync(summaryPath, 'utf-8');

				// Does NOT contain "Wrote retrospectives" (retros were skipped for terminal plan)
				expect(summary).not.toContain('Wrote retrospectives');
				// Does NOT contain "Set non-completed phases" (mutation was skipped)
				expect(summary).not.toContain('Set non-completed phases');
				// DOES contain archive result
				expect(summary).toContain('Archived');
				// DOES contain "Reset context.md"
				expect(summary).toContain('Reset context.md');
			});

			it('Test C: close-summary.md for plan-free session shows "No plan — ad-hoc session"', async () => {
				// Run without plan.json
				await handleCloseCommand(testDir, []);

				const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
				expect(existsSync(summaryPath)).toBe(true);

				const summary = readFileSync(summaryPath, 'utf-8');

				// Summary contains "No plan — ad-hoc session"
				expect(summary).toContain('_No plan — ad-hoc session_');
				// Does NOT contain "Set non-completed phases"
				expect(summary).not.toContain('Set non-completed phases');
			});

			it('Test D: blocked plan → return message says "terminal state" not "already complete"', async () => {
				// Create a plan with all phases in blocked status
				const planData = {
					title: 'Test Project',
					phases: [
						{
							id: 1,
							name: 'Phase 1',
							status: 'blocked',
							tasks: [{ id: '1.1', status: 'blocked' }],
						},
						{
							id: 2,
							name: 'Phase 2',
							status: 'blocked',
							tasks: [{ id: '2.1', status: 'blocked' }],
						},
					],
				};
				writeFileSync(
					path.join(testDir, '.swarm', 'plan.json'),
					JSON.stringify(planData),
				);

				const result = await handleCloseCommand(testDir, []);

				// Contains "terminal state" (not "already complete")
				expect(result).toContain('terminal state');
				expect(result).not.toContain('Plan was already complete');
			});
		});
	});
});
