/**
 * FR-002 (issue #660 / F-08): the last-resort "direct write" emergency fallback
 * in phase_complete must (a) append a traceability event to .swarm/events.jsonl
 * after a successful write, and (b) refuse to persist a schema-invalid candidate.
 *
 * This is NOT a new plan.json writer — it is the EXISTING emergency fallback
 * (src/tools/phase-complete.ts "Last resort: direct write") made validated +
 * traceable. The durable PlanSchema is unchanged; the real PlanSchema is used
 * here (NOT mocked) so the validation gate is meaningful.
 *
 * phase-complete.ts exposes NO `_internals` seam, so — mirroring the sanctioned
 * sibling scaffold in phase-complete-lock-before-saveplan.regression.test.ts —
 * this drives the full executePhaseComplete via vi.mock against the public
 * surface (the same pattern that regression guard explicitly permits).
 *
 * Path driven: loadPlan -> null AND ledgerExists -> false forces the
 * `if (plan === null)` branch straight to the last-resort direct write, which
 * reads the on-disk plan.json (real fs), mutates the phase status, validates,
 * and (only if valid) writes + records the trace event.
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

describe('phase_complete — FR-002: last-resort fallback write is traceable + validated', () => {
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

	test('valid candidate: writes plan.json AND appends a phase_complete_fallback_write trace event', async () => {
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
		expect(parsed.success).toBe(true);

		// (a) plan.json on disk was mutated to complete by the fallback writer.
		const persisted = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
		expect(persisted.phases[0].status).toBe('complete');

		// (b) exactly one traceability event for the fallback write, for phase 1.
		const fallbackEvents = readFallbackEvents(tempDir);
		expect(fallbackEvents.length).toBe(1);
		expect(fallbackEvents[0].phase).toBe(1);
		expect(typeof fallbackEvents[0].timestamp).toBe('string');
	});

	test('schema-invalid candidate: NOT persisted, no trace event, surfaces a validation warning', async () => {
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

		// Corrupt candidate must NOT be persisted — on-disk plan is unchanged.
		const persisted = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
		expect(persisted.phases[0].status).toBe('in_progress');

		// No traceability event written for a refused write.
		expect(readFallbackEvents(tempDir).length).toBe(0);

		// The refusal is surfaced as an actionable warning, not silently swallowed.
		expect(
			parsed.warnings.some((w: string) =>
				w.includes('failed schema validation'),
			),
		).toBe(true);
	});
});
