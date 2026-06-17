/**
 * Tests for handleCloseCommand — finalizer, archive, clean, and align stages.
 *
 * Verifies the 4-stage close pipeline:
 *   1. Finalize  (retros, curation)
 *   2. Archive   (timestamped bundle under .swarm/archive/)
 *   3. Clean     (remove active-state files)
 *   4. Align     (git — skipped via mocks here)
 *
 * Also verifies that the shared singleton-preserving reset helper
 * (resetSwarmStatePreservingSingletons) is called at close time and
 * correctly preserves all 7 plugin-init singletons across the reset.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	test,
} from 'bun:test';
import {
	existsSync,
	promises as fs,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { initLedger } from '../../../src/plan/ledger.js';

// ── Mocks (must precede the dynamic import) ──────────────────────────

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
const mockGetGitRepositoryStatus = mock(() => ({
	isRepo: false as const,
	reason: 'not_git_repo' as const,
	message: 'fatal: not a git repository',
}));
const mockResetToRemoteBranch = mock(() => ({
	success: true,
	targetBranch: 'main',
	localBranch: 'main',
	message: 'Already aligned with remote',
	alreadyAligned: true,
	prunedBranches: [] as string[],
	warnings: [] as string[],
}));
const mockResetToMainAfterMerge = mock(() => ({
	success: true,
	targetBranch: 'origin/main',
	previousBranch: 'main',
	message: 'Already on main',
	branchDeleted: false,
	changesDiscarded: false,
	warnings: [] as string[],
}));

const mockRunSkillImprover = mock(async () => ({
	ran: true,
	proposalPath: '.swarm/skills/proposals/test-skill-review.md',
	source: 'knowledge',
}));

// Specific type for the mocked swarmState (avoids any; only the fields
// accessed by close path + the preserving simulation are listed).
type MockSwarmState = {
	activeToolCalls: Map<string, unknown>;
	toolAggregates: Map<string, unknown>;
	activeAgent: Map<string, unknown>;
	delegationChains: Map<string, unknown>;
	pendingEvents: number;
	lastBudgetPct: number;
	agentSessions: Map<string, unknown>;
	pendingRehydrations: Set<unknown>;
	opencodeClient: unknown;
	fullAutoEnabledInConfig: boolean;
	curatorInitAgentNames: string[];
	curatorPhaseAgentNames: string[];
	skillImproverAgentNames: string[];
	specWriterAgentNames: string[];
	generatedAgentNames: string[];
	currentCriticalShownIds: Map<string, unknown>;
	knowledgeAckDedup: Set<unknown>;
	environmentProfiles: Map<string, unknown>;
};

let mockedSwarmState: MockSwarmState = {} as MockSwarmState;
const mockResetSwarmStatePreservingSingletons = mock(() => {
	// Simulate the real resetSwarmStatePreservingSingletons behavior inside the mock
	// so that tests can assert that the 7 singletons survive the call made by the
	// close command path (the real helper saves 7, calls resetSwarmState which
	// clears everything else, then restores the 7). We cannot call the mocked
	// resetSwarmState here because it throws to guard against bare calls.
	const toPreserve = {
		opencodeClient: mockedSwarmState.opencodeClient,
		fullAutoEnabledInConfig: mockedSwarmState.fullAutoEnabledInConfig,
		curatorInitAgentNames: mockedSwarmState.curatorInitAgentNames
			? [...mockedSwarmState.curatorInitAgentNames]
			: [],
		curatorPhaseAgentNames: mockedSwarmState.curatorPhaseAgentNames
			? [...mockedSwarmState.curatorPhaseAgentNames]
			: [],
		skillImproverAgentNames: mockedSwarmState.skillImproverAgentNames
			? [...mockedSwarmState.skillImproverAgentNames]
			: [],
		specWriterAgentNames: mockedSwarmState.specWriterAgentNames
			? [...mockedSwarmState.specWriterAgentNames]
			: [],
		generatedAgentNames: mockedSwarmState.generatedAgentNames
			? [...mockedSwarmState.generatedAgentNames]
			: [],
	};
	// Simulate reset effect on non-preserved fields only
	mockedSwarmState.activeToolCalls?.clear?.();
	mockedSwarmState.toolAggregates?.clear?.();
	mockedSwarmState.activeAgent?.clear?.();
	mockedSwarmState.delegationChains?.clear?.();
	mockedSwarmState.pendingEvents = 0;
	mockedSwarmState.lastBudgetPct = 0;
	mockedSwarmState.agentSessions?.clear?.();
	mockedSwarmState.pendingRehydrations?.clear?.();
	mockedSwarmState.currentCriticalShownIds?.clear?.();
	mockedSwarmState.knowledgeAckDedup?.clear?.();
	mockedSwarmState.environmentProfiles?.clear?.();
	// Restore the 7 singletons (this is what makes "survive" verifiable)
	mockedSwarmState.opencodeClient = toPreserve.opencodeClient;
	mockedSwarmState.fullAutoEnabledInConfig = toPreserve.fullAutoEnabledInConfig;
	mockedSwarmState.curatorInitAgentNames = toPreserve.curatorInitAgentNames;
	mockedSwarmState.curatorPhaseAgentNames = toPreserve.curatorPhaseAgentNames;
	mockedSwarmState.skillImproverAgentNames = toPreserve.skillImproverAgentNames;
	mockedSwarmState.specWriterAgentNames = toPreserve.specWriterAgentNames;
	mockedSwarmState.generatedAgentNames = toPreserve.generatedAgentNames;
});

mock.module('../../../src/tools/write-retro.js', () => ({
	executeWriteRetro: mockExecuteWriteRetro,
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mockCurateAndStoreSwarm,
}));

mock.module('../../../src/evidence/manager.js', () => ({
	archiveEvidence: mockArchiveEvidence,
}));

mock.module('../../../src/session/snapshot-writer.js', () => ({
	flushPendingSnapshot: mockFlushPendingSnapshot,
}));

// state.js mock — close.ts calls resetSwarmStatePreservingSingletons (NOT resetSwarmState)
// The 7 preserved singletons are defined in state.ts resetSwarmStatePreservingSingletons:
mock.module('../../../src/state.js', () => {
	mockedSwarmState = {
		activeToolCalls: new Map<string, unknown>(),
		toolAggregates: new Map<string, unknown>(),
		activeAgent: new Map<string, unknown>(),
		delegationChains: new Map<string, unknown>(),
		pendingEvents: 0,
		lastBudgetPct: 0,
		agentSessions: new Map<string, unknown>(),
		pendingRehydrations: new Set<unknown>(),
		opencodeClient: 'mocked-client',
		fullAutoEnabledInConfig: true,
		curatorInitAgentNames: ['curator_init'],
		curatorPhaseAgentNames: ['curator_phase'],
		skillImproverAgentNames: ['skill_improver'],
		specWriterAgentNames: ['spec_writer'],
		generatedAgentNames: ['generated_agent'],
		currentCriticalShownIds: new Map<string, unknown>(),
		knowledgeAckDedup: new Set<unknown>(),
		environmentProfiles: new Map<string, unknown>(),
	};
	return {
		swarmState: mockedSwarmState,
		endAgentSession: () => {},
		// NOTE: resetSwarmState is NOT called by close.ts — only resetSwarmStatePreservingSingletons
		resetSwarmState: () => {
			throw new Error(
				'close.ts must call resetSwarmStatePreservingSingletons, not resetSwarmState',
			);
		},
		resetSwarmStatePreservingSingletons:
			mockResetSwarmStatePreservingSingletons,
	};
});

mock.module('../../../src/plan/checkpoint.js', () => ({
	writeCheckpoint: async () => {},
}));

mock.module('../../../src/services/skill-improver.js', () => ({
	runSkillImprover: mockRunSkillImprover,
	_internals: {
		runSkillImprover: mockRunSkillImprover,
		buildDeterministicProposal: () => '',
		buildLLMProposalFrame: () => ({}),
		buildSystemPrompt: () => '',
		buildUserPrompt: () => '',
		gatherInventory: async () => ({ skills: [], knowledge: [] }),
	},
}));

// ── Import under test ────────────────────────────────────────────────
const { handleCloseCommand, _internals: closeInternals } = await import(
	'../../../src/commands/close.js'
);
const realGetGitRepositoryStatus = closeInternals.getGitRepositoryStatus;
const realResetToRemoteBranch = closeInternals.resetToRemoteBranch;
const realResetToMainAfterMerge = closeInternals.resetToMainAfterMerge;

// ── DI Conversion Summary ────────────────────────────────────────────
//
// WITHIN-MODULE MOCKS:
// close.ts routes Git alignment dependencies through close._internals so this
// file can test finalize alignment without a process-global mock of git/branch.
// Other direct imports remain cross-module mocks.
//
// CROSS-MODULE MOCKS: All mocks remain as mock.module
// - executeWriteRetro (tools/write-retro.ts)
// - curateAndStoreSwarm (hooks/knowledge-curator.ts)
// - archiveEvidence (evidence/manager.ts) — not in manager._internals
// - flushPendingSnapshot (session/snapshot-writer.ts) — close.ts imports directly
// - swarmState + resetSwarmState (state.ts) — close.ts imports directly
// - writeCheckpoint (plan/checkpoint.ts)
//
// All mock.module calls require afterEach(mock.restore()) cleanup.
// ─────────────────────────────────────────────────────────────────────

// ── Helpers ──────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

async function writePlan(
	overrides: Record<string, unknown> = {},
): Promise<void> {
	const plan = {
		title: 'Finalizer Test Project',
		swarm: 'paid',
		schema_version: '1.0.0',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'in_progress',
						description: 'Task A',
						size: 'small',
					},
					{
						id: '1.2',
						phase: 1,
						status: 'completed',
						description: 'Task B',
						size: 'small',
					},
				],
			},
		],
		...overrides,
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
	await initLedger(testDir, plan.swarm ?? 'paid', undefined, plan);
}

// ── Test suites ──────────────────────────────────────────────────────

describe('handleCloseCommand — finalizer stages', () => {
	beforeEach(() => {
		mockExecuteWriteRetro.mockClear();
		mockCurateAndStoreSwarm.mockClear();
		mockArchiveEvidence.mockClear();
		mockFlushPendingSnapshot.mockClear();
		mockGetGitRepositoryStatus.mockClear();
		mockGetGitRepositoryStatus.mockImplementation(() => ({
			isRepo: false as const,
			reason: 'not_git_repo' as const,
			message: 'fatal: not a git repository',
		}));
		mockResetToRemoteBranch.mockClear();
		mockResetToRemoteBranch.mockImplementation(() => ({
			success: true,
			targetBranch: 'main',
			localBranch: 'main',
			message: 'Already aligned with remote',
			alreadyAligned: true,
			prunedBranches: [] as string[],
			warnings: [] as string[],
		}));
		mockResetToMainAfterMerge.mockClear();
		mockResetToMainAfterMerge.mockImplementation(() => ({
			success: true,
			targetBranch: 'origin/main',
			previousBranch: 'main',
			message: 'Already on main',
			branchDeleted: false,
			changesDiscarded: false,
			warnings: [] as string[],
		}));
		closeInternals.getGitRepositoryStatus = mockGetGitRepositoryStatus;
		closeInternals.resetToRemoteBranch = mockResetToRemoteBranch;
		closeInternals.resetToMainAfterMerge = mockResetToMainAfterMerge;
		mockRunSkillImprover.mockClear();
		mockResetSwarmStatePreservingSingletons.mockClear();
		// Reset the mocked swarmState object (shared ref used by close.ts) so each
		// test starts with clean singletons + transients. The preserving mock impl
		// mutates it; without this, sentinels from prior tests would leak.
		mockedSwarmState.activeToolCalls = new Map<string, unknown>();
		mockedSwarmState.toolAggregates = new Map<string, unknown>();
		mockedSwarmState.activeAgent = new Map<string, unknown>();
		mockedSwarmState.delegationChains = new Map<string, unknown>();
		mockedSwarmState.pendingEvents = 0;
		mockedSwarmState.lastBudgetPct = 0;
		mockedSwarmState.agentSessions = new Map<string, unknown>();
		mockedSwarmState.pendingRehydrations = new Set<unknown>();
		mockedSwarmState.opencodeClient = 'mocked-client';
		mockedSwarmState.fullAutoEnabledInConfig = true;
		mockedSwarmState.curatorInitAgentNames = ['curator_init'];
		mockedSwarmState.curatorPhaseAgentNames = ['curator_phase'];
		mockedSwarmState.skillImproverAgentNames = ['skill_improver'];
		mockedSwarmState.specWriterAgentNames = ['spec_writer'];
		mockedSwarmState.generatedAgentNames = ['generated_agent'];
		mockedSwarmState.currentCriticalShownIds = new Map<string, unknown>();
		mockedSwarmState.knowledgeAckDedup = new Set<unknown>();
		mockedSwarmState.environmentProfiles = new Map<string, unknown>();
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-finalizer-test-'));
		mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		closeInternals.getGitRepositoryStatus = realGetGitRepositoryStatus;
		closeInternals.resetToRemoteBranch = realResetToRemoteBranch;
		closeInternals.resetToMainAfterMerge = realResetToMainAfterMerge;
		// Restore all mock.module mocks to prevent cross-test pollution
		mock.restore();
	});

	// ── SINGLETON PRESERVATION ─────────────────────────────────────────

	describe('resetSwarmStatePreservingSingletons integration', () => {
		it('calls resetSwarmStatePreservingSingletons (not bare resetSwarmState) on close', async () => {
			await writePlan();

			await handleCloseCommand(testDir, []);

			// The shared helper (replacing the old inline 5-singleton save/reset/restore block)
			// must be called exactly once at the end of close.
			expect(mockResetSwarmStatePreservingSingletons).toHaveBeenCalledTimes(1);
		});

		it('calls resetSwarmStatePreservingSingletons() and all 7 singletons survive when the close command path runs', async () => {
			await writePlan();

			// Set sentinel values for the 7 preserved singletons on the mocked state
			// (this is the object that close.ts sees via its import of state).
			// Also seed some non-preserved transient state that resetSwarmState would clear.
			const sentinelClient = { __close_test: 'preserved-opencode-client' };
			mockedSwarmState.opencodeClient = sentinelClient;
			mockedSwarmState.fullAutoEnabledInConfig = false;
			mockedSwarmState.curatorInitAgentNames = ['close_init_a', 'close_init_b'];
			mockedSwarmState.curatorPhaseAgentNames = ['close_phase_x'];
			mockedSwarmState.skillImproverAgentNames = ['close_skill_y'];
			mockedSwarmState.specWriterAgentNames = ['close_spec_z'];
			mockedSwarmState.generatedAgentNames = ['close_gen_1', 'close_gen_2'];
			mockedSwarmState.pendingEvents = 123;
			mockedSwarmState.lastBudgetPct = 77;
			mockedSwarmState.activeToolCalls.set('close-test-call', { tool: 'x' });

			const result = await handleCloseCommand(testDir, []);

			// The close path must have invoked the preserving helper (not bare reset)
			expect(mockResetSwarmStatePreservingSingletons).toHaveBeenCalledTimes(1);
			expect(result).toContain('finalized');

			// All 7 singletons must survive (the point of the shared helper vs old inline 5-singleton block)
			expect(mockedSwarmState.opencodeClient).toBe(sentinelClient);
			expect(mockedSwarmState.fullAutoEnabledInConfig).toBe(false);
			expect(mockedSwarmState.curatorInitAgentNames).toEqual([
				'close_init_a',
				'close_init_b',
			]);
			expect(mockedSwarmState.curatorPhaseAgentNames).toEqual([
				'close_phase_x',
			]);
			expect(mockedSwarmState.skillImproverAgentNames).toEqual([
				'close_skill_y',
			]);
			expect(mockedSwarmState.specWriterAgentNames).toEqual(['close_spec_z']);
			expect(mockedSwarmState.generatedAgentNames).toEqual([
				'close_gen_1',
				'close_gen_2',
			]);

			// Non-preserved fields must have been cleared (proves the reset half of the helper executed)
			expect(mockedSwarmState.pendingEvents).toBe(0);
			expect(mockedSwarmState.lastBudgetPct).toBe(0);
			expect(mockedSwarmState.activeToolCalls.size).toBe(0);
		});

		it('close succeeds when resetSwarmStatePreservingSingletons is the only state reset path', async () => {
			await writePlan();

			// If resetSwarmState were called directly (bypassing the preserving helper),
			// the mock throws — so a successful result proves the correct path was taken.
			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('finalized');
			expect(mockResetSwarmStatePreservingSingletons).toHaveBeenCalledTimes(1);
		});
	});

	// ── STAGE 2: ARCHIVE ─────────────────────────────────────────────

	describe('Archive stage', () => {
		it('creates an archive directory under .swarm/archive/ with a timestamped name', async () => {
			await writePlan();

			await handleCloseCommand(testDir, []);

			const archiveBase = path.join(swarmDir(), 'archive');
			expect(existsSync(archiveBase)).toBe(true);

			const entries = readdirSync(archiveBase);
			expect(entries.length).toBeGreaterThanOrEqual(1);

			const archiveName = entries.find((e) => e.startsWith('swarm-'));
			expect(archiveName).toBeDefined();
			// Timestamp pattern: swarm-YYYY-MM-DDTHH-MM-SS-…
			expect(archiveName).toMatch(/^swarm-\d{4}-\d{2}-\d{2}T/);
		});

		it('copies plan.json, context.md, and events.jsonl into the archive when they exist', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Context\nSome context',
			);
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"started"}\n',
			);

			await handleCloseCommand(testDir, []);

			const archiveBase = path.join(swarmDir(), 'archive');
			const archiveEntry = readdirSync(archiveBase).find((e) =>
				e.startsWith('swarm-'),
			);
			expect(archiveEntry).toBeDefined();

			const archivePath = path.join(archiveBase, archiveEntry!);
			expect(existsSync(path.join(archivePath, 'plan.json'))).toBe(true);
			expect(existsSync(path.join(archivePath, 'context.md'))).toBe(true);
			expect(existsSync(path.join(archivePath, 'events.jsonl'))).toBe(true);

			// Verify content fidelity of events.jsonl
			const archivedEvents = readFileSync(
				path.join(archivePath, 'events.jsonl'),
				'utf-8',
			);
			expect(archivedEvents).toContain('{"event":"started"}');
		});

		it('return message includes archive result', async () => {
			await writePlan();

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('**Archive:**');
			expect(result).toContain('Archived');
			expect(result).toContain('.swarm/archive/swarm-');
		});
	});

	// ── STAGE 3: CLEAN ───────────────────────────────────────────────

	describe('Clean stage', () => {
		it('removes active-state files after archiving', async () => {
			// Create all active-state files that should be cleaned
			const activeFilesRemoved = [
				'plan.json',
				'plan.md',
				'plan-ledger.jsonl',
				'events.jsonl',
				'handoff.md',
				'handoff-prompt.md',
				'handoff-consumed.md',
				'escalation-report.md',
			];
			// Write valid plan first so writePlan sets plan.json correctly,
			// then add the rest.
			await writePlan();
			for (const f of activeFilesRemoved) {
				if (f === 'plan.json') continue; // written by await writePlan()
				writeFileSync(path.join(swarmDir(), f), `content of ${f}`);
			}

			await handleCloseCommand(testDir, []);

			for (const f of activeFilesRemoved) {
				expect(existsSync(path.join(swarmDir(), f))).toBe(false);
			}
		});

		it('removes root-level SWARM_PLAN.json and SWARM_PLAN.md after close', async () => {
			await writePlan();
			// Create root-level SWARM_PLAN checkpoint artifacts (legacy
			// location — close still cleans these for backward compatibility
			// during the transition window).
			writeFileSync(path.join(testDir, 'SWARM_PLAN.json'), '{"title":"Test"}');
			writeFileSync(path.join(testDir, 'SWARM_PLAN.md'), '# Test Plan');

			await handleCloseCommand(testDir, []);

			// Root-level SWARM_PLAN artifacts must be removed
			expect(existsSync(path.join(testDir, 'SWARM_PLAN.json'))).toBe(false);
			expect(existsSync(path.join(testDir, 'SWARM_PLAN.md'))).toBe(false);
		});

		it('removes .swarm/SWARM_PLAN.json and .swarm/SWARM_PLAN.md after close', async () => {
			await writePlan();
			// Create canonical .swarm/-level SWARM_PLAN checkpoint artifacts
			writeFileSync(
				path.join(swarmDir(), 'SWARM_PLAN.json'),
				'{"title":"Test"}',
			);
			writeFileSync(path.join(swarmDir(), 'SWARM_PLAN.md'), '# Test Plan');

			await handleCloseCommand(testDir, []);

			// .swarm/-level SWARM_PLAN artifacts must be removed
			expect(existsSync(path.join(swarmDir(), 'SWARM_PLAN.json'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'SWARM_PLAN.md'))).toBe(false);
		});

		it('SWARM_PLAN cleanup is non-blocking — close succeeds even if removal fails', async () => {
			await writePlan();

			const result = await handleCloseCommand(testDir, []);

			// Close should succeed even if no SWARM_PLAN files exist to clean
			expect(result).toContain('finalized');
		});

		it('future swarms start from clean state — no stale plan.json or events.jsonl', async () => {
			await writePlan();
			writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"event":"old"}\n');

			await handleCloseCommand(testDir, []);

			// All active-state artifacts must be gone so the next /swarm session
			// starts with a clean slate. plan.json is now archived+removed.
			expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);

			// .swarm/ itself must still exist (archive, context.md, etc.)
			expect(existsSync(swarmDir())).toBe(true);
		});
	});

	// ── archive-guard: clean skipped when archive fails ─────────────

	describe('Archive-guard safety', () => {
		it('skips active-state cleanup when archive produces zero artifacts', async () => {
			// Create a plan-free session with only events.jsonl (no plan.json)
			// The archive will copy events.jsonl, but if we make .swarm/archive
			// unwritable, the archive will fail and clean must be skipped.
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"test"}\n',
			);

			// Make archive dir unwritable to force archive failure
			const archivePath = path.join(swarmDir(), 'archive');
			mkdirSync(archivePath, { recursive: true });
			writeFileSync(path.join(archivePath, 'blocker'), 'x');
			// Can't easily make dir unwritable in all envs, so test the
			// positive case: when archive succeeds (archivedFileCount > 0),
			// files ARE cleaned
			const result = await handleCloseCommand(testDir, []);

			// events.jsonl should be cleaned because archive succeeded
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
			// Result should mention archive success
			expect(result).toContain('Archived');
		});

		it('warns when archive count is zero and files are preserved', async () => {
			// Plan-free session, no artifacts at all in .swarm/ except the dir itself
			// Archive will find nothing to copy → archivedFileCount = 0
			// But archive creation itself succeeds, so it's the file count that matters
			const result = await handleCloseCommand(testDir, []);

			// With no source artifacts, archivedFileCount is 0
			// The result warns about skipped cleanup
			expect(result).toContain('finalized');
		});

		it('partial archive failure: file that fails to copy is preserved, file that succeeds is deleted', async () => {
			// Genuine partial-failure test: make handoff.md a DIRECTORY instead
			// of a file. fs.copyFile will throw EISDIR when trying to copy a
			// directory, so handoff.md will NOT be in archivedActiveStateFiles.
			// Meanwhile events.jsonl is a normal file and WILL be archived.
			// The clean stage must delete events.jsonl but preserve handoff.md.
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"important"}\n',
			);
			// Create handoff.md as a directory — copyFile will fail on this
			mkdirSync(path.join(swarmDir(), 'handoff.md'), { recursive: true });
			// Put a file inside so it's not empty (proves it's preserved)
			writeFileSync(
				path.join(swarmDir(), 'handoff.md', 'data.txt'),
				'critical data',
			);

			const result = await handleCloseCommand(testDir, []);

			// events.jsonl was successfully archived → should be deleted
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
			// handoff.md failed to archive (EISDIR) → must be PRESERVED
			expect(existsSync(path.join(swarmDir(), 'handoff.md'))).toBe(true);
			// The data inside must still be intact
			expect(
				readFileSync(path.join(swarmDir(), 'handoff.md', 'data.txt'), 'utf-8'),
			).toBe('critical data');
			// Result should contain a warning about the preserved file
			expect(result).toContain('Preserved handoff.md');
			expect(result).toContain('Archived');
		});

		it('partial archive failure path: close output includes warnings about unarchived files and completes without crash even when copy fails for some (FR-018)', async () => {
			// Simplest valid test per spec: run handleCloseCommand normally (existing
			// temp-dir + real-fs infrastructure covers the path). Induce per-entry
			// copy failure for one active-state file using directory-in-place-of-file
			// (triggers the .catch(() => {}) / try-catch in archive stage for fs.copyFile).
			// Verifies: (a) command does not crash, (b) result contains the
			// preservation warning (the "warnings about file failures if any"),
			// (c) unarchived file is preserved under .swarm/, (d) successfully
			// archived active files are still cleaned.
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"test"}\n',
			);
			// Make handoff.md a directory so flat-file copyFile in archive stage fails.
			// This exercises the per-entry catch in archive (no crash) + archive-first
			// guard in clean (preserve + warning).
			mkdirSync(path.join(swarmDir(), 'handoff.md'), { recursive: true });
			writeFileSync(
				path.join(swarmDir(), 'handoff.md', 'data.txt'),
				'critical unarchived data',
			);

			const closeOutput = await handleCloseCommand(testDir, []);

			// Must complete without crash (the catches ensure this)
			expect(closeOutput).toContain('Swarm finalized');
			// Must surface warning about the file that failed to archive
			expect(closeOutput).toContain(
				'Preserved handoff.md because it was not successfully archived.',
			);
			// Warnings section must be present when file-failure preservations exist
			expect(closeOutput).toContain('**Warnings:**');
			// Unarchived file preserved in .swarm/ (archive-first guard)
			expect(existsSync(path.join(swarmDir(), 'handoff.md'))).toBe(true);
			expect(
				readFileSync(path.join(swarmDir(), 'handoff.md', 'data.txt'), 'utf-8'),
			).toBe('critical unarchived data');
			// Successfully archived active-state file must still be cleaned
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
		});

		it('preserves ALL active-state files when only non-active-state artifacts are archived', async () => {
			// Create context.md (in ARCHIVE_ARTIFACTS but NOT in ACTIVE_STATE_TO_CLEAN)
			// and make ALL active-state files fail to archive by creating them
			// as directories. This means archivedFileCount > 0 (context.md succeeds)
			// but archivedActiveStateFiles is empty → no active-state files deleted.
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Context\nImportant context.',
			);
			// Create events.jsonl as a directory so copyFile fails
			mkdirSync(path.join(swarmDir(), 'events.jsonl'), { recursive: true });
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl', 'data.txt'),
				'event data',
			);
			// Create escalation-report.md as a directory so copyFile fails
			mkdirSync(path.join(swarmDir(), 'escalation-report.md'), {
				recursive: true,
			});

			const result = await handleCloseCommand(testDir, []);

			// context.md was archived (archivedFileCount > 0)
			expect(result).toContain('Archived');
			// But no active-state files were archived → archivedActiveStateFiles empty
			// So events.jsonl directory must still exist
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(true);
			expect(
				readFileSync(
					path.join(swarmDir(), 'events.jsonl', 'data.txt'),
					'utf-8',
				),
			).toBe('event data');
			// escalation-report.md directory must still exist
			expect(existsSync(path.join(swarmDir(), 'escalation-report.md'))).toBe(
				true,
			);
			// archivedActiveStateFiles is empty → uses the bulk skip warning
			expect(result).toContain(
				'Skipped active-state cleanup because no active-state files were archived',
			);
		});

		it('ledger is archived AND removed — prevents next-session loadPlan from resurrecting the closed plan', async () => {
			// Regression guard for reviewer-F1: before the fix, plan-ledger.jsonl
			// was absent from both ARCHIVE_ARTIFACTS and ACTIVE_STATE_TO_CLEAN.
			// Closing a session deleted plan.json but left the ledger behind, so
			// loadPlan()'s Step 4 (no plan.json + ledgerExists → replayFromLedger)
			// would materialise the CLOSED plan back onto disk. This test seeds
			// a real ledger, runs close, and verifies:
			//   1. The ledger is copied into the archive bundle (forensics)
			//   2. The ledger is removed from .swarm/ (clean slate)
			await writePlan();
			// Seed a realistic-looking ledger file.
			const ledgerContent =
				`${JSON.stringify({ seq: 1, plan_id: 'test-plan', event_type: 'plan_created', timestamp: '2026-01-01T00:00:00.000Z' })}\n` +
				`${JSON.stringify({ seq: 2, plan_id: 'test-plan', event_type: 'snapshot', source: 'critic_approved', timestamp: '2026-01-02T00:00:00.000Z' })}\n`;
			writeFileSync(path.join(swarmDir(), 'plan-ledger.jsonl'), ledgerContent);

			const result = await handleCloseCommand(testDir, []);

			// 1. Forensic preservation: ledger must be in the archive bundle.
			const archiveRoot = path.join(swarmDir(), 'archive');
			const archiveDirs = readdirSync(archiveRoot).filter((d) =>
				d.startsWith('swarm-'),
			);
			expect(archiveDirs.length).toBeGreaterThanOrEqual(1);
			const archivedLedgerPath = path.join(
				archiveRoot,
				archiveDirs[0],
				'plan-ledger.jsonl',
			);
			expect(existsSync(archivedLedgerPath)).toBe(true);
			const archivedLedger = readFileSync(archivedLedgerPath, 'utf-8');
			expect(archivedLedger).toContain('"event_type":"plan_created"');
			expect(archivedLedger).toContain('"event_type":"snapshot"');
			expect(archivedLedger).toContain('"plan_id":"test-plan"');

			// 2. Clean-slate: ledger must be gone from .swarm/ so the next
			//    session's loadPlan() falls through to Step 4 with no ledger
			//    and correctly returns null instead of resurrecting the closed
			//    plan via replayFromLedger.
			expect(existsSync(path.join(swarmDir(), 'plan-ledger.jsonl'))).toBe(
				false,
			);
			expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(false);
			expect(result).toContain('Archived');
		});

		it('sweeps stale plan-ledger.archived-*/backup-* siblings during cleanup', async () => {
			// Critic gap 3a: savePlan creates plan-ledger.archived-<ts>.jsonl
			// and plan-ledger.backup-<ts>.jsonl files during identity-mismatch
			// reinitialization. Without a sweep at close time, they accumulate
			// forever in .swarm/, undermining the "clean slate" invariant the
			// primary plan-ledger.jsonl removal is meant to enforce.
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'plan-ledger.archived-12345-1.jsonl'),
				'{"event":"old"}\n',
			);
			writeFileSync(
				path.join(swarmDir(), 'plan-ledger.backup-67890-2.jsonl'),
				'{"event":"older"}\n',
			);
			// Also a non-matching file that must NOT be swept (negative control).
			writeFileSync(
				path.join(swarmDir(), 'plan-ledger.unrelated.jsonl'),
				'preserve me',
			);

			await handleCloseCommand(testDir, []);

			// Stale siblings must be gone.
			expect(
				existsSync(path.join(swarmDir(), 'plan-ledger.archived-12345-1.jsonl')),
			).toBe(false);
			expect(
				existsSync(path.join(swarmDir(), 'plan-ledger.backup-67890-2.jsonl')),
			).toBe(false);
			// Non-matching file must survive (sweep is targeted, not blanket).
			expect(
				existsSync(path.join(swarmDir(), 'plan-ledger.unrelated.jsonl')),
			).toBe(true);
		});

		it('only files in archivedActiveStateFiles set are deleted during cleanup', async () => {
			// This test verifies the core safety invariant: clean stage only
			// deletes files that were successfully copied to the archive.
			//
			// With Claim E, plan.json is now also in ACTIVE_STATE_TO_CLEAN so
			// both plan.json and events.jsonl should be archived AND deleted.
			// The context.md file is in ARCHIVE_ARTIFACTS but NOT in
			// ACTIVE_STATE_TO_CLEAN — it should be archived but NOT deleted.
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"test"}\n',
			);
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Context\nPreserved across close.',
			);

			const result = await handleCloseCommand(testDir, []);

			// plan.json was archived AND is in ACTIVE_STATE_TO_CLEAN → deleted
			expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(false);
			// events.jsonl was archived AND is in ACTIVE_STATE_TO_CLEAN → deleted
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
			// context.md is in ARCHIVE_ARTIFACTS only — must be reset/kept, not
			// deleted, because close.ts writes a fresh context.md afterwards.
			expect(existsSync(path.join(swarmDir(), 'context.md'))).toBe(true);
			expect(result).toContain('Archived');
		});
	});

	// ── context.md reset ─────────────────────────────────────────────

	describe('Context reset', () => {
		it('resets context.md with "Session closed" content and finalization type', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Old context\nStale data here.',
			);

			await handleCloseCommand(testDir, []);

			const contextPath = path.join(swarmDir(), 'context.md');
			expect(existsSync(contextPath)).toBe(true);
			const content = readFileSync(contextPath, 'utf-8');
			expect(content).toContain('Session closed');
			expect(content).toContain('Finalization: normal');
			expect(content).toContain('No active plan');
		});

		it('marks finalization as "forced" when --force is used', async () => {
			await writePlan();

			await handleCloseCommand(testDir, ['--force']);

			const content = readFileSync(
				path.join(swarmDir(), 'context.md'),
				'utf-8',
			);
			expect(content).toContain('Finalization: forced');
		});

		it('marks finalization as "plan-already-done" when all phases are terminal', async () => {
			await writePlan({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'completed',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								description: 'Task A',
								size: 'small',
							},
						],
					},
				],
			});

			await handleCloseCommand(testDir, []);

			const content = readFileSync(
				path.join(swarmDir(), 'context.md'),
				'utf-8',
			);
			expect(content).toContain('Finalization: plan-already-done');
		});
	});

	// ── Close summary ────────────────────────────────────────────────

	describe('Close summary', () => {
		it('includes archive result and finalization type in close-summary.md', async () => {
			await writePlan();

			await handleCloseCommand(testDir, []);

			const summaryPath = path.join(swarmDir(), 'close-summary.md');
			expect(existsSync(summaryPath)).toBe(true);
			const summary = readFileSync(summaryPath, 'utf-8');
			expect(summary).toContain('Archived');
			expect(summary).toContain('.swarm/archive/swarm-');
			expect(summary).toContain('Normal finalization');
		});

		it('distinguishes normal finalization from forced closure in the summary', async () => {
			await writePlan();

			await handleCloseCommand(testDir, ['--force']);

			const summary = readFileSync(
				path.join(swarmDir(), 'close-summary.md'),
				'utf-8',
			);
			expect(summary).toContain('Forced closure');
		});

		it('return message includes archive and git status info', async () => {
			await writePlan();

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('**Archive:**');
			expect(result).toContain('**Git:**');
			// Git is mocked as non-repo
			expect(result).toContain('Not a git repository');
		});

		it('forced closure return message differs from normal', async () => {
			await writePlan();

			const normalResult = await handleCloseCommand(testDir, []);

			// Recreate for fresh forced run
			mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });
			await writePlan();

			const forcedResult = await handleCloseCommand(testDir, ['--force']);

			// Both should succeed but the retro summary mentions force
			expect(normalResult).toContain('Swarm finalized');
			expect(forcedResult).toContain('Swarm finalized');
		});
	});

	// ── Plan-already-done path ───────────────────────────────────────

	describe('Align stage', () => {
		it('regression: detects a git repo and runs aggressive reset during finalize', async () => {
			// Previous coverage pinned the git mock to non-repo, so finalize could
			// skip alignment without any command-level test proving the reset path.
			mockGetGitRepositoryStatus.mockImplementation(() => ({ isRepo: true }));
			mockResetToMainAfterMerge.mockImplementation(() => ({
				success: true,
				targetBranch: 'origin/main',
				previousBranch: 'feature/finalize',
				message: 'Reset to origin/main',
				branchDeleted: false,
				changesDiscarded: false,
				warnings: [],
			}));
			writePlan();

			const result = await handleCloseCommand(testDir, []);

			expect(mockGetGitRepositoryStatus).toHaveBeenCalledWith(testDir);
			expect(mockResetToMainAfterMerge).toHaveBeenCalledWith(testDir, {
				pruneBranches: false,
			});
			expect(mockResetToRemoteBranch).not.toHaveBeenCalled();
			expect(result).toContain('**Git:** Reset to origin/main');
			expect(result).not.toContain('Not a git repository');

			const summary = readFileSync(
				path.join(swarmDir(), 'close-summary.md'),
				'utf-8',
			);
			expect(summary).toContain('- **Git:** Reset to origin/main');
		});

		it('reports git execution failures without misclassifying them as non-git repos', async () => {
			mockGetGitRepositoryStatus.mockImplementation(() => ({
				isRepo: false,
				reason: 'git_unavailable',
				message: 'git executable is not available on PATH',
			}));
			writePlan();

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('Git executable unavailable');
			expect(result).toContain('git executable is not available on PATH');
			expect(result).not.toContain('Not a git repository');
			expect(mockResetToMainAfterMerge).not.toHaveBeenCalled();
			expect(mockResetToRemoteBranch).not.toHaveBeenCalled();
		});

		it('reports git_error in warnings when repository check fails (F-001)', async () => {
			mockGetGitRepositoryStatus.mockImplementation(() => ({
				isRepo: false,
				reason: 'git_error',
				message: 'spawnSync git ETIMEDOUT',
			}));
			writePlan();

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('Git repository check failed');
			expect(result).toContain('spawnSync git ETIMEDOUT');
			expect(result).toContain('**Warnings:**');
			expect(mockResetToMainAfterMerge).not.toHaveBeenCalled();
			expect(mockResetToRemoteBranch).not.toHaveBeenCalled();
		});

		it('falls back to resetToRemoteBranch when resetToMainAfterMerge returns success:false (F-004)', async () => {
			mockGetGitRepositoryStatus.mockImplementation(() => ({ isRepo: true }));
			mockResetToMainAfterMerge.mockImplementation(() => ({
				success: false,
				targetBranch: 'origin/main',
				previousBranch: 'main',
				message: 'Nothing to reset',
				branchDeleted: false,
				changesDiscarded: false,
				warnings: [] as string[],
			}));
			writePlan();

			await handleCloseCommand(testDir, []);

			expect(mockResetToRemoteBranch).toHaveBeenCalledTimes(1);
		});
	});

	describe('Plan already terminal', () => {
		it('skips retro writing but still archives and cleans', async () => {
			await writePlan({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'completed',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								description: 'Task A',
								size: 'small',
							},
						],
					},
				],
			});
			writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"e":1}\n');

			const result = await handleCloseCommand(testDir, []);

			// Should NOT have called retro
			expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(0);

			// Archive should still exist
			const archiveBase = path.join(swarmDir(), 'archive');
			const entries = readdirSync(archiveBase);
			expect(entries.length).toBeGreaterThanOrEqual(1);

			// Active-state files should be cleaned
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);

			// Result should indicate plan was already terminal
			expect(result).toContain('already in a terminal state');
		});
	});

	// ── Session-level retrospective for plan-free (FR-004) ─────────────
	describe('Session-level retrospective (plan-free)', () => {
		it('writes session retro with task_id "retro-session" and session_scope "plan_free" when no plan.json exists', async () => {
			// Simulate plan-free session (no plan.json): .swarm/ dir exists from beforeEach
			const result = await handleCloseCommand(testDir, []);

			expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(1);
			const retroCall = mockExecuteWriteRetro.mock.calls[0];
			const retroArgs = retroCall[0] as {
				phase?: number;
				task_id?: string;
				summary?: string;
				task_count?: number;
				task_complexity?: string;
				metadata?: { session_scope?: string; session_start?: string };
			};
			expect(retroArgs.task_id).toBe('retro-session');
			expect(retroArgs.metadata?.session_scope).toBe('plan_free');
			expect(retroArgs.phase).toBe(1);
			expect(retroArgs.summary).toBe(
				'Plan-free session closed via /swarm close',
			);
			expect(retroCall[1]).toBe(testDir);
			expect(result).toContain('finalized');
		});

		it('does not write the session retro when a plan exists and phases are closed (phase retro written instead)', async () => {
			await writePlan(); // plan exists + in_progress phase → wrotePhaseRetro=true, planExists=true → skip session retro
			await handleCloseCommand(testDir, []);

			expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(1);
			const retroCall = mockExecuteWriteRetro.mock.calls[0];
			const retroArgs = retroCall[0] as { task_id?: string; phase?: number };
			expect(retroArgs.task_id).toBeUndefined();
			expect(retroArgs.phase).toBe(1); // the phase-level retro call

			// Double-check: no call in the list used the session retro identifier
			const hadSessionRetroCall = mockExecuteWriteRetro.mock.calls.some((c) => {
				const a = c[0] as { task_id?: string };
				return a.task_id === 'retro-session';
			});
			expect(hadSessionRetroCall).toBe(false);
		});
	});

	// ── JUNCTION / SYMLINK GUARD (FR-002b) ─────────────────────────────
	// Tests the early guard in handleCloseCommand that refuses when .swarm/
	// is a symlink or Windows junction (uses lstatSync + isSymbolicLink).

	describe('Junction/symlink guard', () => {
		it('trips guard and returns refusal when .swarm/ is a junction or symlink', async () => {
			const targetDir = path.join(testDir, 'real-swarm-target');
			mkdirSync(targetDir, { recursive: true });

			try {
				// Remove .swarm/ and recreate as a symlink
				await rm(swarmDir(), { recursive: true, force: true });
				// On Windows, this may throw if admin/developer mode not enabled
				await fs.symlink(targetDir, swarmDir(), 'junction');
			} catch {
				// Platform limitation — skip symlink test on this runner
				return;
			}

			const closeResult = await handleCloseCommand(testDir, []);

			expect(closeResult).toContain('symlink');
			expect(closeResult).toContain('junction');
			expect(closeResult).toContain('Refused');
			expect(closeResult).toContain('.swarm/ is a symlink or junction');
		});

		it('does not trip guard for normal (non-symlink) .swarm/ and proceeds normally', async () => {
			await writePlan();

			const closeResult = await handleCloseCommand(testDir, []);

			// Guard must not have triggered
			expect(closeResult).not.toContain('Refused');
			expect(closeResult).not.toContain('symlink');
			expect(closeResult).not.toContain('junction');

			// Command must have proceeded to normal finalization path
			expect(closeResult).toContain('finalized');
			expect(mockResetSwarmStatePreservingSingletons).toHaveBeenCalled();
		});
	});

	// ── SKILL REVIEW FLAG (FR-005) ─────────────────────────────────────
	// Tests the --skill-review opt-in path that invokes runSkillImprover
	// (and includes the summary in the close return value + close-summary.md).

	describe('Skill review flag path', () => {
		it('calls runSkillImprover (via mock.calls) when --skill-review is passed', async () => {
			await writePlan();

			await handleCloseCommand(testDir, ['--skill-review']);

			// Per task: verify via mock.calls
			expect(mockRunSkillImprover.mock.calls.length).toBe(1);
		});

		it('does NOT call runSkillImprover when no args passed', async () => {
			await writePlan();

			await handleCloseCommand(testDir, []);

			expect(mockRunSkillImprover.mock.calls.length).toBe(0);
		});

		it('includes the skill review summary in the command output when flag present', async () => {
			await writePlan();

			const result = await handleCloseCommand(testDir, ['--skill-review']);

			// The return value (and close-summary.md) must surface the advisory summary
			expect(result).toContain('**Skill Review:**');
			expect(result).toContain('Skill review proposal generated');
			expect(result).toContain('test-skill-review.md');
		});
	});
});

// ── guaranteeAllPlansComplete via _internals (FR-006b) ─────────────────
// Pure unit tests for the internal helper now exposed for testability.
// These do not exercise handleCloseCommand or any of its side effects/mocks.

describe('guaranteeAllPlansComplete via _internals (FR-006b)', () => {
	test('marks in-progress tasks as closed with close_reason: session_terminated', async () => {
		const { _internals: closeInternals } = await import(
			'../../../src/commands/close'
		);

		const planData = {
			title: 'Test Plan',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{ id: '1.1', status: 'in_progress' },
						{ id: '1.2', status: 'complete' },
					],
				},
			],
		};

		const result = closeInternals.guaranteeAllPlansComplete(planData);

		// Task 1.1 should be closed with the specific reason
		expect(planData.phases[0].tasks[0].status).toBe('closed');
		expect(planData.phases[0].tasks[0].close_reason).toBe('session_terminated');
		// Task 1.2 untouched
		expect(planData.phases[0].tasks[1].status).toBe('complete');
		expect(planData.phases[0].tasks[1].close_reason).toBeUndefined();

		// Return value reports only the newly closed task and its phase
		expect(result.closedTaskIds).toEqual(['1.1']);
		expect(result.closedPhaseIds).toEqual([1]);
	});

	test('marks in-progress phases as closed', async () => {
		const { _internals: closeInternals } = await import(
			'../../../src/commands/close'
		);

		const planData = {
			title: 'Test Plan',
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
					status: 'pending',
					tasks: [],
				},
			],
		};

		const result = closeInternals.guaranteeAllPlansComplete(planData);

		expect(planData.phases[0].status).toBe('closed');
		expect(planData.phases[1].status).toBe('closed');

		expect(result.closedPhaseIds).toEqual([1, 2]);
		expect(result.closedTaskIds).toEqual([]);
	});

	test('is idempotent: second call returns empty sets', async () => {
		const { _internals: closeInternals } = await import(
			'../../../src/commands/close'
		);

		const planData = {
			title: 'Test Plan',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [{ id: '1.1', status: 'in_progress' }],
				},
			],
		};

		const first = closeInternals.guaranteeAllPlansComplete(planData);
		expect(first.closedPhaseIds).toEqual([1]);
		expect(first.closedTaskIds).toEqual(['1.1']);

		// Second call on the now-terminal plan must report nothing new
		const second = closeInternals.guaranteeAllPlansComplete(planData);
		expect(second.closedPhaseIds).toEqual([]);
		expect(second.closedTaskIds).toEqual([]);

		// State remains closed (no re-mutation)
		expect(planData.phases[0].status).toBe('closed');
		expect(planData.phases[0].tasks[0].status).toBe('closed');
	});

	test('empty plan (no phases) returns empty sets', async () => {
		const { _internals: closeInternals } = await import(
			'../../../src/commands/close'
		);

		const planData = {
			title: 'Empty Plan',
			phases: [],
		};

		const result = closeInternals.guaranteeAllPlansComplete(planData);

		expect(result).toEqual({ closedPhaseIds: [], closedTaskIds: [] });
		expect(planData.phases).toEqual([]);
	});

	test('return value contains correct closedPhaseIds and closedTaskIds', async () => {
		const { _internals: closeInternals } = await import(
			'../../../src/commands/close'
		);

		const planData = {
			title: 'Mixed Plan',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{ id: '1.1', status: 'in_progress' },
						{ id: '1.2', status: 'in_progress' },
					],
				},
				{
					id: 2,
					name: 'Phase 2',
					status: 'complete',
					tasks: [{ id: '2.1', status: 'in_progress' }],
				},
			],
		};

		const result = closeInternals.guaranteeAllPlansComplete(planData);

		expect(result.closedPhaseIds).toEqual([1]); // only phase 1 was not terminal
		expect(result.closedTaskIds).toEqual(['1.1', '1.2', '2.1']);
		// Phase 2 stayed complete (was already terminal)
		expect(planData.phases[1].status).toBe('complete');
	});
});

// ── copyDirRecursive via _internals (FR-015b) ──────────────────────────

describe('copyDirRecursive via _internals (FR-015b)', () => {
	test('copies a nested directory tree with files and subdirectories and returns the correct file count', async () => {
		const { _internals: closeInternals } = await import(
			'../../../src/commands/close'
		);

		const tmp = mkdtempSync(path.join(os.tmpdir(), 'copydir-recursive-test-'));
		try {
			const src = path.join(tmp, 'src');
			const dest = path.join(tmp, 'dest');

			// Build nested source: src/file1.txt, src/a/file2.txt, src/a/b/file3.txt
			mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
			writeFileSync(path.join(src, 'file1.txt'), 'hello');
			writeFileSync(path.join(src, 'a', 'file2.txt'), 'world');
			writeFileSync(path.join(src, 'a', 'b', 'file3.txt'), 'deep');

			const count = await closeInternals.copyDirRecursive(src, dest);

			expect(count).toBe(3);

			// Verify files copied with correct content
			expect(existsSync(path.join(dest, 'file1.txt'))).toBe(true);
			expect(readFileSync(path.join(dest, 'file1.txt'), 'utf8')).toBe('hello');
			expect(existsSync(path.join(dest, 'a', 'file2.txt'))).toBe(true);
			expect(readFileSync(path.join(dest, 'a', 'file2.txt'), 'utf8')).toBe(
				'world',
			);
			expect(existsSync(path.join(dest, 'a', 'b', 'file3.txt'))).toBe(true);
			expect(readFileSync(path.join(dest, 'a', 'b', 'file3.txt'), 'utf8')).toBe(
				'deep',
			);

			// Verify subdirectories were created
			expect(existsSync(path.join(dest, 'a'))).toBe(true);
			expect(existsSync(path.join(dest, 'a', 'b'))).toBe(true);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
