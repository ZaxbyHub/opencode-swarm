/**
 * Integration tests for evidence recording in delegation-gate.ts toolAfter.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasPassedAllGates, readTaskEvidence } from '../gate-evidence';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../state';
import { parseCompletedTasks } from '../tools/evidence-check';
import { checkReviewerGate } from '../tools/update-task-status';
import { createDelegationGateHook } from './delegation-gate';

// Minimal plugin config
const testConfig = {
	hooks: { delegation_gate: true },
} as unknown as Parameters<typeof createDelegationGateHook>[0];

let tmpDir: string;
let origCwd: string;

beforeEach(() => {
	resetSwarmState();
	origCwd = process.cwd();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dg-evidence-test-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	// Point process.cwd() to tmpDir so evidence is written there
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(origCwd);
	resetSwarmState();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

/**
 * Fires toolAfter with the given subagent_type for the given session.
 */
async function fireToolAfter(
	sessionId: string,
	subagentType: string,
	callID = 'call-1',
): Promise<void> {
	const hook = createDelegationGateHook(testConfig, tmpDir);
	await hook.toolAfter(
		{
			tool: 'Task',
			sessionID: sessionId,
			callID,
			args: { subagent_type: subagentType },
		},
		{},
	);
}

describe('delegation-gate evidence recording', () => {
	it('1. toolAfter with subagent_type: reviewer creates reviewer evidence for currentTaskId', async () => {
		startAgentSession('sess-1', 'architect');
		const session = ensureAgentSession('sess-1');
		session.currentTaskId = '1.1';

		await fireToolAfter('sess-1', 'reviewer');

		const evidence = await readTaskEvidence(tmpDir, '1.1');
		expect(evidence).not.toBeNull();
		expect(evidence!.gates.reviewer).toBeDefined();
		expect(evidence!.gates.reviewer.sessionId).toBe('sess-1');
	});

	it('2. toolAfter with subagent_type: test_engineer creates test_engineer evidence', async () => {
		startAgentSession('sess-2', 'architect');
		const session = ensureAgentSession('sess-2');
		session.currentTaskId = '1.2';

		await fireToolAfter('sess-2', 'test_engineer');

		const evidence = await readTaskEvidence(tmpDir, '1.2');
		expect(evidence).not.toBeNull();
		expect(evidence!.gates.test_engineer).toBeDefined();
	});

	it('3. toolAfter with subagent_type: coder creates dispatch record (required_gates set, gates empty)', async () => {
		startAgentSession('sess-3', 'architect');
		const session = ensureAgentSession('sess-3');
		session.currentTaskId = '1.3';

		await fireToolAfter('sess-3', 'coder');

		const evidence = await readTaskEvidence(tmpDir, '1.3');
		expect(evidence).not.toBeNull();
		expect(evidence!.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(Object.keys(evidence!.gates)).toHaveLength(0);
	});

	it('4. toolAfter with subagent_type: docs creates evidence with required_gates:[docs] and docs gate', async () => {
		startAgentSession('sess-4', 'architect');
		const session = ensureAgentSession('sess-4');
		session.currentTaskId = '1.4';

		await fireToolAfter('sess-4', 'docs');

		const evidence = await readTaskEvidence(tmpDir, '1.4');
		expect(evidence).not.toBeNull();
		expect(evidence!.required_gates).toEqual(['docs']);
		expect(evidence!.gates.docs).toBeDefined();
	});

	it('5. after both reviewer + test_engineer toolAfter, hasPassedAllGates returns true', async () => {
		startAgentSession('sess-5', 'architect');
		const session = ensureAgentSession('sess-5');
		session.currentTaskId = '1.5';

		// Coder dispatch sets required_gates
		await fireToolAfter('sess-5', 'coder', 'call-1');
		// Reviewer pass
		await fireToolAfter('sess-5', 'reviewer', 'call-2');
		// test_engineer pass
		await fireToolAfter('sess-5', 'test_engineer', 'call-3');

		expect(await hasPassedAllGates(tmpDir, '1.5')).toBe(true);
	});

	it('6. after docs toolAfter on docs task, hasPassedAllGates returns true', async () => {
		startAgentSession('sess-6', 'architect');
		const session = ensureAgentSession('sess-6');
		session.currentTaskId = '1.6';

		await fireToolAfter('sess-6', 'docs', 'call-1');

		expect(await hasPassedAllGates(tmpDir, '1.6')).toBe(true);
	});

	it('7. evidence is recorded even when state advancement produces warnings', async () => {
		startAgentSession('sess-7', 'architect');
		const session = ensureAgentSession('sess-7');
		session.currentTaskId = '1.7';

		// Fire reviewer without prior coder_delegated state — advanceTaskState will warn but not throw
		await fireToolAfter('sess-7', 'reviewer', 'call-1');

		const evidence = await readTaskEvidence(tmpDir, '1.7');
		expect(evidence).not.toBeNull();
		expect(evidence!.gates.reviewer).toBeDefined();
	});

	it('8. evidence uses lastCoderDelegationTaskId when currentTaskId is null', async () => {
		startAgentSession('sess-8', 'architect');
		const session = ensureAgentSession('sess-8');
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = '2.1';

		await fireToolAfter('sess-8', 'reviewer', 'call-1');

		const evidence = await readTaskEvidence(tmpDir, '2.1');
		expect(evidence).not.toBeNull();
		expect(evidence!.gates.reviewer).toBeDefined();
	});

	it('9. no evidence recorded when both currentTaskId and lastCoderDelegationTaskId are null', async () => {
		startAgentSession('sess-9', 'architect');
		const session = ensureAgentSession('sess-9');
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;

		await fireToolAfter('sess-9', 'reviewer', 'call-1');

		// No task ID → no evidence file created (no error either)
		// Evidence dir may not even exist
		const evidence = await readTaskEvidence(tmpDir, '1.1');
		expect(evidence).toBeNull();
	});

	it('10. docs dispatch then coder dispatch expands required_gates; hasPassedAllGates false until reviewer+test_engineer', async () => {
		startAgentSession('sess-10', 'architect');
		const session = ensureAgentSession('sess-10');
		session.currentTaskId = '3.1';

		// docs delegation — sets required_gates: [docs], records docs gate
		await fireToolAfter('sess-10', 'docs', 'call-1');

		let evidence = await readTaskEvidence(tmpDir, '3.1');
		expect(evidence!.required_gates).toEqual(['docs']);

		// coder delegation — expands required_gates: [docs, reviewer, test_engineer]
		await fireToolAfter('sess-10', 'coder', 'call-2');
		evidence = await readTaskEvidence(tmpDir, '3.1');
		expect(evidence!.required_gates).toEqual([
			'docs',
			'reviewer',
			'test_engineer',
		]);

		// Not all gates passed yet
		expect(await hasPassedAllGates(tmpDir, '3.1')).toBe(false);

		// Record reviewer and test_engineer
		await fireToolAfter('sess-10', 'reviewer', 'call-3');
		await fireToolAfter('sess-10', 'test_engineer', 'call-4');

		expect(await hasPassedAllGates(tmpDir, '3.1')).toBe(true);
	});

	it('11. evidence-write failure emits console.warn but does not block delegation', async () => {
		startAgentSession('sess-11', 'architect');
		const session = ensureAgentSession('sess-11');
		session.currentTaskId = '1.11';

		const swarmDir = path.join(tmpDir, '.swarm');

		// Replace the .swarm directory with a file to trigger write failure
		// This simulates a scenario where the evidence path is not writable
		rmSync(swarmDir, { recursive: true, force: true });
		writeFileSync(swarmDir, 'blocked'); // Make it a file instead of directory

		// Spy on console.warn
		const originalWarn = console.warn;
		const warnCalls: string[] = [];
		console.warn = (...args: unknown[]) => {
			warnCalls.push(args.map(String).join(' '));
		};

		try {
			// This should NOT throw - evidence write failure should be non-blocking
			await fireToolAfter('sess-11', 'reviewer', 'call-1');

			// Verify console.warn was called with task context
			expect(
				warnCalls.some(
					(msg) =>
						msg.includes('evidence recording failed') ||
						msg.includes('evidence write failed'),
				),
			).toBe(true);
		} finally {
			// Restore console.warn
			console.warn = originalWarn;
		}
	});

	// TEST 12: Verifies evidence is written using taskWorkflowStates when currentTaskId and lastCoderDelegationTaskId are null.
	// This was previously a gap (tested old broken behavior), now fixed by Task 1.52.
	it('12. evidence written via taskWorkflowStates when currentTaskId and lastCoderDelegationTaskId are null', async () => {
		startAgentSession('sess-12', 'architect');
		const session = ensureAgentSession('sess-12');
		// Set taskWorkflowStates with a determinable task entry
		session.taskWorkflowStates.set('5.1', 'coder_delegated');
		// But both currentTaskId and lastCoderDelegationTaskId are null
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;

		await fireToolAfter('sess-12', 'reviewer', 'call-1');

		// FIXED BEHAVIOR: Evidence is written using taskWorkflowStates entry
		const evidence = await readTaskEvidence(tmpDir, '5.1');
		expect(evidence).not.toBeNull();
		expect(evidence!.gates.reviewer).toBeDefined();
		expect(evidence!.gates.reviewer.sessionId).toBe('sess-12');
	});

	// TEST 13: Verifies evidence_check can consume taskWorkflowStates fallback evidence to count task as complete
	it('13. evidence_check counts taskWorkflowStates-fallback evidence as complete when required gates present', async () => {
		startAgentSession('sess-13', 'architect');
		const session = ensureAgentSession('sess-13');
		// Set taskWorkflowStates with a determinable task entry
		session.taskWorkflowStates.set('5.2', 'coder_delegated');
		// Both primary task ID fields are null - uses taskWorkflowStates fallback
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;

		// Fire reviewer and test_engineer toolAfter to record gates
		await fireToolAfter('sess-13', 'reviewer', 'call-1');
		await fireToolAfter('sess-13', 'test_engineer', 'call-2');

		// Create plan.md with task marked complete
		const planContent = `# Swarm: test-swarm

## Phase 1
- [x] 5.2 : Test task via taskWorkflowStates fallback [SMALL]
`;
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.md'), planContent);

		// Verify evidence was written
		const evidence = await readTaskEvidence(tmpDir, '5.2');
		expect(evidence).not.toBeNull();
		expect(evidence!.gates.reviewer).toBeDefined();
		expect(evidence!.gates.test_engineer).toBeDefined();
		expect(evidence!.required_gates).toContain('reviewer');
		expect(evidence!.required_gates).toContain('test_engineer');

		// Verify evidence_check parses the task as complete with full evidence
		const completedTasks = parseCompletedTasks(planContent);
		expect(completedTasks).toHaveLength(1);
		expect(completedTasks[0]!.taskId).toBe('5.2');

		// evidence_check would report this task as having full evidence
		expect(await hasPassedAllGates(tmpDir, '5.2')).toBe(true);
	});

	// TEST 14: Verifies checkReviewerGate treats taskWorkflowStates-fallback evidence as unblocked
	it('14. checkReviewerGate treats taskWorkflowStates-fallback evidence as unblocked when all gates present', async () => {
		startAgentSession('sess-14', 'architect');
		const session = ensureAgentSession('sess-14');
		// Set taskWorkflowStates with a determinable task entry
		session.taskWorkflowStates.set('5.3', 'coder_delegated');
		// Both primary task ID fields are null - uses taskWorkflowStates fallback
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;

		// Fire reviewer and test_engineer toolAfter to record gates
		await fireToolAfter('sess-14', 'reviewer', 'call-1');
		await fireToolAfter('sess-14', 'test_engineer', 'call-2');

		// Verify evidence was written
		const evidence = await readTaskEvidence(tmpDir, '5.3');
		expect(evidence).not.toBeNull();
		expect(evidence!.gates.reviewer).toBeDefined();
		expect(evidence!.gates.test_engineer).toBeDefined();

		// Verify checkReviewerGate returns unblocked (blocked: false)
		const gateResult = checkReviewerGate('5.3', tmpDir);
		expect(gateResult.blocked).toBe(false);
		expect(gateResult.reason).toBe('');
	});

	// TEST 15: Verifies checkReviewerGate treats taskWorkflowStates-fallback evidence as blocked when gates missing
	it('15. checkReviewerGate treats taskWorkflowStates-fallback evidence as blocked when gates missing', async () => {
		startAgentSession('sess-15', 'architect');
		const session = ensureAgentSession('sess-15');
		// Set taskWorkflowStates with a determinable task entry
		session.taskWorkflowStates.set('5.4', 'coder_delegated');
		// Both primary task ID fields are null - uses taskWorkflowStates fallback
		session.currentTaskId = null;
		session.lastCoderDelegationTaskId = null;

		// First dispatch coder to establish required_gates: [reviewer, test_engineer]
		await fireToolAfter('sess-15', 'coder', 'call-1');
		// Then dispatch reviewer - test_engineer is still missing
		await fireToolAfter('sess-15', 'reviewer', 'call-2');

		// Verify evidence was written with correct required_gates
		const evidence = await readTaskEvidence(tmpDir, '5.4');
		expect(evidence).not.toBeNull();
		expect(evidence!.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(evidence!.gates.reviewer).toBeDefined();
		// test_engineer gate is NOT recorded

		// Verify checkReviewerGate returns blocked (missing test_engineer)
		const gateResult = checkReviewerGate('5.4', tmpDir);
		expect(gateResult.blocked).toBe(true);
		expect(gateResult.reason).toContain('test_engineer');
	});

	// TEST 16: Verifies explorer delegation writes durable evidence with required_gates: ['explorer'] and gates.explorer
	it('16. toolAfter with subagent_type: explorer creates explorer evidence with required_gates:[explorer]', async () => {
		startAgentSession('sess-16', 'architect');
		const session = ensureAgentSession('sess-16');
		session.currentTaskId = '1.16';

		await fireToolAfter('sess-16', 'explorer');

		const evidence = await readTaskEvidence(tmpDir, '1.16');
		expect(evidence).not.toBeNull();
		expect(evidence!.required_gates).toEqual(['explorer']);
		expect(evidence!.gates.explorer).toBeDefined();
		expect(evidence!.gates.explorer.sessionId).toBe('sess-16');
	});

	// TEST 17: Verifies sme delegation writes durable evidence with required_gates: ['sme'] and gates.sme
	it('17. toolAfter with subagent_type: sme creates sme evidence with required_gates:[sme]', async () => {
		startAgentSession('sess-17', 'architect');
		const session = ensureAgentSession('sess-17');
		session.currentTaskId = '1.17';

		await fireToolAfter('sess-17', 'sme');

		const evidence = await readTaskEvidence(tmpDir, '1.17');
		expect(evidence).not.toBeNull();
		expect(evidence!.required_gates).toEqual(['sme']);
		expect(evidence!.gates.sme).toBeDefined();
		expect(evidence!.gates.sme.sessionId).toBe('sess-17');
	});

	// TEST 18: Verifies explorer-only analysis task is not blocked by checkReviewerGate once evidence exists
	it('18. explorer-only analysis task is not blocked by checkReviewerGate after explorer evidence recorded', async () => {
		startAgentSession('sess-18', 'architect');
		const session = ensureAgentSession('sess-18');
		session.currentTaskId = '1.18';

		// Record explorer evidence
		await fireToolAfter('sess-18', 'explorer', 'call-1');

		// Verify evidence was written
		const evidence = await readTaskEvidence(tmpDir, '1.18');
		expect(evidence).not.toBeNull();
		expect(evidence!.required_gates).toEqual(['explorer']);
		expect(evidence!.gates.explorer).toBeDefined();

		// Verify checkReviewerGate returns unblocked for explorer-only task
		const gateResult = checkReviewerGate('1.18', tmpDir);
		expect(gateResult.blocked).toBe(false);
		expect(gateResult.reason).toBe('');
	});
});
