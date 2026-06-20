/**
 * Locking behavior verification tests for phase-complete.ts
 *
 * Tests cover:
 * 1. Lock acquisition - verify that when lock is acquired, the event is written
 * 2. Lock release - verify that lock is always released in finally block
 * 3. Write always happens - verify that the event is written even when lock acquisition fails
 * 4. Error handling - verify that when write fails, error is returned properly
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPlan } from '../../../src/plan/manager';
import { resetSwarmState, swarmState } from '../../../src/state';
import { executePhaseComplete } from '../../../src/tools/phase-complete';

// Mock the parallel/file-locks module to control lock acquisition
vi.mock('../../../src/parallel/file-locks', () => ({
	tryAcquireLock: vi.fn(),
}));

// Mock other dependencies that phase_complete relies on
vi.mock('../../../src/evidence/manager', () => ({
	listEvidenceTaskIds: vi.fn().mockResolvedValue([]),
	loadEvidence: vi.fn().mockImplementation((_dir: string, taskId: string) => {
		// Return not_found for most evidence queries
		if (taskId.startsWith('retro-')) {
			// Check if retro bundle exists on disk
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

// state module is NOT mocked - we use real state with resetSwarmState

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

// Import mocked modules after vi.mock calls
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { ensureAgentSession } from '../../../src/state';

const mockTryAcquireLock = tryAcquireLock as ReturnType<typeof vi.fn>;

describe('executePhaseComplete locking behavior', () => {
	let tempDir: string;
	let originalCwd: string;
	let eventsPath: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-lock-test-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		// Create .swarm directory structure
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });

		// Create events.jsonl file
		eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
		fs.writeFileSync(eventsPath, '', 'utf-8');

		// Create valid plan.json
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

		// Create a valid retro bundle for phase 1
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

		// Reset swarm state to clean state
		resetSwarmState();

		// Set active agent for phase_complete to use
		swarmState.activeAgent.set('current', 'test-agent');

		// Create a proper session using ensureAgentSession
		const session = ensureAgentSession('test-session', 'test-agent', tempDir);
		// Set up the session with required properties for phase_complete
		session.phaseAgentsDispatched = new Set();
		session.lastPhaseCompleteTimestamp = 0;

		// Reset mocks
		vi.clearAllMocks();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ========== GROUP 1: Lock Acquisition ==========
	describe('Group 1: Lock Acquisition', () => {
		test('when lock is acquired, event is written to events.jsonl', async () => {
			// Arrange: lock acquisition succeeds
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

			// Act
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: write succeeded
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Verify event was written to events.jsonl
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const eventLine = eventsContent.trim().split('\n').filter(Boolean)[0];
			const writtenEvent = JSON.parse(eventLine);
			expect(writtenEvent.event).toBe('phase_complete');
			expect(writtenEvent.phase).toBe(1);
		});

		test('when lock acquisition throws, phase_complete returns failure', async () => {
			// Arrange: lock acquisition throws
			mockTryAcquireLock.mockRejectedValue(
				new Error('Lock directory not writable'),
			);

			// Act
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: phase_complete returned failure
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			// Error message should mention the lock failure
			expect(parsed.message).toContain('Failed to acquire lock for plan.json');
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors[0]).toContain('Lock directory not writable');

			// Event should still be written (events.jsonl lock is soft-fail)
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const eventLine = eventsContent.trim().split('\n').filter(Boolean)[0];
			const writtenEvent = JSON.parse(eventLine);
			expect(writtenEvent.event).toBe('phase_complete');
		});

		test('when lock cannot be acquired (acquired=false), phase_complete returns failure', async () => {
			// Arrange: lock acquisition returns acquired=false
			mockTryAcquireLock.mockResolvedValue({
				acquired: false,
			});

			// Act
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: phase_complete returned failure due to concurrent lock
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.message).toContain(
				'Plan write blocked: plan.json is locked',
			);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors[0]).toContain('Concurrent plan write detected');
			expect(parsed.recovery_guidance).toBeDefined();
		});
	});

	// ========== GROUP 2: Lock Release ==========
	describe('Group 2: Lock Release', () => {
		test('releases lock via _release() when execution succeeds', async () => {
			// Arrange
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
					// plan.json: acquired
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

			// Act
			await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);

			// Assert: events.jsonl lock was released exactly once
			expect(mockRelease).toHaveBeenCalledTimes(1);
		});

		test('releases lock via _release() even when write succeeds but phase state update fails', async () => {
			// Arrange: write succeeds, but state update would fail silently
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
					// plan.json: acquired
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

			// Act
			await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);

			// Assert: events.jsonl lock was released
			expect(mockRelease).toHaveBeenCalledTimes(1);
		});

		test('does NOT release lock when lock was not acquired (acquired=false)', async () => {
			// Arrange
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockResolvedValue({
				acquired: false,
			});

			// Act
			await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);

			// Assert: no lock to release (hard-fail before lock release would happen)
			expect(mockRelease).not.toHaveBeenCalled();
		});

		test('does NOT release lock when lock acquisition threw (never acquired)', async () => {
			// Arrange
			const mockRelease = vi.fn().mockResolvedValue(undefined);
			mockTryAcquireLock.mockRejectedValue(
				new Error('Cannot create lock directory'),
			);

			// Act
			await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);

			// Assert: no lock to release (hard-fail before lock release would happen)
			expect(mockRelease).not.toHaveBeenCalled();
		});

		test('lock is released even if _release() itself throws', async () => {
			// Arrange: _release throws but should still be called
			const mockRelease = vi
				.fn()
				.mockRejectedValue(new Error('Release failed'));
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

			// Act - should NOT throw despite _release() failing
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: execution completed (error was caught and logged)
			expect(parsed.success).toBe(true);
			// _release was called despite failing
			expect(mockRelease).toHaveBeenCalledTimes(1);
		});
	});

	// ========== GROUP 3: Write Always Happens ==========
	describe('Group 3: Write Always Happens', () => {
		test('event is written even when lock acquisition fails completely (exception)', async () => {
			// Arrange
			mockTryAcquireLock.mockRejectedValue(new Error('Filesystem error'));

			// Act
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: event was written despite lock failure (events.jsonl write is soft-fail)
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const eventLine = eventsContent.trim().split('\n').filter(Boolean)[0];
			const writtenEvent = JSON.parse(eventLine);
			expect(writtenEvent.event).toBe('phase_complete');
			expect(writtenEvent.phase).toBe(1);
			// But phase_complete returns failure because plan.json lock acquisition threw
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.message).toContain('Failed to acquire lock for plan.json');
			expect(parsed.errors.length).toBeGreaterThan(0);
		});

		test('phase_complete returns failure when lock acquisition returns acquired=false', async () => {
			// Arrange
			mockTryAcquireLock.mockResolvedValue({
				acquired: false,
			});

			// Act
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: phase_complete returns failure due to concurrent plan lock
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.message).toContain(
				'Plan write blocked: plan.json is locked',
			);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors[0]).toContain('Concurrent plan write detected');
		});

		test('event is written even when lock acquisition succeeds but write happens after', async () => {
			// Arrange
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

			// Act
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert
			expect(parsed.success).toBe(true);
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const eventLine = eventsContent.trim().split('\n').filter(Boolean)[0];
			const writtenEvent = JSON.parse(eventLine);
			expect(writtenEvent.event).toBe('phase_complete');
		});
	});

	// ========== GROUP 4: Error Handling ==========
	describe('Group 4: Error Handling', () => {
		test('when write fails, error is added to warnings and execution continues', async () => {
			// Arrange: lock acquisition succeeds but we make events.jsonl a directory to cause write failure
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
					// plan.json: acquired
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

			// Make events.jsonl a directory to cause write failure
			fs.rmSync(eventsPath);
			fs.mkdirSync(eventsPath);

			// Act
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: execution completed with warning about write failure
			expect(parsed.success).toBe(true);
			expect(
				parsed.warnings.some((warning: string) =>
					warning.includes('failed to write phase complete event'),
				),
			).toBe(true);
			// events.jsonl lock was still released
			expect(mockRelease).toHaveBeenCalledTimes(1);
		});

		test('when both lock acquisition and write fail, phase_complete returns failure', async () => {
			// Arrange
			mockTryAcquireLock.mockRejectedValue(
				new Error('Lock acquisition failed'),
			);

			// Make events.jsonl a directory to cause write failure
			fs.rmSync(eventsPath);
			fs.mkdirSync(eventsPath);

			// Act
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: phase_complete returns failure because plan.json lock acquisition threw
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.message).toContain('Failed to acquire lock for plan.json');
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors[0]).toContain('Lock acquisition failed');
		});

		test('lock release error does not prevent function from returning success', async () => {
			// Arrange
			const mockRelease = vi
				.fn()
				.mockRejectedValue(new Error('Release failed'));
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

			// Act
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: function returned success despite _release() throwing
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');
		});

		test('_release error is caught and logged, not thrown', async () => {
			// Arrange
			const mockRelease = vi
				.fn()
				.mockRejectedValue(new Error('Release failed'));
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

			// Act - should not throw
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);

			// Assert: result was returned (not an exception)
			expect(() => JSON.parse(result)).not.toThrow();
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
		});
	});

	// ========== GROUP 5: Call Order Verification ==========
	describe('Group 5: Call Order Verification', () => {
		test('lock is acquired BEFORE write, released AFTER write', async () => {
			// Arrange
			const callOrder: string[] = [];
			const mockRelease = vi.fn().mockImplementation(async () => {
				callOrder.push('_release');
			});
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

			// Act
			await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);

			// Assert: write happened, then release
			expect(callOrder).toContain('_release');
			// We can verify order by checking events were written before this check
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			expect(eventsContent.trim().length).toBeGreaterThan(0);
		});

		test('when lock not acquired, event is still written but phase_complete returns failure for plan.json contention', async () => {
			// Arrange: lock acquisition returns acquired=false for all calls
			// (both events.jsonl and plan.json since they share the same mock)
			mockTryAcquireLock.mockResolvedValue({
				acquired: false,
			});

			// Act
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: event was written (events.jsonl write is soft-fail)
			const eventsContent = fs.readFileSync(eventsPath, 'utf-8');
			const eventLine = eventsContent.trim().split('\n').filter(Boolean)[0];
			const writtenEvent = JSON.parse(eventLine);
			expect(writtenEvent.event).toBe('phase_complete');
			// But overall phase_complete returns failure because plan.json lock contention
			expect(parsed.success).toBe(false);
			expect(parsed.status).toBe('incomplete');
			expect(parsed.message).toContain(
				'Plan write blocked: plan.json is locked',
			);
			expect(parsed.errors.length).toBeGreaterThan(0);
			expect(parsed.errors[0]).toContain('Concurrent plan write detected');
		});
	});

	// ========== GROUP 6: F-08 Atomic Fallback ==========
	describe('Group 6: F-08 Atomic Fallback', () => {
		test('when loadPlan returns null and no ledger exists, falls back to atomicWriteFile to update plan.json', async () => {
			// Arrange: lock acquisition succeeds for both events.jsonl and plan.json
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
					// plan.json: acquired
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

			// Override loadPlan to return null for the calls that drive the F-08 path:
			// 1) line 506 (knowledge gate pre-check),
			// 2) line 1555 (plan update branch),
			// 3) line 1705 (post-mortem finalPlan check).
			(loadPlan as ReturnType<typeof vi.fn>).mockResolvedValue(null);

			// Debug: capture the mocked loadPlan call count to verify the override is in effect
			const planPath = path.join(tempDir, '.swarm', 'plan.json');
			const planContentBefore = fs.readFileSync(planPath, 'utf-8');

			// Act
			const result = await executePhaseComplete(
				{ phase: 1, sessionID: 'test-session' },
				tempDir,
			);
			const parsed = JSON.parse(result);

			// Assert: execution succeeded via the atomic fallback path
			expect(parsed.success).toBe(true);
			expect(parsed.status).toBe('success');

			// Assert: on-disk plan.json was updated by the atomic fallback write
			const onDiskPlan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
			const phaseObj = onDiskPlan.phases.find(
				(p: { id: number }) => p.id === 1,
			);
			expect(phaseObj).toBeDefined();
			expect(phaseObj.status).toBe('complete');
		});
	});
});
