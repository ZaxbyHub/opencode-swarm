/**
 * Issue #2101 supersedes FR-002's emergency direct writer: phase_complete must
 * fail closed when neither loadPlan nor authoritative ledger replay can supply
 * a plan. An on-disk plan.json projection, whether schema-valid or corrupt,
 * must not be mutated and no legacy fallback-write event may be emitted.
 *
 * phase-complete.ts exposes NO `_internals` seam, so — mirroring the sanctioned
 * sibling scaffold in phase-complete-lock-before-saveplan.regression.test.ts —
 * this drives the full executePhaseComplete via vi.mock against the public
 * surface (the same pattern that regression guard explicitly permits).
 *
 * Path driven: loadPlan -> null AND ledgerExists -> false reaches the typed
 * PHASE_PLAN_UNREADABLE refusal after the guarded commit lock is acquired.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetSwarmState, swarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

// Control lock acquisition (always granted here so the plan-write block runs).
vi.mock('../../../src/parallel/file-locks', () => ({
	tryAcquireLock: vi.fn(),
}));

// Mirror the proven scaffold so executePhaseComplete reaches the plan-write
// path without real LLM / evidence work.
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

// Map validateSwarmPath to the real on-disk .swarm/ path so the fallback writes
// to the temp dir. The real atomicWriteFile (not mocked) performs the write.
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
import { ledgerExists } from '../../../src/plan/ledger';
import { loadPlan } from '../../../src/plan/manager';
import { ensureAgentSession } from '../../../src/state';

const mockTryAcquireLock = tryAcquireLock as ReturnType<typeof vi.fn>;
const mockLoadPlan = loadPlan as ReturnType<typeof vi.fn>;
const mockLedgerExists = ledgerExists as ReturnType<typeof vi.fn>;

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

function writeRetroEvidence(tempDir: string) {
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
}

function readFallbackEvents(tempDir: string) {
	const eventsRaw = fs.readFileSync(
		path.join(tempDir, '.swarm', 'events.jsonl'),
		'utf-8',
	);
	return eventsRaw
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((e) => e.event === 'phase_complete_fallback_write');
}

describe('phase_complete — issue #2101: deprecated direct fallback stays disabled', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-fr002-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.writeFileSync(path.join(tempDir, '.swarm', 'events.jsonl'), '', 'utf-8');
		writeRetroEvidence(tempDir);

		resetSwarmState();
		swarmState.activeAgent.set('current', 'test-agent');
		const session = ensureAgentSession('test-session', 'test-agent', tempDir);
		session.phaseAgentsDispatched = new Set();
		session.lastPhaseCompleteTimestamp = 0;

		vi.clearAllMocks();
		// vi.clearAllMocks wipes default resolves — re-arm per test.
		mockLoadPlan.mockResolvedValue(null);
		mockLedgerExists.mockResolvedValue(false);
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

	test('valid on-disk candidate is not used as a direct-write fallback when authoritative loading fails', async () => {
		const planPath = path.join(tempDir, '.swarm', 'plan.json');
		// Schema-valid on-disk plan (real PlanSchema must accept it).
		fs.writeFileSync(
			planPath,
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
			}),
		);

		const result = await executePhaseComplete(
			{ phase: 1, sessionID: 'test-session' },
			tempDir,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('incomplete');
		expect(parsed.reason).toBe('PHASE_PLAN_UNREADABLE');

		// The on-disk projection is not authoritative and remains unchanged.
		const persisted = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
		expect(persisted.phases[0].status).toBe('in_progress');

		// No deprecated fallback event is emitted because no write occurred.
		expect(readFallbackEvents(tempDir)).toEqual([]);
	});

	test('schema-invalid candidate is not persisted and returns the same typed authoritative-plan failure', async () => {
		const planPath = path.join(tempDir, '.swarm', 'plan.json');
		// JSON-valid but schema-INVALID: missing schema_version/title/swarm and the
		// phase is missing the required `name`. phaseObj (id===1) is still found and
		// mutated in-memory, so the only thing standing between it and persistence is
		// the new PlanSchema validation gate.
		fs.writeFileSync(
			planPath,
			JSON.stringify({
				phases: [{ id: 1, status: 'in_progress' }],
			}),
		);

		const result = await executePhaseComplete(
			{ phase: 1, sessionID: 'test-session' },
			tempDir,
		);
		const parsed = JSON.parse(result);
		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('incomplete');
		expect(parsed.reason).toBe('PHASE_PLAN_UNREADABLE');

		// Corrupt candidate must NOT be persisted — on-disk plan is unchanged.
		const persisted = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
		expect(persisted.phases[0].status).toBe('in_progress');

		// No traceability event written for a refused write.
		expect(readFallbackEvents(tempDir).length).toBe(0);

		expect(parsed.message).toContain(
			'Plan exists but could not be read or rebuilt from the ledger',
		);
	});
});
