import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ORCHESTRATOR_NAME } from './config/constants';
import { ensureAgentSession, startAgentSession, swarmState } from './state';

// ============================================================================
// ADVERSARIAL TESTS: Architect Session Bootstrap Directory Threading
// Tests the two bootstrap paths in src/index.ts:
// 1. Stale-delegation reset (lines 570-574)
// 2. Deterministic Task handoff (lines 647-649)
// ============================================================================

let tmpDir: string;
let testSessionId: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adversarial-bootstrap-'));
	mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
	testSessionId = `adversarial-bootstrap-${Date.now()}`;
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
	// Clean up test sessions
	for (const key of swarmState.agentSessions.keys()) {
		if (key.startsWith('adversarial-bootstrap-')) {
			swarmState.agentSessions.delete(key);
		}
	}
	swarmState.activeAgent.clear();
});

// ============================================================================
// ATTACK VECTOR 1: Stale-delegation edge cases with directory
// ============================================================================

describe('ADVERSARIAL: Stale-delegation bootstrap with directory', () => {
	it('1. stale delegation reset with non-existent directory does not crash', () => {
		const nonExistentDir = '/this/path/does/not/exist/stale-delegation';

		// Setup: Create session with stale delegation
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000; // > 10s = stale
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Act: Simulate stale delegation detection and reset with bad directory
		// This mimics src/index.ts lines 560-577
		const currentSession = swarmState.agentSessions.get(testSessionId);
		const staleDelegation =
			!currentSession!.delegationActive ||
			Date.now() - currentSession!.lastAgentEventTime > 10000;

		expect(staleDelegation).toBe(true);

		// Should NOT throw even with non-existent directory
		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, nonExistentDir);
		}).not.toThrow();

		// Session should be reset to architect
		const result = swarmState.agentSessions.get(testSessionId);
		expect(result?.agentName).toBe(ORCHESTRATOR_NAME);
		expect(result?.delegationActive).toBe(false);
	});

	it('2. stale delegation reset with empty string directory is non-fatal', () => {
		// Setup
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Act: Empty string directory
		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, '');
		}).not.toThrow();

		// Session should still reset
		expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
	});

	it('3. stale delegation reset with whitespace-only directory is non-fatal', () => {
		// Setup
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Act: Whitespace directory
		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, '   ');
		}).not.toThrow();

		expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
	});

	it('4. stale delegation reset with undefined directory maintains backward compatibility', () => {
		// Setup
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Act: No directory parameter
		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME);
		}).not.toThrow();

		expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
	});

	it('5. stale delegation with null bytes in directory does not crash', () => {
		const dirWithNull = '/tmp/test\x00dir';

		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, dirWithNull);
		}).not.toThrow();

		expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
	});

	it('6. stale delegation reset with path traversal attempt does not crash', () => {
		const traversalDir = '/tmp/../../../etc/passwd';

		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Should be non-fatal
		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, traversalDir);
		}).not.toThrow();

		expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
	});

	it('7. stale delegation with extremely long directory path does not crash', () => {
		const longDir = `/tmp/${'a'.repeat(10000)}`;

		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, longDir);
		}).not.toThrow();

		expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
	});
});

// ============================================================================
// ATTACK VECTOR 2: Deterministic Task handoff edge cases with directory
// ============================================================================

describe('ADVERSARIAL: Deterministic Task handoff with directory', () => {
	it('8. Task handoff with non-existent directory does not crash', () => {
		const nonExistentDir = '/this/path/does/not/exist/task-handoff';

		// Setup: Session with coder
		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Act: Simulate Task tool completion (src/index.ts lines 643-657)
		// This is the deterministic handoff logic
		const normalizedTool = 'Task';

		expect(normalizedTool === 'Task' || normalizedTool === 'task').toBe(true);

		// Set active agent to architect
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		// Call ensureAgentSession with bad directory - should NOT throw
		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, nonExistentDir);
		}).not.toThrow();

		// Verify handoff occurred
		const session = swarmState.agentSessions.get(testSessionId);
		expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
		expect(session?.delegationActive).toBe(false);
	});

	it('9. Task handoff with empty string directory is non-fatal', () => {
		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, 'coder');

		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, '');
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)?.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});

	it('10. Task handoff with undefined directory maintains backward compat', () => {
		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, 'coder');

		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)?.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});

	it('11. repeated Task handoffs with varying directories do not cause issues', () => {
		const dirs = [
			'/tmp/dir1',
			'/tmp/dir2',
			'',
			'/tmp/dir3',
			undefined,
			'/tmp/dir4',
		];

		for (let i = 0; i < dirs.length; i++) {
			const sid = `repeated-task-${testSessionId}-${i}`;
			startAgentSession(sid, 'coder');
			swarmState.activeAgent.set(sid, 'coder');

			// Simulate Task completion
			swarmState.activeAgent.set(sid, ORCHESTRATOR_NAME);

			expect(() => {
				ensureAgentSession(
					sid,
					ORCHESTRATOR_NAME,
					dirs[i] as string | undefined,
				);
			}).not.toThrow();

			const session = swarmState.agentSessions.get(sid);
			expect(session?.agentName).toBe(ORCHESTRATOR_NAME);

			// Clean up
			swarmState.agentSessions.delete(sid);
		}
	});

	it('12. Task handoff with corrupted .swarm/plan.json does not crash', () => {
		// Create corrupted plan.json
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			'{{invalid json{{{',
		);

		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, 'coder');

		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		// Should NOT throw even with corrupted plan
		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)?.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});

	it('13. Task handoff updates lastAgentEventTime correctly', () => {
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		const oldTimestamp = Date.now() - 5000;
		session!.lastAgentEventTime = oldTimestamp;

		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);
		ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);

		const updatedSession = swarmState.agentSessions.get(testSessionId);
		expect(updatedSession!.lastAgentEventTime).toBeGreaterThan(oldTimestamp);
	});
});

// ============================================================================
// ATTACK VECTOR 3: Mixed stale-delegation and Task handoff scenarios
// ============================================================================

describe('ADVERSARIAL: Mixed bootstrap scenarios', () => {
	it('14. rapid alternation between stale-delegation and Task handoff', () => {
		for (let i = 0; i < 10; i++) {
			const sid = `alternating-${testSessionId}-${i}`;
			startAgentSession(sid, 'coder');
			const session = swarmState.agentSessions.get(sid);

			// First: stale delegation reset
			session!.delegationActive = true;
			session!.lastAgentEventTime = Date.now() - 15000;
			swarmState.activeAgent.set(sid, 'coder');

			// Stale check and reset
			const stale =
				!session!.delegationActive ||
				Date.now() - session!.lastAgentEventTime > 10000;
			if (stale) {
				swarmState.activeAgent.set(sid, ORCHESTRATOR_NAME);
				ensureAgentSession(sid, ORCHESTRATOR_NAME, tmpDir);
			}

			// Second: Task handoff (simulated)
			swarmState.activeAgent.set(sid, 'coder');
			ensureAgentSession(sid, ORCHESTRATOR_NAME, tmpDir);

			// Verify final state
			const finalSession = swarmState.agentSessions.get(sid);
			expect(finalSession?.agentName).toBe(ORCHESTRATOR_NAME);
			expect(finalSession?.delegationActive).toBe(false);

			swarmState.agentSessions.delete(sid);
		}
	});

	it('15. Task handoff followed immediately by stale delegation reset', () => {
		// First: Task handoff
		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);
		ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);

		// Second: Make it look stale (old timestamp, delegationActive=true)
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Reset again
		const stale =
			!session!.delegationActive ||
			Date.now() - session!.lastAgentEventTime > 10000;
		expect(stale).toBe(true);

		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);
		ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);

		// Final state should still be architect
		const finalSession = swarmState.agentSessions.get(testSessionId);
		expect(finalSession?.agentName).toBe(ORCHESTRATOR_NAME);
		// ensureAgentSession with same agentName does NOT reset delegationActive;
		// only a name change resets it — so delegationActive stays true here.
		expect(finalSession?.delegationActive).toBe(true);
	});

	it('16. concurrent bootstrap calls with different directories', () => {
		const dirs = [tmpDir, '/tmp/concurrent1', '/tmp/concurrent2', ''];

		// Create sessions concurrently
		for (let i = 0; i < dirs.length; i++) {
			const sid = `concurrent-${testSessionId}-${i}`;
			startAgentSession(sid, 'coder');
			swarmState.activeAgent.set(sid, ORCHESTRATOR_NAME);
			ensureAgentSession(sid, ORCHESTRATOR_NAME, dirs[i]);
		}

		// All should have architect as active agent
		for (let i = 0; i < dirs.length; i++) {
			const sid = `concurrent-${testSessionId}-${i}`;
			const session = swarmState.agentSessions.get(sid);
			expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
			swarmState.agentSessions.delete(sid);
		}
	});
});

// ============================================================================
// ATTACK VECTOR 4: Breaking deterministic architect takeover
// ============================================================================

describe('ADVERSARIAL: Breaking deterministic takeover attempts', () => {
	it('17. attempt to override architect during Task handoff with subagent', () => {
		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Simulate Task completion
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);
		ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);

		// Attacker tries to set subagent after handoff
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Session should still be architect-controlled
		const session = swarmState.agentSessions.get(testSessionId);
		// Note: activeAgent was changed, but ensureAgentSession set delegationActive=false

		// Next tool call should detect stale (since delegationActive=false but activeAgent != architect)
		const _staleCheck =
			!session!.delegationActive && session!.agentName === ORCHESTRATOR_NAME;
		// Actually, let's check what happens on next tool call
		expect(session?.delegationActive).toBe(false);
	});

	it('18. Task handoff with malicious plan.json does not crash', () => {
		// Write plan with potential injection
		const maliciousPlan = {
			schema_version: '1.0.0',
			title: 'Test<script>alert(1)</script>',
			swarm: 'test',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							description: 'Task${process.env.SECRET}',
							status: 'pending',
							size: 'small',
						},
					],
				},
			],
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(maliciousPlan),
		);

		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)?.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});

	it('19. stale delegation with deeply nested .swarm structure does not crash', () => {
		// Create deeply nested structure
		const deepSwarm = tmpDir;
		let current = deepSwarm;
		for (let i = 0; i < 50; i++) {
			current = path.join(current, '.swarm', 'nested', String(i));
			mkdirSync(current, { recursive: true });
		}
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Test',
				swarm: 'test',
				phases: [],
			}),
		);

		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();

		expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
	});

	it('20. Task handoff with plan.json having extreme task IDs does not crash', () => {
		const plan = {
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{
							id: '999999999.999999999', // Extreme task ID
							phase: 1,
							description: 'Task',
							status: 'pending',
							size: 'small',
						},
					],
				},
			],
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);

		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)?.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});
});

// ============================================================================
// ATTACK VECTOR 5: Edge cases with no existing session
// ============================================================================

describe('ADVERSARIAL: No existing session scenarios', () => {
	it('21. ensureAgentSession with directory when session does not exist', () => {
		// Ensure no session exists
		swarmState.agentSessions.delete(testSessionId);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();

		const session = swarmState.agentSessions.get(testSessionId);
		expect(session).toBeDefined();
		expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
	});

	it('22. stale delegation check on non-existent session does not crash', () => {
		swarmState.agentSessions.delete(testSessionId);

		// No session exists - stale check should be false (no delegation to be stale)
		const session = swarmState.agentSessions.get(testSessionId);
		const staleDelegation = session
			? !session.delegationActive ||
				Date.now() - session.lastAgentEventTime > 10000
			: false;

		expect(staleDelegation).toBe(false);

		// Should still work to create session
		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();
	});

	it('23. Task handoff with no prior session creates new session', () => {
		swarmState.agentSessions.delete(testSessionId);

		// Simulate Task completion on non-existent session
		expect(() => {
			swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();

		const session = swarmState.agentSessions.get(testSessionId);
		expect(session).toBeDefined();
		expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
	});
});

// ============================================================================
// ATTACK VECTOR 6: Unicode and special characters in directory
// ============================================================================

describe('ADVERSARIAL: Unicode and special characters', () => {
	it('24. directory with Unicode characters does not crash', () => {
		const unicodeDir = '/tmp/тест_目录_テスト';

		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, unicodeDir);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)?.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});

	it('25. directory with emoji does not crash', () => {
		const emojiDir = '/tmp/📁test';

		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, emojiDir);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)?.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});

	it('26. directory with RTL characters does not crash', () => {
		const rtlDir = '/tmp/מהלוגדשףק';

		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, rtlDir);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)?.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});

	it('27. directory with zero-width characters does not crash', () => {
		const zwDir = '/tmp/test\u200b\u200c\u200d';

		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, zwDir);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)?.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});
});

// ============================================================================
// ATTACK VECTOR 7: Replay and replay-like attacks
// ============================================================================

describe('ADVERSARIAL: Replay-like attacks', () => {
	it('28. old plan.json with stale timestamps does not cause issues', () => {
		// Create old plan
		const plan = {
			schema_version: '1.0.0',
			title: 'Old Plan',
			swarm: 'test',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'completed', // Old completed phase
					tasks: [
						{
							id: '1.1',
							phase: 1,
							description: 'Task',
							status: 'completed',
							size: 'small',
						},
					],
				},
			],
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);

		// Bootstrap should handle old plan gracefully
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();

		expect(session?.agentName).toBe(ORCHESTRATOR_NAME);
	});

	it('29. plan.json with tasks in all status values does not crash', () => {
		const statuses = [
			'pending',
			'in_progress',
			'completed',
			'blocked',
			'tests_run',
			'reviewer_delegated',
		];
		const tasks = statuses.map((status, i) => ({
			id: `1.${i + 1}`,
			phase: 1,
			description: `Task ${status}`,
			status,
			size: 'small',
		}));

		const plan = {
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks,
				},
			],
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify(plan),
		);

		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)?.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});
});
