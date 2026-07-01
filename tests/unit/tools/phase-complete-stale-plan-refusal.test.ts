/**
 * #1269 finding 2: phase_complete must consult the ledger-replay staleness
 * signal (`RuntimePlan._ledgerReplayStale`) and REFUSE to mutate against a
 * known-stale plan, returning structured recovery guidance — rather than
 * relying on a logged warning. The check must sit BEFORE any savePlan / plan.json
 * mutation.
 *
 * Discrimination: the staleness check lives inside `if (success)`, and savePlan
 * is also skipped when success is false. So "savePlan not called" alone is NOT
 * proof the staleness branch fired. This test therefore (1) uses the full
 * success-reaching scaffold (retro evidence + passing completion-verify) and a
 * control case proving that scaffold otherwise reaches savePlan, and (2) asserts
 * the staleness-only signature `_ledgerReplayStaleReason` echoing the exact
 * injected reason — a field that exists ONLY on the refusal branch.
 *
 * phase-complete.ts exposes no `_internals` seam, so this drives the public
 * surface via vi.mock (the pattern the sibling lock regression guard sanctions).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetSwarmState, swarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

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
	loadPlan: vi.fn().mockResolvedValue(null),
	savePlan: vi.fn().mockResolvedValue(undefined),
	savePlanWithAutoAcknowledgedRemovals: vi.fn().mockResolvedValue(undefined),
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
import { loadPlan, savePlan } from '../../../src/plan/manager';
import { ensureAgentSession } from '../../../src/state';

const mockTryAcquireLock = tryAcquireLock as ReturnType<typeof vi.fn>;
const mockLoadPlan = loadPlan as ReturnType<typeof vi.fn>;
const mockSavePlan = savePlan as ReturnType<typeof vi.fn>;

const STALE_REASON = 'ledger replay threw: synthetic boom';

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

describe('phase_complete — #1269 finding 2: refuse to complete against a stale plan', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-stale-')),
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
		mockSavePlan.mockResolvedValue(undefined);
		mockTryAcquireLock.mockImplementation(async (_dir: string, file: string) =>
			acquiredLock(file),
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	test('stale plan: refuses with recovery guidance, echoes reason, does NOT savePlan', async () => {
		mockLoadPlan.mockResolvedValue({
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
			_ledgerReplayStale: true,
			_ledgerReplayStaleReason: STALE_REASON,
		});

		const result = await executePhaseComplete(
			{ phase: 1, sessionID: 'test-session' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		// Structured refusal — not silent mutation.
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('incomplete');
		// staleness-only signature: this field exists ONLY on the refusal branch,
		// and it echoes the exact injected reason, proving the check fired.
		expect(parsed._ledgerReplayStaleReason).toBe(STALE_REASON);
		expect(parsed.message).toContain('stale');
		expect(parsed.message).toContain('ledger replay');
		// Actionable recovery guidance is present.
		expect(typeof parsed.recovery_guidance).toBe('string');
		expect(parsed.recovery_guidance.length).toBeGreaterThan(0);

		// The plan must NOT be saved/mutated against the stale plan.
		expect(mockSavePlan).not.toHaveBeenCalled();
	});

	test('control: non-stale plan with the same scaffold DOES reach savePlan', async () => {
		// Same success-reaching scaffold, but the plan is NOT stale. This proves the
		// staleness refusal above is caused by the staleness signal — not by the
		// scaffold failing to reach the write path.
		mockLoadPlan.mockResolvedValue({
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
		});

		const result = await executePhaseComplete(
			{ phase: 1, sessionID: 'test-session' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed._ledgerReplayStaleReason).toBeUndefined();
		expect(mockSavePlan).toHaveBeenCalled();
	});
});
