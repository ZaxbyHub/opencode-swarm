/**
 * REGRESSION GUARD — issue #660 FR-004, finding F-03.
 *
 * Pins the fix that `phase_complete` acquires the `plan.json` file lock BEFORE
 * it calls `savePlan` (src/tools/phase-complete.ts ~L1519-1629).
 *
 * Prior buggy behavior (what the fix corrected): `executePhaseComplete` updated
 * the phase status and called `savePlan(dir, plan, …)` WITHOUT first acquiring
 * the `plan.json` lock. Because `plan.json` is a read-modify-write file, a
 * concurrent writer (e.g. `save_plan` / `update_task_status`) could interleave
 * and lose the update. The fix wraps the plan write in
 * `tryAcquireLock(dir, 'plan.json', …)` and fails closed when the lock cannot
 * be acquired.
 *
 * How this guard works (and how it fails on revert):
 *   `phase-complete.ts` exposes NO `_internals` seam for `tryAcquireLock` /
 *   `savePlan`, so — mirroring the existing sibling `phase-complete.locking.test.ts`
 *   — this guard drives the full `executePhaseComplete` with module mocks and
 *   records call order. (Invariant 7 prefers native `_internals` DI; no such
 *   seam exists here, so we test against the public surface, which the task
 *   explicitly permits.)
 *
 *   Two assertions catch a revert:
 *     1. Ordering: `tryAcquireLock('plan.json')` is recorded BEFORE `savePlan`,
 *        and both are actually called (path provably exercised).
 *     2. Lock-denied: when the `plan.json` lock is denied (`acquired:false`),
 *        `savePlan` is NOT called and the result is `status:'incomplete'`.
 *
 *   Revert that breaks this guard: deleting the
 *   `tryAcquireLock(dir, 'plan.json', …)` block so `savePlan` runs without the
 *   lock. Then assertion (1) finds no `acquire:plan.json` before `savePlan`, and
 *   assertion (2) sees `savePlan` called even though the lock was denied.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetSwarmState, swarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

// Mock the parallel/file-locks module to control lock acquisition + record order.
vi.mock('../../../src/parallel/file-locks', () => ({
	tryAcquireLock: vi.fn(),
}));

// Mock other dependencies that phase_complete relies on (mirrors the proven
// scaffold in phase-complete.locking.test.ts so executePhaseComplete reaches
// the plan-write code path without real LLM / evidence work).
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
					return { status: 'found', bundle: JSON.parse(content) };
				}
			} catch {
				// fall through
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
	applyCuratorKnowledgeUpdates: vi
		.fn()
		.mockResolvedValue({ applied: 0, skipped: 0 }),
}));

vi.mock('../../../src/hooks/curator-llm-factory.js', () => ({
	createCuratorLLMDelegate: vi.fn().mockReturnValue({
		delegate: vi.fn().mockResolvedValue({ summary: 'test' }),
	}),
}));

vi.mock('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: vi
		.fn()
		.mockResolvedValue({ stored: 0, skipped: 0, rejected: 0 }),
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
			phase_complete: { enabled: true, required_agents: [], policy: 'warn' },
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
	KnowledgeConfigSchema: { parse: vi.fn().mockReturnValue({}) },
	stripKnownSwarmPrefix: vi.fn().mockImplementation((name: string) => name),
}));

// Import mocked modules after vi.mock calls.
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { savePlan } from '../../../src/plan/manager';
import { ensureAgentSession } from '../../../src/state';

const mockTryAcquireLock = tryAcquireLock as ReturnType<typeof vi.fn>;
const mockSavePlan = savePlan as ReturnType<typeof vi.fn>;

function acquiredLock(filePath: string) {
	return {
		acquired: true as const,
		lock: {
			filePath,
			agent: 'phase-complete',
			taskId: `phase-complete-${filePath}`,
			timestamp: new Date().toISOString(),
			expiresAt: Date.now() + 300000,
			_release: vi.fn().mockResolvedValue(undefined),
		},
	};
}

describe('phase_complete — regression: acquires plan.json lock before savePlan (F-03)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-f03-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tempDir, '.swarm', 'events.jsonl'), '', 'utf-8');
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				migration_status: 'migrated',
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
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
		// vi.clearAllMocks resets the savePlan default-resolve, so re-arm it.
		mockSavePlan.mockResolvedValue(undefined);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	test('plan.json lock is acquired BEFORE savePlan, and both are exercised', async () => {
		const order: string[] = [];
		mockTryAcquireLock.mockImplementation(
			async (_dir: string, filePath: string) => {
				order.push(`acquire:${filePath}`);
				return acquiredLock(filePath);
			},
		);
		mockSavePlan.mockImplementation(async () => {
			order.push('savePlan');
		});

		const result = await executePhaseComplete(
			{ phase: 1, sessionID: 'test-session' },
			tempDir,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(true);

		// Both the plan.json lock acquisition and savePlan must have happened.
		expect(order).toContain('acquire:plan.json');
		expect(order).toContain('savePlan');

		// The plan.json lock must be acquired strictly before savePlan runs.
		const acquireIdx = order.indexOf('acquire:plan.json');
		const saveIdx = order.indexOf('savePlan');
		expect(acquireIdx).toBeGreaterThanOrEqual(0);
		expect(saveIdx).toBeGreaterThan(acquireIdx);
	});

	test('when plan.json lock is denied, savePlan is NOT called and result is incomplete', async () => {
		// events.jsonl lock succeeds (soft-fail append log); plan.json lock denied.
		mockTryAcquireLock.mockImplementation(
			async (_dir: string, filePath: string) => {
				if (filePath === 'plan.json') {
					return { acquired: false as const };
				}
				return acquiredLock(filePath);
			},
		);

		const result = await executePhaseComplete(
			{ phase: 1, sessionID: 'test-session' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		// Fail-closed: the plan must NOT be saved while the lock is held elsewhere.
		expect(mockSavePlan).not.toHaveBeenCalled();
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('incomplete');
		expect(parsed.message).toContain('Plan write blocked: plan.json is locked');
	});
});
