import { mock } from 'bun:test';
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

import { isValidEvidenceType } from '../../../src/evidence/manager.js';
import { initLedger } from '../../../src/plan/ledger.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import { STATE_MOCK_TRANSITIVE_STUBS } from './state-mock-transitive-stubs.js';

type CloseModule = typeof import('../../../src/commands/close.js');

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

function createMockSwarmState(): MockSwarmState {
	return {
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
}

export const mockExecuteWriteRetro = mock(
	async (_args: unknown, _directory: string) =>
		JSON.stringify({
			success: true,
			phase: 1,
			task_id: 'retro-1',
			message: 'Done',
		}),
);

export const mockCurateAndStoreSwarm = mock(async () => {});
export const mockArchiveEvidence = mock(async () => {});
export const mockFlushPendingSnapshot = mock(async () => {});
export const mockGetGitRepositoryStatus = mock(() => ({
	isRepo: false as const,
	reason: 'not_git_repo' as const,
	message: 'fatal: not a git repository',
}));
export const mockResetToRemoteBranch = mock(() => ({
	success: true,
	targetBranch: 'main',
	localBranch: 'main',
	message: 'Already aligned with remote',
	alreadyAligned: true,
	prunedBranches: [] as string[],
	warnings: [] as string[],
}));
export const mockResetToMainAfterMerge = mock(() => ({
	success: true,
	targetBranch: 'origin/main',
	previousBranch: 'main',
	message: 'Already on main',
	branchDeleted: false,
	changesDiscarded: false,
	warnings: [] as string[],
}));
export const mockRunSkillImprover = mock(async () => ({
	ran: true,
	proposalPath: '.swarm/skills/proposals/test-skill-review.md',
	source: 'knowledge',
}));

const defaultSwarmState = createMockSwarmState();
export const mockedSwarmState: MockSwarmState = createMockSwarmState();

export const mockResetSwarmStatePreservingSingletons = mock(() => {
	const preserved = {
		opencodeClient: mockedSwarmState.opencodeClient,
		fullAutoEnabledInConfig: mockedSwarmState.fullAutoEnabledInConfig,
		curatorInitAgentNames: [...mockedSwarmState.curatorInitAgentNames],
		curatorPhaseAgentNames: [...mockedSwarmState.curatorPhaseAgentNames],
		skillImproverAgentNames: [...mockedSwarmState.skillImproverAgentNames],
		specWriterAgentNames: [...mockedSwarmState.specWriterAgentNames],
		generatedAgentNames: [...mockedSwarmState.generatedAgentNames],
	};

	mockedSwarmState.activeToolCalls.clear();
	mockedSwarmState.toolAggregates.clear();
	mockedSwarmState.activeAgent.clear();
	mockedSwarmState.delegationChains.clear();
	mockedSwarmState.pendingEvents = 0;
	mockedSwarmState.lastBudgetPct = 0;
	mockedSwarmState.agentSessions.clear();
	mockedSwarmState.pendingRehydrations.clear();
	mockedSwarmState.currentCriticalShownIds.clear();
	mockedSwarmState.knowledgeAckDedup.clear();
	mockedSwarmState.environmentProfiles.clear();

	mockedSwarmState.opencodeClient = preserved.opencodeClient;
	mockedSwarmState.fullAutoEnabledInConfig = preserved.fullAutoEnabledInConfig;
	mockedSwarmState.curatorInitAgentNames = preserved.curatorInitAgentNames;
	mockedSwarmState.curatorPhaseAgentNames = preserved.curatorPhaseAgentNames;
	mockedSwarmState.skillImproverAgentNames = preserved.skillImproverAgentNames;
	mockedSwarmState.specWriterAgentNames = preserved.specWriterAgentNames;
	mockedSwarmState.generatedAgentNames = preserved.generatedAgentNames;
});

let closeModule: CloseModule | undefined;
let closeInternals: CloseModule['_internals'] | undefined;
let realGetGitRepositoryStatus:
	| CloseModule['_internals']['getGitRepositoryStatus']
	| undefined;
let realResetToRemoteBranch:
	| CloseModule['_internals']['resetToRemoteBranch']
	| undefined;
let realResetToMainAfterMerge:
	| CloseModule['_internals']['resetToMainAfterMerge']
	| undefined;
let realResetSwarmStatePreservingSingletons:
	| CloseModule['_internals']['resetSwarmStatePreservingSingletons']
	| undefined;

function resetMockedSwarmState(): void {
	mockedSwarmState.activeToolCalls = new Map<string, unknown>();
	mockedSwarmState.toolAggregates = new Map<string, unknown>();
	mockedSwarmState.activeAgent = new Map<string, unknown>();
	mockedSwarmState.delegationChains = new Map<string, unknown>();
	mockedSwarmState.pendingEvents = 0;
	mockedSwarmState.lastBudgetPct = 0;
	mockedSwarmState.agentSessions = new Map<string, unknown>();
	mockedSwarmState.pendingRehydrations = new Set<unknown>();
	mockedSwarmState.opencodeClient = defaultSwarmState.opencodeClient;
	mockedSwarmState.fullAutoEnabledInConfig =
		defaultSwarmState.fullAutoEnabledInConfig;
	mockedSwarmState.curatorInitAgentNames = [
		...defaultSwarmState.curatorInitAgentNames,
	];
	mockedSwarmState.curatorPhaseAgentNames = [
		...defaultSwarmState.curatorPhaseAgentNames,
	];
	mockedSwarmState.skillImproverAgentNames = [
		...defaultSwarmState.skillImproverAgentNames,
	];
	mockedSwarmState.specWriterAgentNames = [
		...defaultSwarmState.specWriterAgentNames,
	];
	mockedSwarmState.generatedAgentNames = [
		...defaultSwarmState.generatedAgentNames,
	];
	mockedSwarmState.currentCriticalShownIds = new Map<string, unknown>();
	mockedSwarmState.knowledgeAckDedup = new Set<unknown>();
	mockedSwarmState.environmentProfiles = new Map<string, unknown>();
}

export async function initializeCloseFinalizerHarness(): Promise<{
	handleCloseCommand: CloseModule['handleCloseCommand'];
	closeInternals: CloseModule['_internals'];
	mockExecuteWriteRetro: typeof mockExecuteWriteRetro;
	mockCurateAndStoreSwarm: typeof mockCurateAndStoreSwarm;
	mockArchiveEvidence: typeof mockArchiveEvidence;
	mockFlushPendingSnapshot: typeof mockFlushPendingSnapshot;
	mockGetGitRepositoryStatus: typeof mockGetGitRepositoryStatus;
	mockResetToRemoteBranch: typeof mockResetToRemoteBranch;
	mockResetToMainAfterMerge: typeof mockResetToMainAfterMerge;
	mockRunSkillImprover: typeof mockRunSkillImprover;
	resetState: () => void;
	restoreInternals: () => void;
	newTestDir: () => string;
	cleanupTestDir: (testDir: string) => void;
	swarmDir: (testDir: string) => string;
	writePlan: (
		testDir: string,
		overrides?: Record<string, unknown>,
	) => Promise<void>;
}> {
	if (closeModule && closeInternals) {
		return {
			handleCloseCommand: closeModule.handleCloseCommand,
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
			resetState,
			restoreInternals,
			newTestDir,
			cleanupTestDir,
			swarmDir,
			writePlan,
		};
	}

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
		flushPendingSnapshot: mockFlushPendingSnapshot,
		writeSnapshot: async () => {},
	}));

	mock.module('../../../src/hooks/hive-promoter.js', () => ({
		isHiveEligible: () => false,
		checkHivePromotions: async () => {},
		promoteToHive: async () => '',
		promoteFromSwarm: async () => '',
	}));

	mock.module('../../../src/state.js', () => ({
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
			mockedSwarmState.agentSessions.get(sessionId),
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
	}));

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

	closeModule = await import('../../../src/commands/close.js');
	closeInternals = closeModule._internals;
	realGetGitRepositoryStatus = closeInternals.getGitRepositoryStatus;
	realResetToRemoteBranch = closeInternals.resetToRemoteBranch;
	realResetToMainAfterMerge = closeInternals.resetToMainAfterMerge;
	realResetSwarmStatePreservingSingletons =
		closeInternals.resetSwarmStatePreservingSingletons;

	resetState();

	return {
		handleCloseCommand: closeModule.handleCloseCommand,
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
		resetState,
		restoreInternals,
		newTestDir,
		cleanupTestDir,
		swarmDir,
		writePlan,
	};
}

export function resetState(): void {
	if (!closeInternals) {
		resetMockedSwarmState();
		return;
	}

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
	resetMockedSwarmState();
}

export function restoreInternals(): void {
	if (!closeInternals) {
		return;
	}

	closeInternals.getGitRepositoryStatus =
		realGetGitRepositoryStatus ?? closeInternals.getGitRepositoryStatus;
	closeInternals.resetToRemoteBranch =
		realResetToRemoteBranch ?? closeInternals.resetToRemoteBranch;
	closeInternals.resetToMainAfterMerge =
		realResetToMainAfterMerge ?? closeInternals.resetToMainAfterMerge;
	closeInternals.resetSwarmStatePreservingSingletons =
		realResetSwarmStatePreservingSingletons ??
		closeInternals.resetSwarmStatePreservingSingletons;
}

export function newTestDir(): string {
	const testDir = mkdtempSync(path.join(os.tmpdir(), 'close-finalizer-test-'));
	mkdirSync(path.join(swarmDir(testDir), 'session'), { recursive: true });
	return testDir;
}

export function cleanupTestDir(testDir: string): void {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}

export function swarmDir(testDir: string): string {
	return path.join(testDir, '.swarm');
}

export async function writePlan(
	testDir: string,
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
	writeFileSync(
		path.join(swarmDir(testDir), 'plan.json'),
		JSON.stringify(plan),
	);
	await initLedger(testDir, derivePlanId(plan), undefined, plan);
}
