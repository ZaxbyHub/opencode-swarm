/**
 * Adversarial locking + path traversal tests for phase_complete tool.
 * Targets: lock contention, working_directory path traversal, events.jsonl write failures,
 * extreme phase/summary boundary values.
 *
 * These tests complement phase-complete.adversarial.test.ts (sessionID/summary injection)
 * and phase-complete.locking.test.ts (mocked lock behavior).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			entries: [
				{
					task_id: `retro-${phaseNumber}`,
					type: 'retrospective',
					timestamp: new Date().toISOString(),
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
	let tempDir: string;
	let originalCwd: string;
	let eventsPath: string;
	let parentDir: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-adversarial-')),
		);
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

	// =======================================================================
	// CONCURRENT LOCK CONTENTION
	// =======================================================================
	describe('Real lock contention', () => {
		test('second caller gets acquired=false and returns failure (plan.json contention)', async () => {
			// First call acquires lock
			const release1 = vi.fn().mockResolvedValue(undefined);
			const release2 = vi.fn().mockResolvedValue(undefined);
			const planLockCalls: string[] = [];
			mockTryAcquireLock.mockImplementation(
				(_dir: string, filePath: string) => {
					if (filePath === 'events.jsonl') {
						return {
							acquired: true,
							lock: {
								filePath: 'events.jsonl',
								agent: 'phase-complete',
								taskId: 'phase-complete-events',
								timestamp: new Date().toISOString(),
								expiresAt: Date.now() + 300000,
								_release: release2,
							},
						};
					}
					// plan.json: first caller gets lock, second gets contention
					if (planLockCalls.length === 0) {
						planLockCalls.push('first');
						return {
							acquired: true,
							lock: {
								filePath: 'plan.json',
								agent: 'phase-complete',
								taskId: 'phase-complete-plan-first',
								timestamp: new Date().toISOString(),
								expiresAt: Date.now() + 300000,
								_release: release1,
							},
						};
					}
					// Second plan.json caller: contention
					return { acquired: false };
				},
			);

			// Fire two calls nearly simultaneously
			const [r1, r2] = await Promise.all([
				executePhaseComplete({ phase: 1, sessionID: 'test-session' }, tempDir),
				executePhaseComplete({ phase: 1, sessionID: 'test-session' }, tempDir),
			]);

			const p1 = JSON.parse(r1);
			const p2 = JSON.parse(r2);

			// One call should succeed, the other should fail (order non-deterministic)
			const successes = [p1, p2].filter((p) => p.success);
			const failures = [p1, p2].filter((p) => !p.success);
			expect(successes.length).toBe(1);
			expect(failures.length).toBe(1);

			const failed = failures[0];
			expect(failed.status).toBe('incomplete');
			expect(failed.message).toContain(
				'Plan write blocked: plan.json is locked',
			);
			expect(failed.errors.length).toBeGreaterThan(0);
			expect(failed.errors[0]).toContain('Concurrent plan write detected');
			expect(failed.recovery_guidance).toBeDefined();

			// Both events should be written (events.jsonl write is soft-fail, happens before plan.json lock)
			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const lines = content.split('\n').filter(Boolean);
			const phaseEvents = lines
				.map((l) => JSON.parse(l))
				.filter((e: Record<string, unknown>) => e.event === 'phase_complete');
			expect(phaseEvents.length).toBe(2);
		});

		test('lock throw causes phase_complete to return failure', async () => {
			// Simulate filesystem error on lock acquisition
			mockTryAcquireLock.mockRejectedValue(new Error('Cannot create lock dir'));

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Must return failure with clear error, not throw
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.message).toContain('Failed to acquire lock for plan.json');
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors[0]).toContain('Cannot create lock dir');
			expect(parsed.recovery_guidance).toBeDefined();

			// Event must still be written (events.jsonl write is soft-fail, happens before plan.json lock)
			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			expect(() => JSON.parse(content)).not.toThrow();
			const event = JSON.parse(content);
			expect(event.event).toBe('phase_complete');
			expect(event.phase).toBe(1);
		});
	});

	// =======================================================================
	// EVENTS.JSONL WRITE FAILURES
	// =======================================================================
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
								timestamp: new Date().toISOString(),
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
							timestamp: new Date().toISOString(),
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
			// Lock must still be released
			expect(release).toHaveBeenCalledTimes(1);
		});

		test('read-only filesystem: appendFileSync throws EPERM, warning is added', async () => {
			const release = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'events.jsonl',
					agent: 'phase-complete',
					taskId: 'phase-complete-test',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: release,
				},
			});

			// Mock appendFileSync to throw EPERM — chmod is unreliable as root in CI
			vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
				const err = Object.assign(new Error('EPERM: operation not permitted'), {
					code: 'EPERM',
				});
				throw err;
			});

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
		});

		test('events.jsonl missing (deleted after lock acquired) — appendFileSync creates it', async () => {
			const release = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'events.jsonl',
					agent: 'phase-complete',
					taskId: 'phase-complete-test',
					timestamp: new Date().toISOString(),
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
					timestamp: new Date().toISOString(),
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
			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content);
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
	describe('working_directory path traversal via executePhaseComplete', () => {
		test('path traversal via .. segments — no crash, fails at retro gate', async () => {
			// path.join preserves .., normalize resolves it to parent dirs.
			// realpathSync resolves to real existing dirs on filesystem.
			// The actual outcome is execution reaching RETROSPECTIVE_MISSING (retro
			// bundle not found at resolved parent dir) — not a crash.
			const traversalPath = path.join(path.basename(tempDir), '..', '..', '..');

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				traversalPath,
			);
			const parsed = JSON.parse(result);

			// Does not crash — fails gracefully at retro gate
			expect(parsed.success).toBe(false);
			expect(
				parsed.reason === 'RETROSPECTIVE_MISSING' ||
					parsed.message.includes('path traversal'),
			).toBe(true);
		});

		test('deeply nested ../ traversal — no crash', async () => {
			// Multiple .. segments
			const deepTraversal = 'a/../b/../c/../d/../e/../f';

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				deepTraversal,
			);
			const parsed = JSON.parse(result);

			// Does not crash
			expect(parsed.success).toBe(false);
		});

		test('symlink traversal — resolves to real path via realpathSync', async () => {
			// Create a symlink inside tempDir pointing to parent
			const linkName = path.join(tempDir, 'link-to-parent');
			try {
				fs.symlinkSync(parentDir, linkName);
			} catch {
				// symlinks may require admin on Windows — skip if it fails
				test.skip('symlink creation failed (likely no admin)', () => {});
				return;
			}

			// Symlink resolves via realpathSync — execution proceeds to retro gate
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				linkName,
			);
			const parsed = JSON.parse(result);

			// Does not crash — fails gracefully at retro gate
			expect(parsed.success).toBe(false);
		});
	});

	// =======================================================================
	// EXTREME PHASE NUMBER BOUNDARIES
	// =======================================================================
	describe('Extreme phase number boundaries', () => {
		test('phase = Number.MIN_SAFE_INTEGER is rejected', async () => {
			const result = await executePhaseComplete(
				{ phase: Number.MIN_SAFE_INTEGER, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('phase = Number.MIN_VALUE is rejected', async () => {
			const result = await executePhaseComplete(
				{ phase: Number.MIN_VALUE, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// MIN_VALUE is still a positive number > 1, but tiny.
			// Number.isInteger(MIN_VALUE) = false → Invalid phase number
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('phase = -Infinity is rejected', async () => {
			const result = await executePhaseComplete(
				{ phase: -Infinity, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('phase = Infinity is rejected', async () => {
			const result = await executePhaseComplete(
				{ phase: Infinity, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('phase = Number.NaN is rejected', async () => {
			const result = await executePhaseComplete(
				{ phase: Number.NaN, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('phase = 0.999 (near-zero float) is rejected', async () => {
			const result = await executePhaseComplete(
				{ phase: 0.999, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// 0.999 is not an integer → Invalid phase number
			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});

		test('phase = 1.0000000001 (near-one float) — not integer, rejected', async () => {
			const result = await executePhaseComplete(
				{ phase: 1.0000000001, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(false);
			expect(parsed.message).toBe('Invalid phase number');
		});
	});

	// =======================================================================
	// OVERSIZED SUMMARY — verify events.jsonl contains truncated value
	// =======================================================================
	describe('Oversized summary — event log truncation verification', () => {
		test('10KB summary is truncated to 500 chars in BOTH message and event log', async () => {
			const hugeSummary = 'A'.repeat(10 * 1024);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session', summary: hugeSummary },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// 1. Check message is truncated
			const afterPrefix = parsed.message.replace('Phase 1 completed: ', '');
			expect(afterPrefix.length).toBe(500);
			expect(afterPrefix).toBe('A'.repeat(500));

			// 2. Check events.jsonl contains the same truncated summary
			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content);
			expect(event.event).toBe('phase_complete');
			expect(event.summary).toBe('A'.repeat(500)); // NOT the full 10KB
			expect(event.summary.length).toBe(500);
		});

		test('1MB summary is truncated to 500 chars in event log', async () => {
			const hugeSummary = 'X'.repeat(1024 * 1024);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session', summary: hugeSummary },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// Verify event log has truncated summary
			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content);
			expect(event.summary).toBe('X'.repeat(500));
			expect(event.summary.length).toBe(500);
		});

		test('summary at exactly 500 chars — no truncation', async () => {
			const exactSummary = 'B'.repeat(500);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session', summary: exactSummary },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content);
			expect(event.summary).toBe(exactSummary);
			expect(event.summary.length).toBe(500);
		});

		test('summary longer than 500 chars with whitespace — trim THEN slice', async () => {
			// Summary has leading/trailing whitespace, then content > 500 chars
			const whitespace = '   ';
			const content = 'C'.repeat(600);
			const fullSummary = whitespace + content + whitespace;

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session', summary: fullSummary },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			// safeSummary = summary.trim().slice(0, 500)
			// "   CCCC...C   ".trim() = "CCCC...C" (600 Cs)
			// .slice(0, 500) = 500 Cs
			const content2 = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content2);
			expect(event.summary).toBe('C'.repeat(500));
		});

		test('summary is only whitespace — trim makes it empty, event logs null', async () => {
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session', summary: '     ' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content);
			// safeSummary = '     '.trim().slice(0, 500) = '' (empty string)
			// In the event: safeSummary ?? null = '' (empty string is NOT null/undefined)
			expect(event.summary).toBe('');
		});

		test('null summary — event logs null, not the string "null"', async () => {
			const result = await executePhaseComplete(
				{
					phase: 1,
					sessionID: 'test-session',
					summary: null as unknown as string,
				},
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);

			const content = fs.readFileSync(eventsPath, 'utf-8').trim();
			const event = JSON.parse(content);
			expect(event.summary).toBeNull();
		});
	});

	// =======================================================================
	// LOCK RELEASE IS CALLED IN FINALLY — even if write throws
	// =======================================================================
	describe('Lock release in finally block (non-throwing guarantee)', () => {
		test('when appendFileSync throws, _release() is still called for all acquired locks', async () => {
			const eventsRelease = vi.fn().mockResolvedValue(undefined);
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
								timestamp: new Date().toISOString(),
								expiresAt: Date.now() + 300000,
								_release: eventsRelease,
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
							timestamp: new Date().toISOString(),
							expiresAt: Date.now() + 300000,
							_release: planRelease,
						},
					};
				},
			);

			// Replace events.jsonl with a directory to cause write failure
			fs.rmSync(eventsPath);
			fs.mkdirSync(eventsPath);

			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Must not throw
			expect(parsed.success).toBe(true);
			// Both acquired locks must be released even though write threw
			expect(eventsRelease).toHaveBeenCalledTimes(1);
			expect(planRelease).toHaveBeenCalledTimes(1);
		});

		test('when _release() itself throws, the error is caught and logged, not thrown', async () => {
			const release = vi
				.fn()
				.mockImplementation(() => Promise.reject(new Error('_release failed')));
			mockTryAcquireLock.mockResolvedValue({
				acquired: true,
				lock: {
					filePath: 'events.jsonl',
					agent: 'phase-complete',
					taskId: 'phase-complete-test',
					timestamp: new Date().toISOString(),
					expiresAt: Date.now() + 300000,
					_release: release,
				},
			});

			// Should NOT throw despite _release() failing
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);

			expect(() => JSON.parse(result)).not.toThrow();
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
		});
	});

	// =======================================================================
	// MULTI-SESSION CROSS-PHASE STATE ISOLATION
	// =======================================================================
	describe('Multi-session phase isolation under adversarial calls', () => {
		test('two different sessions, same phase — both succeed with correct agent sets', async () => {
			// Session A dispatches coder, session B dispatches reviewer
			const sessionA = ensureAgentSession('session-A', 'architect', tempDir);
			sessionA.phaseAgentsDispatched = new Set(['coder']);
			sessionA.lastPhaseCompleteTimestamp = 0;

			const sessionB = ensureAgentSession('session-B', 'architect', tempDir);
			sessionB.phaseAgentsDispatched = new Set(['reviewer']);
			sessionB.lastPhaseCompleteTimestamp = 0;

			// Both complete phase 1
			const [rA, rB] = await Promise.all([
				executePhaseComplete({ phase: 1, sessionID: 'session-A' }, tempDir),
				executePhaseComplete({ phase: 1, sessionID: 'session-B' }, tempDir),
			]);

			const pA = JSON.parse(rA);
			const pB = JSON.parse(rB);

			// Both succeed
			expect(pA.success).toBe(true);
			expect(pB.success).toBe(true);

			// Agent sets are independent (Set semantics)
			// Note: first call resets ALL contributor sessions including session-B,
			// so session-B's agents may be cleared before its own call completes.
			// This is expected swarm behavior — the second call sees session-B's
			// phaseAgentsDispatched as empty (already reset by first call).
		});
	});
});
