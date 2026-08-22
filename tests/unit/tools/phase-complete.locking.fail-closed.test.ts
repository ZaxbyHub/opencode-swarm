/**
 * Locking fail-closed verification tests for phase-complete.ts
 *
 * Extracted from phase-complete.locking.test.ts to keep the diff-scoped
 * FR-006 cap under control while preserving the same mocked setup.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPlan } from '../../../src/plan/manager';
import { resetSwarmState, swarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

vi.mock('../../../src/parallel/file-locks', () => ({
	tryAcquireLock: vi.fn(),
}));

vi.mock('../../../src/evidence/manager', () => ({
	listEvidenceTaskIds: vi.fn().mockResolvedValue([]),
	loadEvidence: vi.fn().mockImplementation((_dir: string, taskId: string) => {
		if (taskId.startsWith('retro-')) {
			try {
				const retroPath = path.join(
					_dir,
					'.swarm',
					'evidence',
					taskId,
					'evidence.json',
				);
				if (fs.existsSync(retroPath)) {
					const content = fs.readFileSync(retroPath, 'utf-8');
					const bundle = JSON.parse(content);
					return { status: 'found', bundle };
				}
			} catch {
				// Fall through to not_found
			}
		}
		return { status: 'not_found' };
	}),
}));

vi.mock('../../../src/hooks/curator', () => ({
	runCuratorPhase: vi.fn().mockResolvedValue({
		digest: { summary: 'test' },
		knowledge_recommendations: [],
		compliance: [],
	}),
	applyCuratorKnowledgeUpdates: vi.fn().mockResolvedValue({
		applied: 0,
		skipped: 0,
	}),
}));

vi.mock('../../../src/hooks/curator-llm-factory.js', () => ({
	createCuratorLLMDelegate: vi.fn().mockReturnValue({
		delegate: vi.fn().mockResolvedValue({ summary: 'test' }),
	}),
}));

vi.mock('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: vi.fn().mockResolvedValue({
		stored: 0,
		skipped: 0,
		rejected: 0,
	}),
}));

vi.mock('../../../src/hooks/knowledge-reader.js', () => ({
	updateRetrievalOutcome: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/hooks/review-receipt.js', () => ({
	buildApprovedReceipt: vi.fn().mockReturnValue({}),
	buildRejectedReceipt: vi.fn().mockReturnValue({}),
	persistReviewReceipt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/plan/checkpoint', () => ({
	writeCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/plan/ledger', () => ({
	ledgerExists: vi.fn().mockResolvedValue(false),
	replayFromLedger: vi.fn().mockResolvedValue(null),
	takeSnapshotEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/plan/manager', () => ({
	loadPlan: vi.fn().mockResolvedValue({
		phases: [{ id: 1, status: 'in_progress', tasks: [] }],
	}),
	savePlan: vi.fn().mockResolvedValue(undefined),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));

vi.mock('../../../src/session/snapshot-writer', () => ({
	flushPendingSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/telemetry', () => ({
	telemetry: {
		phaseChanged: vi.fn(),
		sessionStarted: vi.fn(),
		agentActivated: vi.fn(),
	},
}));

vi.mock('../../../src/tools/completion-verify', () => ({
	executeCompletionVerify: vi
		.fn()
		.mockResolvedValue(JSON.stringify({ status: 'passed' })),
}));

vi.mock('../../../src/hooks/utils', () => ({
	validateSwarmPath: vi
		.fn()
		.mockImplementation((_dir: string, file: string) =>
			path.join(_dir, '.swarm', file),
		),
}));

vi.mock('../../../src/config', () => ({
	loadPluginConfigWithMeta: vi.fn().mockReturnValue({
		config: {
			phase_complete: {
				enabled: true,
				required_agents: [],
				policy: 'warn',
			},
			curator: { enabled: false },
			knowledge: {},
		},
	}),
}));

vi.mock('../../../src/config/schema', () => ({
	PhaseCompleteConfigSchema: {
		parse: vi.fn().mockImplementation((cfg) => ({
			enabled: cfg?.enabled ?? true,
			required_agents: cfg?.required_agents ?? [],
			policy: cfg?.policy ?? 'warn',
		})),
	},
	CuratorConfigSchema: {
		parse: vi.fn().mockReturnValue({ enabled: false, phase_enabled: false }),
	},
	KnowledgeConfigSchema: {
		parse: vi.fn().mockReturnValue({}),
	},
	stripKnownSwarmPrefix: vi.fn().mockImplementation((name: string) => name),
}));

import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { ensureAgentSession } from '../../../src/state';

const mockTryAcquireLock = tryAcquireLock as ReturnType<typeof vi.fn>;

describe('executePhaseComplete locking fail-closed behavior', () => {
	let tempDir: string;
	let originalCwd: string;
	let eventsPath: string;
	let restoreClock: () => void;

	beforeEach(() => {
		restoreClock = freezeClock({
			fixedNow: 1_704_067_200_000,
			isoNow: '2024-01-01T00:00:00.000Z',
		});
		tempDir = canonicalMkdtemp('phase-complete-lock-test-');
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
		fs.writeFileSync(eventsPath, '', 'utf-8');

		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				migration_status: 'migrated',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [],
					},
				],
			}),
		);

		const retroDir = path.join(tempDir, '.swarm', 'evidence', 'retro-1');
		fs.mkdirSync(retroDir, { recursive: true });
		fs.writeFileSync(
			path.join(retroDir, 'evidence.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				task_id: 'retro-1',
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				entries: [
					{
						task_id: 'retro-1',
						type: 'retrospective',
						timestamp: new Date().toISOString(),
						agent: 'architect',
						verdict: 'pass',
						summary: 'Phase 1 completed',
						phase_number: 1,
						total_tool_calls: 10,
						coder_revisions: 1,
						reviewer_rejections: 0,
						test_failures: 0,
						security_findings: 0,
						integration_issues: 0,
						task_count: 1,
						task_complexity: 'simple',
						top_rejection_reasons: [],
						lessons_learned: [],
					},
				],
			}),
		);

		resetSwarmState();
		swarmState.activeAgent.set('current', 'test-agent');

		const session = ensureAgentSession('test-session', 'test-agent', tempDir);
		session.phaseAgentsDispatched = new Set();
		session.lastPhaseCompleteTimestamp = 0;

		vi.clearAllMocks();
	});

	afterEach(() => {
		restoreClock();
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('Group 3: Write Always Happens', () => {
		test('no event is written when lock acquisition fails completely (exception)', async () => {
			mockTryAcquireLock.mockRejectedValue(new Error('Filesystem error'));

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			expect(eventsContent.trim()).toBe('');
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.reason).toBe('PHASE_COMMIT_LOCK_ERROR');
			expect(parsed.message).toContain(
				'Failed to acquire the guarded phase commit lock',
			);
			expect(parsed.message).toContain('Filesystem error');
			expect(parsed.recovery).toEqual({
				kind: 'retry',
				action: 'phase_complete',
			});
		});

		test('phase_complete returns failure when lock acquisition returns acquired=false', async () => {
			mockTryAcquireLock.mockResolvedValue({
				acquired: false,
			});

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.reason).toBe('PHASE_COMMIT_LOCKED');
			expect(parsed.message).toContain(
				'Plan write is locked by another agent.',
			);
			expect(parsed.recovery).toEqual({
				kind: 'retry',
				action: 'phase_complete',
			});
		});

		test('event is written even when lock acquisition succeeds but write happens after', async () => {
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'events.jsonl',
					agent: 'phase-complete',
					taskId: 'phase-complete-123',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: mockRelease,
				},
			});

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const eventLine = eventsContent.trim().split('\n').filter(Boolean)[0];
			const writtenEvent = JSON.parse(eventLine);
			expect(writtenEvent.event).toBe('phase_complete');
		});
	});

	describe('Group 6: F-08 Atomic Fallback', () => {
		test('when loadPlan returns null and no ledger exists, phase_complete fails closed without an atomic fallback write', async () => {
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			const planRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockImplementation(
				(_dir: string, filePath: string) => {
					if (filePath === 'events.jsonl') {
						return {
							acquired: true,
							lock: {
								filePath: 'events.jsonl',
								agent: 'phase-complete',
								taskId: 'phase-complete-123',
								timestamp: new Date().toISOString(),
								expiresAt: Date.now() + 300000,
								_release: mockRelease,
							},
						};
					}
					return {
						acquired: true,
						lock: {
							filePath: 'plan.json',
							agent: 'phase-complete',
							taskId: 'phase-complete-plan-123',
							timestamp: new Date().toISOString(),
							expiresAt: Date.now() + 300000,
							_release: planRelease,
						},
					};
				},
			);

			(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue(null);

			const planPath = path.join(tempDir, '.swarm', 'plan.json');
			const planContentBefore = fs.readFileSync(planPath, 'utf-8');

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.reason).toBe('PHASE_PLAN_UNREADABLE');
			expect(parsed.message).toContain(
				'Plan exists but could not be read or rebuilt from the ledger',
			);

			const onDiskPlan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
			expect(JSON.stringify(onDiskPlan)).toBe(planContentBefore);
		});
	});
});
