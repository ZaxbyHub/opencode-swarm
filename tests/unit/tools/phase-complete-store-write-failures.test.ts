/**
 * #2039 split (FR-006): the events-store write-failure scenarios moved
 * out of phase-complete.lock-adversarial.test.ts so that over-cap file
 * does not grow. Scaffolding mirrors the parent suite.
 */
/**
 * Adversarial locking + path traversal tests for phase_complete tool.
 * Targets: lock contention, working_directory path traversal, events.jsonl write failures,
 * extreme phase/summary boundary values.
 *
 * These tests complement phase-complete.adversarial.test.ts (sessionID/summary injection)
 * and phase-complete.locking.test.ts (mocked lock behavior).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { newestEventLine } from '../../helpers/event-lines.js';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/** Deterministic fixture timestamp (test-clock lint, issue #1782). */
const FIXED_TS = withFrozenClock(() => new Date().toISOString());

import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as coreEventsInternals } from '../../../src/events/core-events.js';
import { resetSwarmState, swarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

// -----------------------------------------------------------------------
// Module-level mocks — MUST be before any import of the mocked module
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

// -----------------------------------------------------------------------
// Imports AFTER vi.mock
// -----------------------------------------------------------------------
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { ensureAgentSession } from '../../../src/state';

const mockTryAcquireLock = tryAcquireLock as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helper: write valid retro bundle
// ---------------------------------------------------------------------------
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
			created_at: FIXED_TS,
			updated_at: FIXED_TS,
			entries: [
				{
					task_id: `retro-${phaseNumber}`,
					type: 'retrospective',
					timestamp: FIXED_TS,
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('phase_complete adversarial locking + path tests', () => {
	// #2039: the events store lock is the seam's wx lock — assert no leak.
	const storeLockGone = () =>
		expect(fs.existsSync(path.join(tempDir, '.swarm', 'events.lock'))).toBe(
			false,
		);
	// #2039: line 1 is the swarm-events-manifest header — newest EVENT line.
	const newestEvent = (p2: string): Record<string, unknown> =>
		JSON.parse(newestEventLine(fs.readFileSync(p2, 'utf-8')));
	let tempDir: string;
	let originalCwd: string;
	let eventsPath: string;
	let parentDir: string;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('phase-adversarial-');
		parentDir = path.dirname(tempDir);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// .swarm directory
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.swarm', 'evidence'), { recursive: true });

		// plan.json so loadPlan doesn't throw
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

		eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
		fs.writeFileSync(eventsPath, '', 'utf-8');

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
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		resetSwarmState();
	});

	describe('events.jsonl write failures', () => {
		test('write to a directory (not a file) adds warning but returns success', async () => {
			// Lock succeeds but events.jsonl is a directory → write throws
			const release = vi.fn().mockResolvedValue(undefined);
			const planRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockImplementation(
				(_dir: string, filePath: string) => {
					if (filePath === 'events.jsonl') {
						return {
							acquired: true,
							lock: {
								filePath: 'events.jsonl',
								agent: 'phase-complete',
								taskId: 'phase-complete-test',
								timestamp: FIXED_TS,
								expiresAt: Date.now() + 300000,
								_release: release,
							},
						};
					}
					// plan.json also acquired
					return {
						acquired: true,
						lock: {
							filePath: 'plan.json',
							agent: 'phase-complete',
							taskId: 'phase-complete-plan-test',
							timestamp: FIXED_TS,
							expiresAt: Date.now() + 300000,
							_release: planRelease,
						},
					};
				},
			);

			// Replace file with directory
			fs.rmSync(eventsPath);
			fs.mkdirSync(eventsPath);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Phase must still report success (write failure → warning, not error)
			expect(parsed.success).toBe(true);
			expect(
				parsed.warnings.some((w: string) =>
					w.includes('failed to write phase complete event'),
				),
			).toBe(true);
			// #2039: the seam's store lock is released via unlink-in-finally.
			storeLockGone();
		});

		test('read-only filesystem: appendFileSync throws EPERM, warning is added', async () => {
			const release = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'events.jsonl',
					agent: 'phase-complete',
					taskId: 'phase-complete-test',
					timestamp: FIXED_TS,
					expiresAt: Date.now() + 300000,
					_release: release,
				},
			});

			// Mock the seam's append to throw EPERM once — chmod is unreliable as
			// root in CI, and the store captured fs.appendFileSync at module
			// init, so the seam's _internals is the interception point (#2039).
			const realAppend = coreEventsInternals.appendFileSync;
			(
				coreEventsInternals as {
					appendFileSync: typeof fs.appendFileSync;
				}
			).appendFileSync = (() => {
				const err = Object.assign(new Error('EPERM: operation not permitted'), {
					code: 'EPERM',
				});
				throw err;
			}) as typeof fs.appendFileSync;
			try {
				const result = await executePhaseComplete(
					{ phase: 1, sessionID: 'test-session' },
					tempDir,
				);
				const parsed = JSON.parse(result);

				// Must not throw
				expect(parsed.success).toBe(true);
				// Write failure warning must be present
				expect(
					parsed.warnings.some((w: string) =>
						w.includes('failed to write phase complete event'),
					),
				).toBe(true);
			} finally {
				(
					coreEventsInternals as {
						appendFileSync: typeof fs.appendFileSync;
					}
				).appendFileSync = realAppend;
			}
		});

		test('events.jsonl missing (deleted after lock acquired) — appendFileSync creates it', async () => {
			const release = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'events.jsonl',
					agent: 'phase-complete',
					taskId: 'phase-complete-test',
					timestamp: FIXED_TS,
					expiresAt: Date.now() + 300000,
					_release: release,
				},
			});

			// Delete events.jsonl after lock acquired but before write
			// (simulate race between lock acquisition and write)
			mockTryAcquireLock.mockResolvedValueOnce({
				acquired: true,
				lock: {
					filePath: 'events.jsonl',
					agent: 'phase-complete',
					taskId: 'phase-complete-test',
					timestamp: FIXED_TS,
					expiresAt: Date.now() + 300000,
					_release: release,
				},
			});

			// Delete file
			fs.rmSync(eventsPath);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// appendFileSync creates missing files — should succeed
			expect(parsed.success).toBe(true);
			const event = newestEvent(eventsPath);
			expect(event.event).toBe('phase_complete');
		});
	});

	// =======================================================================
	// WORKING_DIRECTORY PATH TRAVERSAL
	// resolveWorkingDirectory is called at runtime by createSwarmTool's execute callback.
	// executePhaseComplete is tested directly, bypassing the createSwarmTool wrapper,
	// so we test the ACTUAL behavior (no mock intercept possible for direct calls).
	// Key insight: realpathSync resolves traversal paths to real dirs, so the
	// traversal check passes, and execution reaches the RETROSPECTIVE_MISSING gate.
	// =======================================================================
});
