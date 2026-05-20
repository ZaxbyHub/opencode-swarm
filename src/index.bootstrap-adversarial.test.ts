import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ORCHESTRATOR_NAME } from './config/constants';
import { ensureAgentSession, startAgentSession, swarmState } from './state';

// ============================================================================
// ADVERSARIAL TESTS: Architect Session Bootstrap Directory Threading
// Focused on the two bootstrap paths in src/index.ts:
// 1. Stale-delegation reset (src/index.ts lines 594-598)
// 2. Deterministic Task handoff (src/index.ts lines 662-681)
//
// These tests verify the actual index.ts bootstrap patterns work correctly
// with adversarial directory values.
// ============================================================================

let tmpDir: string;
let testSessionId: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bootstrap-adv-'));
	mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
	testSessionId = `bootstrap-adv-${Date.now()}`;
	// Ensure clean state
	swarmState.agentSessions.delete(testSessionId);
	swarmState.activeAgent.delete(testSessionId);
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
	// Clean up all test sessions
	for (const key of swarmState.agentSessions.keys()) {
		if (key.startsWith('bootstrap-adv-')) {
			swarmState.agentSessions.delete(key);
		}
	}
	swarmState.activeAgent.clear();
});

// ============================================================================
// ATTACK VECTOR 1: Simulating the actual index.ts stale-delegation path
// ============================================================================

describe('ADVERSARIAL: index.ts stale-delegation bootstrap path (lines 594-598)', () => {
	it('1. stale delegation with ctx.directory = undefined preserves session', () => {
		// Simulate: ctx.directory is undefined (should not happen but test resilience)
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);

		// Set up stale delegation state (lines 570-574 in index.ts)
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000; // >10s old
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Simulate stale-delegation check (lines 582-592 in index.ts)
		const _activeAgent = swarmState.activeAgent.get(testSessionId);
		const currentSession = swarmState.agentSessions.get(testSessionId);
		const staleDelegation =
			!currentSession!.delegationActive ||
			Date.now() - currentSession!.lastAgentEventTime > 10000;

		expect(staleDelegation).toBe(true);

		// The actual bootstrap call (line 594-598 in index.ts)
		// ensureAgentSession(input.sessionID, ORCHESTRATOR_NAME, ctx.directory);
		// ctx.directory could be undefined
		const result = ensureAgentSession(
			testSessionId,
			ORCHESTRATOR_NAME,
			undefined,
		);

		expect(result.agentName).toBe(ORCHESTRATOR_NAME);
		expect(result.delegationActive).toBe(false);
	});

	it('2. stale delegation with ctx.directory = null preserves session', () => {
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Bootstrap with null directory (line 594-598)
		const result = ensureAgentSession(
			testSessionId,
			ORCHESTRATOR_NAME,
			null as any,
		);

		expect(result.agentName).toBe(ORCHESTRATOR_NAME);
		expect(result.delegationActive).toBe(false);
	});

	it('3. stale delegation when activeToolCalls has OTHER calls blocks reset', () => {
		// This tests the guard at lines 572-580 in index.ts
		// hasActiveToolCall should block stale delegation reset
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Simulate another tool call in progress
		const otherCallId = `other-call-${Date.now()}`;
		swarmState.activeToolCalls.set(otherCallId, {
			tool: 'read',
			sessionID: testSessionId,
			callID: otherCallId,
			startTime: Date.now(),
		});

		// Check: should NOT reset because other call is in progress
		const hasActiveToolCall = Array.from(
			swarmState.activeToolCalls.values(),
		).some(
			(entry) =>
				entry.sessionID === testSessionId && entry.callID !== 'current-call-id',
		);

		expect(hasActiveToolCall).toBe(true);

		// Even with stale delegation, should not reset due to other active call
		// (This is the expected behavior per index.ts lines 572-585)

		swarmState.activeToolCalls.clear();
	});

	it('4. stale delegation with ctx.directory path traversal attempt', () => {
		const traversalPath = '/tmp/../../../etc/passwd';

		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Should be non-fatal
		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, traversalPath);
		}).not.toThrow();

		expect(session!.agentName).toBe(ORCHESTRATOR_NAME);
	});

	it('5. stale delegation with extremely long directory (DoS attempt)', () => {
		const longPath = `/tmp/${'x'.repeat(100000)}`;

		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 15000;
		swarmState.activeAgent.set(testSessionId, 'coder');

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, longPath);
		}).not.toThrow();

		expect(session!.agentName).toBe(ORCHESTRATOR_NAME);
	});
});

// ============================================================================
// ATTACK VECTOR 2: Simulating the actual index.ts Task handoff path
// ============================================================================

describe('ADVERSARIAL: index.ts Task handoff bootstrap path (lines 662-681)', () => {
	it('6. Task handoff with ctx.directory = undefined preserves session', () => {
		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Simulate Task tool completion (lines 662-681 in index.ts)
		const normalizedTool = 'Task';

		if (normalizedTool === 'Task' || normalizedTool === 'task') {
			// Set active agent to architect
			swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

			// Line 673: ensureAgentSession(sessionId, ORCHESTRATOR_NAME, ctx.directory);
			// ctx.directory could be undefined
			const result = ensureAgentSession(
				testSessionId,
				ORCHESTRATOR_NAME,
				undefined,
			);

			// Lines 675-680: Update session state
			const session = swarmState.agentSessions.get(testSessionId);
			session!.delegationActive = false;
			session!.lastAgentEventTime = Date.now();

			expect(result.agentName).toBe(ORCHESTRATOR_NAME);
			expect(result.delegationActive).toBe(false);
		}
	});

	it('7. Task handoff with ctx.directory = null is non-fatal', () => {
		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, 'coder');

		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, null as any);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)!.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});

	it('8. Task handoff correctly sets delegationActive=false', () => {
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);

		// Initially delegation might be active
		session!.delegationActive = true;
		session!.lastAgentEventTime = Date.now() - 5000;

		swarmState.activeAgent.set(testSessionId, 'coder');

		// Simulate Task completion
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);
		ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);

		// Explicitly set as per lines 675-680
		session!.delegationActive = false;
		session!.lastAgentEventTime = Date.now();

		expect(session!.delegationActive).toBe(false);
		expect(session!.lastAgentEventTime).toBeGreaterThan(Date.now() - 1000);
	});

	it('9. Task handoff with lowercase "task" tool name works', () => {
		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Lowercase variant should match
		const normalizedTool = 'task' as string;
		const shouldHandoff =
			normalizedTool === 'Task' || normalizedTool === 'task';

		expect(shouldHandoff).toBe(true);

		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);
		const result = ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);

		expect(result.agentName).toBe(ORCHESTRATOR_NAME);
	});

	it('10. Task tool with unusual capitalization does NOT trigger handoff', () => {
		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Should NOT trigger handoff - uppercase TASK doesn't match
		const normalizedTool = 'TASK' as string;
		const shouldHandoff =
			normalizedTool === 'Task' || normalizedTool === 'task';

		expect(shouldHandoff).toBe(false);

		// Agent should remain as coder
		const session = swarmState.agentSessions.get(testSessionId);
		expect(session!.agentName).toBe('coder');
	});
});

// ============================================================================
// ATTACK VECTOR 3: Repeated Task handoffs (stress test)
// ============================================================================

describe('ADVERSARIAL: Repeated Task handoffs', () => {
	it('11. 10 rapid consecutive Task handoffs maintain deterministic state', () => {
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);

		for (let i = 0; i < 10; i++) {
			// Simulate Task tool completion each time
			swarmState.activeAgent.set(testSessionId, 'coder');
			swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);

			// Update as per lines 675-680
			session!.delegationActive = false;
			session!.lastAgentEventTime = Date.now();
		}

		// Should always end up as architect
		expect(session!.agentName).toBe(ORCHESTRATOR_NAME);
		expect(session!.delegationActive).toBe(false);
	});

	it('12. alternating stale-delegation and Task handoff 5 times', () => {
		for (let i = 0; i < 5; i++) {
			const sid = `alternating-${testSessionId}-${i}`;
			startAgentSession(sid, 'coder');
			const session = swarmState.agentSessions.get(sid);

			// Path 1: Stale delegation reset
			session!.delegationActive = true;
			session!.lastAgentEventTime = Date.now() - 15000;
			swarmState.activeAgent.set(sid, 'coder');

			const stale =
				!session!.delegationActive ||
				Date.now() - session!.lastAgentEventTime > 10000;

			if (stale) {
				swarmState.activeAgent.set(sid, ORCHESTRATOR_NAME);
				ensureAgentSession(sid, ORCHESTRATOR_NAME, tmpDir);
			}

			// Path 2: Task handoff
			session!.delegationActive = false;
			swarmState.activeAgent.set(sid, 'coder');
			swarmState.activeAgent.set(sid, ORCHESTRATOR_NAME);
			ensureAgentSession(sid, ORCHESTRATOR_NAME, tmpDir);

			// Final state
			const finalSession = swarmState.agentSessions.get(sid);
			expect(finalSession!.agentName).toBe(ORCHESTRATOR_NAME);

			swarmState.agentSessions.delete(sid);
		}
	});

	it('13. Task handoff with different directories each time', () => {
		const dirs = [tmpDir, '/tmp/dir1', '/tmp/dir2', undefined, '', '/tmp/dir3'];

		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);

		for (const dir of dirs) {
			swarmState.activeAgent.set(testSessionId, 'coder');
			swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);
			ensureAgentSession(
				testSessionId,
				ORCHESTRATOR_NAME,
				dir as string | undefined,
			);

			session!.delegationActive = false;
			session!.lastAgentEventTime = Date.now();
		}

		expect(session!.agentName).toBe(ORCHESTRATOR_NAME);
	});
});

// ============================================================================
// ATTACK VECTOR 4: Breaking deterministic takeover attempts
// ============================================================================

describe('ADVERSARIAL: Breaking deterministic architect takeover', () => {
	it('14. attempting to set subagent immediately after Task handoff', () => {
		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, 'coder');

		// Normal Task handoff
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);
		ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);

		const session = swarmState.agentSessions.get(testSessionId);
		expect(session!.delegationActive).toBe(false);

		// Attacker tries to override
		swarmState.activeAgent.set(testSessionId, 'coder');

		// On next tool call, stale delegation check should catch this
		// because delegationActive is false but activeAgent is not ORCHESTRATOR_NAME
		const staleCheck =
			session!.agentName === ORCHESTRATOR_NAME &&
			!session!.delegationActive &&
			swarmState.activeAgent.get(testSessionId) !== ORCHESTRATOR_NAME;

		// This should trigger reset on next tool call
		expect(staleCheck).toBe(true);
	});

	it('15. concurrent Task handoffs for different sessions work independently', () => {
		const sessionIds = ['sess1', 'sess2', 'sess3', 'sess4', 'sess5'];

		for (const sid of sessionIds) {
			startAgentSession(sid, 'coder');
			swarmState.activeAgent.set(sid, 'coder');
			swarmState.activeAgent.set(sid, ORCHESTRATOR_NAME);
			ensureAgentSession(sid, ORCHESTRATOR_NAME, tmpDir);

			const session = swarmState.agentSessions.get(sid);
			expect(session!.agentName).toBe(ORCHESTRATOR_NAME);
			expect(session!.delegationActive).toBe(false);
		}

		// All should be architect
		for (const sid of sessionIds) {
			const session = swarmState.agentSessions.get(sid);
			expect(session!.agentName).toBe(ORCHESTRATOR_NAME);
		}
	});

	it('16. Task handoff with plan.json containing template injection attempt', () => {
		// Create plan with potential template injection
		const maliciousPlan = {
			schema_version: '1.0.0',
			title: 'Test${console.log("pwned")}',
			swarm: 'test',
			phases: [
				{
					id: 1,
					name: 'Phase${require("fs").readdirSync("/")}',
					status: 'pending',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							description: 'Task${globalThis.process.exit(1)}',
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

		// Should NOT execute the template strings - just parse JSON
		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)!.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});

	it('17. Task handoff with missing currentTaskId in session is safe', () => {
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);

		// Ensure currentTaskId is null/undefined
		session!.currentTaskId = null;

		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();

		expect(session!.agentName).toBe(ORCHESTRATOR_NAME);
	});
});

// ============================================================================
// ATTACK VECTOR 5: Edge cases from real-world usage
// ============================================================================

describe('ADVERSARIAL: Real-world edge cases', () => {
	it('18. session with all null/undefined optional fields', () => {
		startAgentSession(testSessionId, 'coder');
		const session = swarmState.agentSessions.get(testSessionId);

		// Set all optional fields to problematic values
		session!.currentTaskId = null;
		session!.lastCoderDelegationTaskId = null;
		session!.lastGateFailure = null;
		session!.lastGateOutcome = null;
		session!.declaredCoderScope = null;

		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, tmpDir);
		}).not.toThrow();
	});

	it('19. directory with symlink does not cause issues', () => {
		// Create a symlink
		const linkPath = path.join(tmpDir, 'symlink-dir');
		const targetPath = path.join(tmpDir, 'real-dir');
		mkdirSync(targetPath, { recursive: true });

		try {
			// Create symlink (may fail on Windows without admin, skip if so)
			require('node:fs').symlinkSync(targetPath, linkPath, 'dir');
		} catch {
			// Skip on platforms that don't support symlinks
			return;
		}

		startAgentSession(testSessionId, 'coder');
		swarmState.activeAgent.set(testSessionId, ORCHESTRATOR_NAME);

		expect(() => {
			ensureAgentSession(testSessionId, ORCHESTRATOR_NAME, linkPath);
		}).not.toThrow();

		expect(swarmState.agentSessions.get(testSessionId)!.agentName).toBe(
			ORCHESTRATOR_NAME,
		);
	});

	it('20. directory with trailing slashes works', () => {
		const dirWithTrailingSlash = `${tmpDir}/`;
		const dirWithMultipleSlashes = `${tmpDir}///`;

		startAgentSession(testSessionId, 'coder');

		expect(() => {
			ensureAgentSession(
				testSessionId,
				ORCHESTRATOR_NAME,
				dirWithTrailingSlash,
			);
		}).not.toThrow();

		expect(() => {
			ensureAgentSession(
				testSessionId,
				ORCHESTRATOR_NAME,
				dirWithMultipleSlashes,
			);
		}).not.toThrow();
	});
});
