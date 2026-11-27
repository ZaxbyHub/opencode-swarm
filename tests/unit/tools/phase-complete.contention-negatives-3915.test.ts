/**
 * #3915 AC5 — negative and per-path legs for the contention classification.
 *
 * The frozen contract test (phase-complete.contention-classification-3915.test.ts)
 * pins the primary path: receipt-lock contention under a contended plan lock
 * reports the retryable PHASE_COMMIT_LOCKED class. This file pins the
 * remaining surface:
 *  - NEGATIVE: a genuine RECEIPT_CORRUPT fail-closed stays
 *    blocked/DIRECTIVE_GATE_FAILED_CLOSED (the remap is contention-only, and
 *    no top-level retry recovery is invented for it).
 *  - Receipt-lock timeout WITHOUT plan-lock contention still returns the
 *    retryable incomplete class (the classification comes from the shared
 *    receipt lock, not the plan lock).
 *  - The locked-region preflight re-run (inside the plan lock, before the
 *    close-intent write) classifies the same contention as incomplete, not
 *    PHASE_PREFLIGHT_STALE.
 *  - The commit-phase preflight re-run (after the close intent) classifies
 *    the same contention as incomplete, not PHASE_PREFLIGHT_STALE.
 *
 * Harness mirrors the frozen test (module-level vi.mock of the same seams).
 * The knowledge-receipt ledger itself is REAL: contention is produced
 * deterministically by holding .swarm/knowledge-receipts-v2.lock with a
 * live-owner record, and the corrupt leg corrupts the receipt journal after
 * seeding one displayed membership.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSwarmState, swarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// -----------------------------------------------------------------------
// Module-level mocks — MUST be before any import of the mocked modules.
// Same seam set as phase-complete.contention-classification-3915.test.ts.
// -----------------------------------------------------------------------
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

import { commitDisplayedMembership } from '../../../src/hooks/knowledge-receipt-ledger.js';
// -----------------------------------------------------------------------
// Imports AFTER vi.mock
// -----------------------------------------------------------------------
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { ensureAgentSession } from '../../../src/state';
import { phaseCompleteReceiptInternals } from '../../../src/tools/phase-complete';

const mockTryAcquireLock = tryAcquireLock as ReturnType<typeof vi.fn>;

/** The exclusive receipt-lock file the gate's bounded read must acquire. */
const RECEIPT_LOCK_RELATIVE = path.join('.swarm', 'knowledge-receipts-v2.lock');

/**
 * Hold the receipt ledger lock with a LIVE-owner record (this process's pid,
 * fresh timestamp, canonical root identity) so the directive gate's bounded
 * read times out deterministically.
 */
function holdReceiptLock(tempDir: string): void {
	fs.mkdirSync(path.dirname(path.join(tempDir, RECEIPT_LOCK_RELATIVE)), {
		recursive: true,
	});
	const owner = {
		owner_token: `contention-negative-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 8)}`,
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

/** Plan lock (and every other tryAcquireLock target) acquires cleanly. */
function acquireAllLocks(): void {
	mockTryAcquireLock.mockImplementation(() => ({
		acquired: true,
		lock: {
			filePath: 'plan.json',
			agent: 'phase-complete',
			taskId: 'phase-complete-plan-test',
			timestamp: new Date().toISOString(),
			expiresAt: Date.now() + 300_000,
			_release: vi.fn().mockResolvedValue(undefined),
		},
	}));
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

describe('phase_complete contention classification negatives (#3915 AC5)', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('phase-contention-neg-3915-');
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });
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
		fs.writeFileSync(path.join(tempDir, '.swarm', 'events.jsonl'), '', 'utf-8');
		writeRetroBundle(tempDir, 1);

		resetSwarmState();
		swarmState.activeAgent.set('current', 'test-agent');
		const session = ensureAgentSession('test-session', 'test-agent', tempDir);
		session.phaseAgentsDispatched = new Set();
		session.lastPhaseCompleteTimestamp = 0;

		vi.clearAllMocks();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			safeRmRecursive(tempDir);
		} catch {
			/* retries exhausted — leave the dir to the OS */
		}
		resetSwarmState();
	});

	test('NEGATIVE: a genuine RECEIPT_CORRUPT fail-closed stays blocked and keeps the repair recovery nested', async () => {
		// Root marker + one seeded critical membership, then a corrupted
		// journal — the lightest deterministic fail-closed seam (mirrors the
		// hooks-level corrupt legs).
		fs.writeFileSync(path.join(tempDir, '.git'), 'gitdir: fixture');
		const seeded = await commitDisplayedMembership(tempDir, {
			trace_id: 'trace-corrupt-neg',
			session_id: 'test-session',
			phase: 'Phase 1',
			entries: [{ entry_id: 'c1', critical: true }],
		});
		expect(seeded.ok).toBe(true);
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'knowledge-receipts-v2.jsonl'),
			'corrupt\n',
		);
		// Plan lock FREE — the blocked classification cannot be plan contention.
		withFrozenClock(() => {
			acquireAllLocks();
		});

		const parsed = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			),
		);

		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('blocked');
		expect(parsed.reason).toBe('DIRECTIVE_GATE_FAILED_CLOSED');
		// The contention-only remap must not invent a top-level retry recovery
		// for a permanent (corrupt-store) failure.
		expect(parsed.recovery).toBeUndefined();
		const directiveEntry = parsed.gate_report.entries.find(
			(entry: { id: string }) => entry.id === 'critical_directives',
		);
		expect(directiveEntry.code).toBe('DIRECTIVE_GATE_FAILED_CLOSED');
		expect(directiveEntry.recovery).toEqual({
			kind: 'tool',
			action: 'repair_knowledge_receipt_ledger',
		});
	}, 120_000);

	test('receipt-lock timeout WITHOUT plan-lock contention still reports the retryable incomplete class', async () => {
		withFrozenClock(() => {
			acquireAllLocks();
			holdReceiptLock(tempDir);
		});

		const parsed = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			),
		);

		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('incomplete');
		expect(parsed.reason).toBe('PHASE_COMMIT_LOCKED');
		expect(parsed.recovery).toEqual({
			kind: 'retry',
			action: 'phase_complete',
		});
		const directiveEntry = parsed.gate_report.entries.find(
			(entry: { id: string }) => entry.id === 'critical_directives',
		);
		expect(directiveEntry.code).toBe('PHASE_COMMIT_LOCKED');
		expect(directiveEntry.recovery).toEqual({
			kind: 'retry',
			action: 'phase_complete',
		});
	}, 120_000);

	test('locked-region preflight re-run classifies receipt-lock contention as incomplete, not stale', async () => {
		// The receipt lock is taken over BETWEEN the initial (healthy)
		// preflight and the locked re-run: the plan-lock acquisition call is
		// the deterministic interleaving point.
		withFrozenClock(() => {
			mockTryAcquireLock.mockImplementation(
				(_dir: string, filePath: string) => {
					if (filePath === 'plan.json') holdReceiptLock(tempDir);
					return {
						acquired: true,
						lock: {
							filePath,
							agent: 'phase-complete',
							taskId: 'phase-complete-plan-test',
							timestamp: new Date().toISOString(),
							expiresAt: Date.now() + 300_000,
							_release: vi.fn().mockResolvedValue(undefined),
						},
					};
				},
			);
		});

		const parsed = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			),
		);

		expect(parsed.success).toBe(false);
		expect(parsed.status).toBe('incomplete');
		expect(parsed.reason).toBe('PHASE_COMMIT_LOCKED');
		expect(parsed.message).toContain(
			'concurrent knowledge-receipt ledger writers',
		);
		expect(parsed.recovery).toEqual({
			kind: 'retry',
			action: 'phase_complete',
		});
		expect(parsed.gate_report.entries[0].code).toBe('PHASE_COMMIT_LOCKED');
	}, 120_000);

	test('commit-phase preflight re-run classifies receipt-lock contention as incomplete, not stale', async () => {
		acquireAllLocks();
		// The receipt lock is taken over at the close-intent boundary (after
		// the locked revalidation passed, before the commit re-run), stubbed
		// through the receipt internals seam.
		const originalIntent = phaseCompleteReceiptInternals.recordPhaseCloseIntent;
		phaseCompleteReceiptInternals.recordPhaseCloseIntent = (async () => {
			withFrozenClock(() => {
				holdReceiptLock(tempDir);
			});
			return { ok: true, event_id: 'intent-event' };
		}) as typeof originalIntent;
		try {
			const parsed = JSON.parse(
				await executePhaseComplete(
					{ phase: 1, sessionID: 'test-session' },
					tempDir,
				),
			);

			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.reason).toBe('PHASE_COMMIT_LOCKED');
			expect(parsed.message).toContain(
				'concurrent knowledge-receipt ledger writers',
			);
			expect(parsed.recovery).toEqual({
				kind: 'retry',
				action: 'phase_complete',
			});
			expect(parsed.gate_report.entries[0].code).toBe('PHASE_COMMIT_LOCKED');
		} finally {
			phaseCompleteReceiptInternals.recordPhaseCloseIntent = originalIntent;
		}
	}, 120_000);
});
