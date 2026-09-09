import { afterEach, beforeEach, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isValidEvidenceType } from '../../../src/evidence/manager.js';
import { initLedger } from '../../../src/plan/ledger.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import { STATE_MOCK_TRANSITIVE_STUBS } from './state-mock-transitive-stubs.js';

const realSnapshotWriter = await import(
	'../../../src/session/snapshot-writer.js'
);

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

export async function createCloseFinalizerHarness() {
	const mockExecuteWriteRetro = mock(
		async (_args: unknown, _directory: string) =>
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

	let mockedSwarmState: MockSwarmState = {} as MockSwarmState;
	const mockResetSwarmStatePreservingSingletons = mock(() => {
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
		mockedSwarmState.opencodeClient = toPreserve.opencodeClient;
		mockedSwarmState.fullAutoEnabledInConfig =
			toPreserve.fullAutoEnabledInConfig;
		mockedSwarmState.curatorInitAgentNames = toPreserve.curatorInitAgentNames;
		mockedSwarmState.curatorPhaseAgentNames = toPreserve.curatorPhaseAgentNames;
		mockedSwarmState.skillImproverAgentNames =
			toPreserve.skillImproverAgentNames;
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
		isValidEvidenceType,
	}));
	mock.module('../../../src/session/snapshot-writer.js', () => ({
		...realSnapshotWriter,
		flushPendingSnapshot: mockFlushPendingSnapshot,
		writeSnapshot: async () => {},
	}));
	mock.module('../../../src/hooks/hive-promoter.js', () => ({
		isHiveEligible: () => false,
		checkHivePromotions: async () => {},
		promoteToHive: async () => '',
		promoteFromSwarm: async () => '',
	}));
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
			...STATE_MOCK_TRANSITIVE_STUBS,
			swarmState: mockedSwarmState,
			endAgentSession: () => {},
			resetSwarmState: () => {
				throw new Error(
					'close.ts must call resetSwarmStatePreservingSingletons, not resetSwarmState',
				);
			},
			resetSwarmStatePreservingSingletons:
				mockResetSwarmStatePreservingSingletons,
			getAgentSession: (sessionId: string) =>
				mockedSwarmState.agentSessions?.get(sessionId),
			ensureAgentSession: (sessionId: string, agentName?: string) => {
				let session = mockedSwarmState.agentSessions.get(sessionId);
				if (!session) {
					session = { agentName };
					mockedSwarmState.agentSessions.set(sessionId, session);
				}
				return session;
			},
			hasActiveTurboMode: () => false,
			hasActiveFullAuto: () => false,
			getActiveFullAutoSessionID: () => undefined,
			hasActiveLeanTurbo: () => false,
			hasActiveEpicMode: () => false,
			updateTaskWorkflowCache: () => {},
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

	const { handleCloseCommand, _internals: closeInternals } = await import(
		'../../../src/commands/close.js'
	);
	const realGetGitRepositoryStatus = closeInternals.getGitRepositoryStatus;
	const realResetToRemoteBranch = closeInternals.resetToRemoteBranch;
	const realResetToMainAfterMerge = closeInternals.resetToMainAfterMerge;
	const realResetSwarmStatePreservingSingletons =
		closeInternals.resetSwarmStatePreservingSingletons;

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
							depends: [],
							files_touched: [],
						},
						{
							id: '1.2',
							phase: 1,
							status: 'completed',
							description: 'Task B',
							size: 'small',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
			...overrides,
		};
		writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
		await initLedger(testDir, derivePlanId(plan), undefined, plan);
	}

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
		closeInternals.resetSwarmStatePreservingSingletons =
			mockResetSwarmStatePreservingSingletons;
		mockRunSkillImprover.mockClear();
		mockResetSwarmStatePreservingSingletons.mockClear();
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
		closeInternals.resetSwarmStatePreservingSingletons =
			realResetSwarmStatePreservingSingletons;
		mock.restore();
	});

	return {
		get testDir() {
			return testDir;
		},
		swarmDir,
		writePlan,
		handleCloseCommand,
		closeInternals,
		mockExecuteWriteRetro,
		mockCurateAndStoreSwarm,
		mockArchiveEvidence,
		mockFlushPendingSnapshot,
		mockGetGitRepositoryStatus,
		mockResetToRemoteBranch,
		mockResetToMainAfterMerge,
		mockRunSkillImprover,
		mockResetSwarmStatePreservingSingletons,
		mockedSwarmState,
		realGetGitRepositoryStatus,
		realResetToRemoteBranch,
		realResetToMainAfterMerge,
		realResetSwarmStatePreservingSingletons,
	};
}
