/**
 * #3915 AC5 — RED at base, GREEN after the fix.
 *
 * Deterministic contention-classification test for phase_complete. The
 * critical-directive gate is preflight check #1 and reads the knowledge-
 * receipt ledger under the same exclusive receipt lock a concurrent winner
 * holds during its commit-phase receipt writes. When that read times out
 * (bounded 500 ms in knowledge-receipt-ledger-storage), the gate FAILS
 * CLOSED, and at base the tool reports the directive-gate failure class —
 * `status: 'blocked'` / `reason: 'DIRECTIVE_GATE_FAILED_CLOSED'` with the
 * retry recovery buried inside `gate_report.entries[critical_directives]` —
 * instead of the contract-pinned plan-commit contention class that the
 * plan-lock branch emits: `status: 'incomplete'` / `reason:
 * 'PHASE_COMMIT_LOCKED'` with a TOP-LEVEL `recovery: {kind:'retry',
 * action:'phase_complete'}`. The receipt-lock timeout IS a retryable
 * contention class (the gate itself labels it `RECEIPT_LOCK_TIMEOUT` with
 * `recovery: {kind:'retry', action:'phase_complete'}`), so the losing caller
 * must receive the retryable incomplete classification, not a blocked one.
 *
 * The contention is produced DETERMINISTICALLY, not by load: the test holds
 * `.swarm/knowledge-receipts-v2.lock` with a live-owner record (this
 * process's pid, fresh timestamp, matching root identity), which the ledger's
 * stale-lock recovery must respect, so the gate's bounded read times out on
 * every run. The plan lock is stubbed contended in BOTH legs (the losing
 * caller never reaches it at base — that ordering IS the defect).
 *
 * CONTROL leg (expected PASS at base): gate healthy + plan lock contended →
 * the plan-lock branch contract holds (mirrors the existing passing
 * lock-adversarial leg). The receipt-lock-timeout leg is the one that fails
 * at base.
 *
 * Harness mirrors tests/unit/tools/phase-complete.lock-adversarial.test.ts
 * (module-level vi.mock of the same seams, executePhaseComplete invocation,
 * JSON.parse of the string result). Synthetic state only.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as realFileLocks from '../../../src/parallel/file-locks';
import { resetSwarmState, swarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { withFrozenClock } from '../../helpers/test-clock';

// -----------------------------------------------------------------------
// Module-level mocks — MUST be before any import of the mocked modules.
// Same seam set as phase-complete.lock-adversarial.test.ts.
// F-006: spread real exports so mock isolation does not drop sibling
// exports that other tests in the shared Bun process may need.
// -----------------------------------------------------------------------
vi.mock('../../../src/parallel/file-locks', () => ({
	...realFileLocks,
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
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		migration_status: 'migrated',
		phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
	}),
	savePlan: vi.fn().mockResolvedValue({ durability: 'complete' }),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));
vi.mock('../../../src/session/snapshot-writer', () => ({
	flushPendingSnapshot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/telemetry', () => ({
	telemetry: {
		prmHardStopTerminal: () => {},
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

// -----------------------------------------------------------------------
// Imports AFTER vi.mock
// -----------------------------------------------------------------------
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { ensureAgentSession } from '../../../src/state';

const mockTryAcquireLock = tryAcquireLock as ReturnType<typeof vi.fn>;

/** The exclusive receipt-lock file the gate's bounded read must acquire. */
const RECEIPT_LOCK_RELATIVE = path.join('.swarm', 'knowledge-receipts-v2.lock');

/**
 * Hold the receipt ledger lock with a LIVE-owner record: this process's pid,
 * a fresh timestamp, and the canonical root identity. The ledger's
 * stale-lock recovery must respect a live owner, so the gate's bounded
 * (~500 ms) read times out deterministically instead of recovering the lock.
 */
function holdReceiptLock(tempDir: string): void {
	fs.mkdirSync(path.dirname(path.join(tempDir, RECEIPT_LOCK_RELATIVE)), {
		recursive: true,
	});
	const owner = {
		owner_token: `contention-test-${Date.now()}`,
		pid: process.pid,
		created_at_ms: Date.now(),
		root_identity: fs.realpathSync(tempDir),
	};
	fs.writeFileSync(
		path.join(tempDir, RECEIPT_LOCK_RELATIVE),
		`${JSON.stringify(owner)}\n`,
		'utf-8',
	);
}

function writeRetroBundle(directory: string, phaseNumber: number): void {
	const retroDir = path.join(
		directory,
		'.swarm',
		'evidence',
		`retro-${phaseNumber}`,
	);
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: `retro-${phaseNumber}`,
			created_at: '1970-01-01T00:00:00.000Z',
			updated_at: '1970-01-01T00:00:00.000Z',
			entries: [
				{
					task_id: `retro-${phaseNumber}`,
					type: 'retrospective',
					timestamp: '1970-01-01T00:00:00.000Z',
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					phase_number: phaseNumber,
					total_tool_calls: 10,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: ['test lesson'],
				},
			],
		}),
	);
}

describe('phase_complete contention classification (#3915 AC5)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('phase-contention-3915-');
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// .swarm directory + evidence dir
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), {
			recursive: true,
		});

		// plan.json so loadPlan doesn't throw (kept for parity with the
		// adversarial harness; loadPlan itself is mocked)
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

		fs.writeFileSync(path.join(tempDir, '.swarm', 'events.jsonl'), '', 'utf-8');

		// Valid retro bundle for phase 1
		writeRetroBundle(tempDir, 1);

		// Reset state
		resetSwarmState();
		swarmState.activeAgent.set('current', 'test-agent');

		const session = ensureAgentSession('test-session', 'test-agent', tempDir);
		session.phaseAgentsDispatched = new Set();
		session.lastPhaseCompleteTimestamp = 0;

		vi.clearAllMocks();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		// Retried EBUSY/EPERM removal (#2322 lock-release race class).
		try {
			safeRmRecursive(tempDir);
		} catch {
			/* retries exhausted — leave the dir to the OS */
		}
		resetSwarmState();
	});

	// =====================================================================
	// CONTROL — gate healthy, plan lock contended (expected PASS at base).
	// Mirrors the existing passing lock-adversarial leg.
	// =====================================================================
	test('CONTROL: plan-lock contention with a healthy gate reports the retryable PHASE_COMMIT_LOCKED class', async () => {
		mockTryAcquireLock.mockImplementation(() => ({
			acquired: false,
		}));

		const result = await executePhaseComplete(
			{ phase: 1, sessionID: 'test-session' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('incomplete');
		expect(parsed.reason).toBe('PHASE_COMMIT_LOCKED');
		expect(parsed.message).toContain('Plan write is locked by another agent');
		expect(parsed.recovery).toEqual({
			kind: 'retry',
			action: 'phase_complete',
		});
		expect(parsed.errors[0]).toContain('Concurrent plan write detected');
	}, 120_000);

	// =====================================================================
	// DEFECT — receipt-lock contention reaches the gate first. RED at base:
	// the directive-gate fail-closed classification wins over the plan-commit
	// contention class.
	// =====================================================================
	test('AC5: receipt-lock contention under a contended plan lock still reports the retryable PHASE_COMMIT_LOCKED class', async () => {
		// Plan lock contended (the loser must never acquire it either way).
		mockTryAcquireLock.mockImplementation(() => ({
			acquired: false,
		}));
		// Hold the receipt ledger lock with a live-owner record so the
		// critical-directive gate's bounded read times out deterministically.
		withFrozenClock(() => {
			holdReceiptLock(tempDir);
		});

		const result = await executePhaseComplete(
			{ phase: 1, sessionID: 'test-session' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		// RED at base: received status 'blocked' / reason
		// 'DIRECTIVE_GATE_FAILED_CLOSED' (the directive-gate fail-closed class
		// short-circuits before the plan-lock branch).
		expect(parsed.status).toBe('incomplete');
		expect(parsed.reason).toBe('PHASE_COMMIT_LOCKED');
		// The retry recovery must sit at the TOP level of the payload, not
		// only inside the gate report entry.
		expect(parsed.recovery).toEqual({
			kind: 'retry',
			action: 'phase_complete',
		});
	}, 120_000);
});
