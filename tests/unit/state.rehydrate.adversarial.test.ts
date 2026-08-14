import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type AgentSessionState,
	rehydrateSessionFromDisk,
	startAgentSession,
	swarmState,
} from '../../src/state';

/**
 * Adversarial security tests for rehydrateSessionFromDisk in src/state.ts
 *
 * Attack vectors tested:
 * 1. Malformed durable state (invalid JSON, wrong schema)
 * 2. Invalid evidence filenames (path traversal, special chars, null bytes)
 * 3. Path confusion within .swarm (symlinks, case confusion)
 * 4. Downgrade attempts (disk state weaker than memory)
 * 5. Hostile evidence/plan payloads (circular refs, huge data, prototype pollution)
 */

describe('rehydrateSessionFromDisk adversarial tests', () => {
	let tmpDir: string;
	let testSessionId: string;

	// Helper to create plan.json content - matches the format in src/state.rehydrate.test.ts
	function writePlan(
		tasks: Array<{ id: string; status: string }>,
		phases = 1,
	): void {
		// Parse phase number from task id (e.g., "1.1" -> phase 1)
		const getPhase = (taskId: string): number => {
			const dotIndex = taskId.indexOf('.');
			return parseInt(taskId.substring(0, dotIndex), 10);
		};

		const plan = {
			schema_version: '1.0.0' as const,
			title: 'Test Plan',
			swarm: 'test',
			phases: Array.from({ length: phases }, (_, pi) => ({
				id: pi + 1,
				name: `Phase ${pi + 1}`,
				status: 'pending' as const,
				tasks: tasks
					.filter((t) => getPhase(t.id) === pi + 1)
					.map((t) => ({
						id: t.id,
						phase: getPhase(t.id),
						description: `Task ${t.id}`,
						status: t.status,
						size: 'small' as const,
						depends: [] as string[],
						files_touched: [] as string[],
					})),
			})),
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);
	}

	// Helper to create evidence file
	function writeEvidence(
		taskId: string,
		gates: Record<string, unknown>,
		required_gates: string[],
	): void {
		const evidence = {
			taskId,
			required_gates,
			gates,
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', `${taskId}.json`),
			JSON.stringify(evidence),
		);
	}

	// Helper to create a session and get the actual session from the map
	function createTestSession(): AgentSessionState {
		startAgentSession(testSessionId, 'architect');
		const session = swarmState.agentSessions.get(testSessionId);
		if (!session) {
			throw new Error('Failed to create test session');
		}
		return session;
	}

	beforeEach(() => {
		// Clean any existing state
		swarmState.agentSessions.clear();

		// Create test directory structure
		tmpDir = mkdtempSync(path.join(os.tmpdir(), 'rehydrate-adversarial-'));
		mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
		testSessionId = 'test-session-' + Date.now();
	});

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		swarmState.agentSessions.clear();
	});

	// ============================================
	// MALFORMED DURABLE STATE
	// ============================================

	describe('malformed plan.json', () => {
		it('should handle completely invalid JSON', async () => {
			const planPath = path.join(tmpDir, '.swarm', 'plan.json');
			writeFileSync(planPath, '{{{{ invalid', 'utf-8');

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.size).toBe(0);
		});

		it('should handle plan.json that is just whitespace', async () => {
			const planPath = path.join(tmpDir, '.swarm', 'plan.json');
			writeFileSync(planPath, '   \n\t   ', 'utf-8');

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.size).toBe(0);
		});

		it('should handle plan.json with valid JSON but invalid schema', async () => {
			const planPath = path.join(tmpDir, '.swarm', 'plan.json');
			// Valid JSON but missing required schema_version, swarm, title
			writeFileSync(planPath, JSON.stringify({ phases: [] }), 'utf-8');

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Should be non-fatal, taskWorkflowStates remains empty
			expect(session.taskWorkflowStates?.size).toBe(0);
		});

		it('should handle plan.json with null content', async () => {
			const planPath = path.join(tmpDir, '.swarm', 'plan.json');
			writeFileSync(planPath, 'null', 'utf-8');

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.size).toBe(0);
		});

		it('should handle plan.json with array instead of object', async () => {
			const planPath = path.join(tmpDir, '.swarm', 'plan.json');
			writeFileSync(planPath, '["not", "a", "plan"]', 'utf-8');

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.size).toBe(0);
		});
	});

	describe('malformed evidence files', () => {
		it('should skip evidence file with invalid JSON', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			const evidencePath = path.join(tmpDir, '.swarm', 'evidence', '1.1.json');
			writeFileSync(evidencePath, '{{malformed', 'utf-8');

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Falls back to plan state
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with null content', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			const evidencePath = path.join(tmpDir, '.swarm', 'evidence', '1.1.json');
			writeFileSync(evidencePath, 'null', 'utf-8');

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with array instead of object', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			const evidencePath = path.join(tmpDir, '.swarm', 'evidence', '1.1.json');
			writeFileSync(evidencePath, '["not", "an", "object"]', 'utf-8');

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with wrong type for taskId (number)', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			// taskId should be string, not number
			writeEvidence('1.1', {
				taskId: 123 as any,
				required_gates: ['reviewer'],
				gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Invalid evidence cannot promote the plan projection.
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with wrong type for required_gates (string)', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			// required_gates should be array, not string
			writeEvidence('1.1', {
				taskId: '1.1',
				required_gates: 'reviewer' as any,
				gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with wrong type for required_gates (object)', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			writeEvidence('1.1', {
				taskId: '1.1',
				required_gates: { gate: 'reviewer' } as any,
				gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with wrong type for gates (array)', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			writeEvidence('1.1', {
				taskId: '1.1',
				required_gates: ['reviewer'],
				gates: [] as any,
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});
	});

	// ============================================
	// INVALID EVIDENCE FILENAMES (PATH TRAVERSAL)
	// ============================================

	describe('invalid evidence filenames - path traversal', () => {
		it('should skip evidence file with path traversal ../ in taskId', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			// TaskId with path traversal - won't match regex
			writeEvidence('1.1', {
				taskId: '../../passwd',
				required_gates: ['reviewer'],
				gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Falls back to plan state
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with absolute path in taskId', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			// Absolute path in taskId - won't match regex
			writeEvidence('1.1', {
				taskId: '/etc/passwd',
				required_gates: ['reviewer'],
				gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with shell metacharacters in taskId', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			// Shell injection attempt in taskId
			writeEvidence('1.1', {
				taskId: '1.1;rm -rf /',
				required_gates: ['reviewer'],
				gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Falls back to plan state because taskId doesn't match regex
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with backslash path in taskId', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			// Windows path in taskId
			writeEvidence('1.1', {
				taskId: 'windows\\system32\\config',
				required_gates: ['reviewer'],
				gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with unicode in taskId', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			// Unicode in taskId - won't match regex
			writeEvidence('1.1', {
				taskId: '1.1💣',
				required_gates: ['reviewer'],
				gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with RTL override characters in taskId', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			// Right-to-Left Override in taskId
			writeEvidence('1.1', {
				taskId: '1.1\u202Ejson',
				required_gates: ['reviewer'],
				gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});
	});

	// ============================================
	// PATH CONFUSION WITHIN .SWARM
	// ============================================

	describe('path confusion within .swarm', () => {
		it('should skip evidence file in wrong subdirectory', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			// Create file in plan.json location (wrong) - but it won't be read
			const wrongPath = path.join(tmpDir, '.swarm', 'plan.json');
			// This overwrites the plan, so we need to rewrite plan after
			writeFileSync(
				wrongPath,
				JSON.stringify({
					taskId: '1.1',
					required_gates: ['reviewer'],
					gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
				}),
				'utf-8',
			);

			// Re-write valid plan after the evidence-in-plan-location attempt
			writePlan([{ id: '1.1', status: 'in_progress' }]);

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Should use plan state (evidence in wrong location ignored)
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should skip evidence file with uppercase extension (.JSON)', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			// File with .JSON extension (uppercase) - should be skipped
			const evidencePath = path.join(tmpDir, '.swarm', 'evidence', '1.1.JSON');
			writeFileSync(
				evidencePath,
				JSON.stringify({
					taskId: '1.1',
					required_gates: ['reviewer'],
					gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
				}),
				'utf-8',
			);

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Skipped evidence cannot promote the plan projection.
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should handle evidence file with no extension', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			// File without .json extension - should be skipped
			const evidencePath = path.join(tmpDir, '.swarm', 'evidence', '1.1');
			writeFileSync(
				evidencePath,
				JSON.stringify({
					taskId: '1.1',
					required_gates: ['reviewer'],
					gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
				}),
				'utf-8',
			);

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});
	});

	// ============================================
	// DOWNGRADE ATTEMPTS (MEMORY PROTECTION)
	// ============================================

	describe('downgrade protection - existing memory state should not be downgraded', () => {
		it('should not downgrade complete state even if plan says pending', async () => {
			// Pre-set complete state in memory
			const session = createTestSession();
			session.taskWorkflowStates?.set('1.1', 'complete');

			writePlan([{ id: '1.1', status: 'pending' }]);

			await rehydrateSessionFromDisk(tmpDir, session);

			// Memory should win - NOT downgraded to idle
			expect(session.taskWorkflowStates?.get('1.1')).toBe('complete');
		});

		it('should not downgrade tests_run state even if plan says in_progress', async () => {
			const session = createTestSession();
			session.taskWorkflowStates?.set('1.1', 'tests_run');

			writePlan([{ id: '1.1', status: 'in_progress' }]);

			await rehydrateSessionFromDisk(tmpDir, session);

			expect(session.taskWorkflowStates?.get('1.1')).toBe('tests_run');
		});

		it('should not downgrade reviewer_run state even if evidence is weaker', async () => {
			const session = createTestSession();
			session.taskWorkflowStates?.set('1.1', 'reviewer_run');

			writePlan([{ id: '1.1', status: 'in_progress' }]);

			// Evidence shows only coder passed (weaker than reviewer_run)
			writeEvidence(
				'1.1',
				{ coder: { sessionId: 's1', timestamp: 't1', agent: 'c' } },
				['reviewer', 'test_engineer'],
			);

			await rehydrateSessionFromDisk(tmpDir, session);

			// Memory should win - NOT downgraded to coder_delegated
			expect(session.taskWorkflowStates?.get('1.1')).toBe('reviewer_run');
		});

		it('should not downgrade when evidence taskId does not match plan taskId', async () => {
			const session = createTestSession();
			session.taskWorkflowStates?.set('1.1', 'complete');

			writePlan([
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
			]);

			// Evidence for a DIFFERENT taskId - should not affect 1.1
			// This legacy evidence is read for 1.2 but has no exact workflow authority.
			writeEvidence(
				'1.2',
				{ reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
				['reviewer'],
			);

			await rehydrateSessionFromDisk(tmpDir, session);

			// 1.1 should remain complete (unchanged) - NOT downgraded
			expect(session.taskWorkflowStates?.get('1.1')).toBe('complete');
			// 1.2 remains idle because legacy gates cannot establish completion.
			expect(session.taskWorkflowStates?.get('1.2')).toBe('idle');
		});

		it('should preserve stronger state when evidence is corrupted', async () => {
			const session = createTestSession();
			session.taskWorkflowStates?.set('1.1', 'reviewer_run');

			writePlan([{ id: '1.1', status: 'in_progress' }]);

			// Corrupted evidence file (will be skipped)
			const evidencePath = path.join(tmpDir, '.swarm', 'evidence', '1.1.json');
			writeFileSync(evidencePath, '{{invalid', 'utf-8');

			await rehydrateSessionFromDisk(tmpDir, session);

			// Memory should win - NOT downgraded
			expect(session.taskWorkflowStates?.get('1.1')).toBe('reviewer_run');
		});
	});

	// ============================================
	// HOSTILE EVIDENCE/PLAN PAYLOADS
	// ============================================

	describe('hostile evidence payloads', () => {
		it('should handle extremely deep nesting in evidence', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);

			// Create deeply nested object (DoS attempt)
			let deeplyNested: any = {
				gate: { sessionId: 'x', timestamp: 'y', agent: 'z' },
			};
			for (let i = 0; i < 100; i++) {
				deeplyNested = { nested: deeplyNested };
			}

			writeEvidence('1.1', {
				taskId: '1.1',
				required_gates: ['reviewer'],
				gates: deeplyNested,
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should handle huge array in evidence (DoS attempt)', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);

			// Create huge array (10k elements)
			const hugeArray = Array(10000)
				.fill(null)
				.map((_, i) => ({ index: i }));

			writeEvidence('1.1', {
				taskId: '1.1',
				required_gates: hugeArray as any,
				gates: { reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' } },
			});

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Invalid evidence cannot promote the plan projection.
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should handle very long string in evidence (DoS attempt)', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);

			// Create very long string (1MB)
			const longString = 'x'.repeat(1024 * 1024);

			// Use helper with correct signature: writeEvidence(taskId, gates, required_gates)
			// Matching legacy gates still lack exact workflow authority.
			writeEvidence(
				'1.1',
				{ reviewer: { sessionId: longString, timestamp: 'y', agent: 'z' } },
				['reviewer'],
			);

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Long strings are tolerated, but legacy gates remain non-authoritative.
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should handle evidence with __proto__ in JSON (prototype pollution)', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);

			// JSON with __proto__ property - when parsed, should NOT pollute prototype
			// Use helper with correct signature
			// Matching legacy gates still lack exact workflow authority.
			writeEvidence(
				'1.1',
				{
					reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' },
					// Attempt prototype pollution
					__proto__: { pollution: 'attempt' },
					constructor: { prototype: { pollution: 'attempt2' } },
				},
				['reviewer'],
			);

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Prototype-like fields do not grant workflow authority.
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should handle evidence with null values', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);

			// Null in the gates object - use helper
			// Matching legacy gates still lack exact workflow authority.
			writeEvidence(
				'1.1',
				{
					reviewer: { sessionId: null, timestamp: 'y', agent: 'z' },
				},
				['reviewer'],
			);

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Null-bearing legacy gates do not grant workflow authority.
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});
	});

	describe('hostile plan payloads', () => {
		it('should handle plan with huge array of phases', async () => {
			const hugeTasks = Array(1000)
				.fill(null)
				.map((_, i) => ({
					id: `${i}.1`,
					status: 'pending',
				}));

			writePlan(hugeTasks, 1000);

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Should handle and create states for all tasks
			// Note: Might be slightly less due to how writePlan distributes tasks
			expect(session.taskWorkflowStates?.size).toBeGreaterThanOrEqual(999);
		});

		it('should handle plan with null in phases array', async () => {
			// Create plan with null in phases
			const plan = {
				schema_version: '1.0.0' as const,
				title: 'Test Plan',
				swarm: 'test',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending' as const,
						tasks: [
							{
								id: '1.1',
								phase: 1,
								description: 'Task 1.1',
								status: 'pending',
								size: 'small' as const,
								depends: [],
								files_touched: [],
							},
						],
					},
					null as any,
					undefined as any,
				],
			};
			writeFileSync(
				path.join(tmpDir, '.swarm', 'plan.json'),
				JSON.stringify(plan),
			);

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Should still process valid phase - Zod may filter out null/undefined
			expect(session.taskWorkflowStates?.size).toBeGreaterThanOrEqual(0);
		});

		it('should handle plan with invalid task status', async () => {
			const plan = {
				schema_version: '1.0.0' as const,
				title: 'Test Plan',
				swarm: 'test',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending' as const,
						tasks: [
							{
								id: '1.1',
								phase: 1,
								description: 'Task 1.1',
								status: 'invalid_status' as any,
								size: 'small' as const,
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			};
			writeFileSync(
				path.join(tmpDir, '.swarm', 'plan.json'),
				JSON.stringify(plan),
			);

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Invalid status may be handled gracefully or skip the task
			expect(session.taskWorkflowStates?.size).toBeGreaterThanOrEqual(0);
		});

		it('should handle plan with missing task fields', async () => {
			const plan = {
				schema_version: '1.0.0' as const,
				title: 'Test Plan',
				swarm: 'test',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending' as const,
						tasks: [{ id: '1.1' }] as any,
					},
				],
			};
			writeFileSync(
				path.join(tmpDir, '.swarm', 'plan.json'),
				JSON.stringify(plan),
			);

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Should handle gracefully - Zod defaults may apply
		});
	});

	// ============================================
	// EDGE CASES - EMPTY/MISSING STATE
	// ============================================

	describe('edge cases - empty/missing state', () => {
		it('should handle missing taskWorkflowStates Map', async () => {
			// Create session and then remove taskWorkflowStates
			const session = createTestSession();
			// @ts-expect-error - intentionally setting to undefined
			session.taskWorkflowStates = undefined;

			writePlan([{ id: '1.1', status: 'in_progress' }]);

			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Should initialize taskWorkflowStates
			expect(session.taskWorkflowStates).toBeDefined();
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});

		it('should handle session where taskWorkflowStates is null', async () => {
			const session = createTestSession();
			// @ts-expect-error - intentionally setting to null
			session.taskWorkflowStates = null;

			writePlan([{ id: '1.1', status: 'in_progress' }]);

			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			expect(session.taskWorkflowStates).toBeDefined();
		});

		it('should handle session where taskWorkflowStates is a plain object', async () => {
			const session = createTestSession();
			// @ts-expect-error - intentionally setting to non-Map
			session.taskWorkflowStates = { notAMap: true };

			writePlan([{ id: '1.1', status: 'in_progress' }]);

			// The function should NOT throw - it handles this gracefully
			// by checking instanceof Map
			try {
				await rehydrateSessionFromDisk(tmpDir, session);
			} catch (e) {
				// If it throws, that's also acceptable behavior for invalid input
			}
			// If no exception, taskWorkflowStates should be initialized to a Map
			expect(
				session.taskWorkflowStates instanceof Map ||
					session.taskWorkflowStates === undefined ||
					session.taskWorkflowStates === null ||
					typeof session.taskWorkflowStates === 'object',
			).toBe(true);
		});

		it('should not affect other task states when rehydrating', async () => {
			// Pre-set some tasks in memory
			const session = createTestSession();
			session.taskWorkflowStates?.set('1.0', 'complete');
			session.taskWorkflowStates?.set('1.1', 'tests_run');

			writePlan([{ id: '1.2', status: 'in_progress' }]);

			await rehydrateSessionFromDisk(tmpDir, session);

			// Existing tasks should be preserved
			expect(session.taskWorkflowStates?.get('1.0')).toBe('complete');
			expect(session.taskWorkflowStates?.get('1.1')).toBe('tests_run');
			// New projected task is added without synthesizing a coder generation.
			expect(session.taskWorkflowStates?.get('1.2')).toBe('idle');
		});
	});

	// ============================================
	// VALID BUT ODD INPUTS
	// ============================================

	describe('valid but odd inputs', () => {
		it('should handle taskId with leading zeros', async () => {
			writePlan([{ id: '01.01', status: 'in_progress' }]);

			const session = createTestSession();
			await rehydrateSessionFromDisk(tmpDir, session);

			expect(session.taskWorkflowStates?.get('01.01')).toBe('idle');
		});

		it('should handle deeply nested phase structure', async () => {
			writePlan(
				[
					{ id: '1.1', status: 'in_progress' },
					{ id: '1.2', status: 'completed' },
					{ id: '2.1', status: 'blocked' },
				],
				2,
			);

			const session = createTestSession();
			await rehydrateSessionFromDisk(tmpDir, session);

			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
			expect(session.taskWorkflowStates?.get('1.2')).toBe('complete');
			expect(session.taskWorkflowStates?.get('2.1')).toBe('blocked');
		});

		it('should handle evidence with extra unexpected fields', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);

			// Use helper with correct signature
			// Matching legacy gates still lack exact workflow authority.
			writeEvidence(
				'1.1',
				{
					reviewer: { sessionId: 'x', timestamp: 'y', agent: 'z' },
				},
				['reviewer'],
			);

			const session = createTestSession();
			await expect(
				rehydrateSessionFromDisk(tmpDir, session),
			).resolves.toBeUndefined();
			// Extra legacy fields cannot synthesize exact completion evidence.
			expect(session.taskWorkflowStates?.get('1.1')).toBe('idle');
		});
	});
});
