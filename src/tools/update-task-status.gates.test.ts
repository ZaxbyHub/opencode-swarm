import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordGateEvidence } from '../gate-evidence';
import {
	advanceTaskState,
	type DelegationEntry,
	getTaskState,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../state';
import {
	checkReviewerGate,
	executeUpdateTaskStatus,
	recoverTaskStateFromDelegations,
} from './update-task-status';

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gate-check-test-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('checkReviewerGate', () => {
	it('allows completion when task state is tests_run', () => {
		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		expect(session).toBeDefined();
		if (!session) return;

		advanceTaskState(session, '2.1', 'coder_delegated');
		advanceTaskState(session, '2.1', 'pre_check_passed');
		advanceTaskState(session, '2.1', 'reviewer_run');
		advanceTaskState(session, '2.1', 'tests_run');

		const result = checkReviewerGate('2.1');
		expect(result.blocked).toBe(false);
	});

	it('blocks completion when all valid sessions show idle state (no delegations)', () => {
		startAgentSession('session-1', 'architect');
		startAgentSession('session-2', 'architect');

		// Idle means task was never worked on — gate should block.
		// The recovery mechanism in executeUpdateTaskStatus handles
		// cases where delegations occurred but state wasn't advanced.
		const result = checkReviewerGate('2.2', tmpDir);
		expect(result.blocked).toBe(true);
	});

	it('blocks completion when non-idle states exist but no tests_run/complete state', () => {
		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		expect(session).toBeDefined();
		if (!session) return;

		advanceTaskState(session, '2.3', 'coder_delegated');

		const result = checkReviewerGate('2.3', tmpDir);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('session-1: coder_delegated');
		expect(result.reason).toContain('Missing required state');
	});

	// ── evidence-first checks ──────────────────────────────────────────────

	it('passes when evidence file has all required gates (code task)', async () => {
		await recordGateEvidence(tmpDir, '3.1', 'reviewer', 'sess-1');
		await recordGateEvidence(tmpDir, '3.1', 'test_engineer', 'sess-2');

		// Session state alone is idle (would block), but evidence wins
		startAgentSession('session-1', 'architect');

		const result = checkReviewerGate('3.1', tmpDir);
		expect(result.blocked).toBe(false);
	});

	it('passes when evidence file has all required gates (docs task — only docs gate)', async () => {
		await recordGateEvidence(tmpDir, '3.2', 'docs', 'sess-1');

		startAgentSession('session-1', 'architect');

		const result = checkReviewerGate('3.2', tmpDir);
		expect(result.blocked).toBe(false);
	});

	it('blocks with specific error when evidence is missing some gates', async () => {
		await recordGateEvidence(tmpDir, '3.3', 'reviewer', 'sess-1');
		// test_engineer not yet recorded — required_gates comes from reviewer default

		startAgentSession('session-1', 'architect');

		// Force required_gates to include both by doing a coder dispatch first
		const { recordAgentDispatch } = await import('../gate-evidence');
		await recordAgentDispatch(tmpDir, '3.3', 'coder');

		const result = checkReviewerGate('3.3', tmpDir);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('test_engineer');
		expect(result.reason).toContain('missing required gates');
	});

	it('falls through to session state when no evidence file', () => {
		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1')!;
		advanceTaskState(session, '3.4', 'coder_delegated');
		advanceTaskState(session, '3.4', 'pre_check_passed');
		advanceTaskState(session, '3.4', 'reviewer_run');
		advanceTaskState(session, '3.4', 'tests_run');

		// No evidence file in tmpDir, uses session state
		const result = checkReviewerGate('3.4', tmpDir);
		expect(result.blocked).toBe(false);
	});

	it('executeUpdateTaskStatus completes when evidence exists (no session state needed)', async () => {
		// Create plan.json
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'test task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		await recordGateEvidence(tmpDir, '1.1', 'reviewer', 'sess-1');
		await recordGateEvidence(tmpDir, '1.1', 'test_engineer', 'sess-2');

		const result = await executeUpdateTaskStatus({
			task_id: '1.1',
			status: 'completed',
			working_directory: tmpDir,
		});
		expect(result.success).toBe(true);
	});

	it('end-to-end: recordGateEvidence → executeUpdateTaskStatus succeeds (code task)', async () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '2.1',
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'code task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		await recordGateEvidence(tmpDir, '2.1', 'reviewer', 'sess-r');
		await recordGateEvidence(tmpDir, '2.1', 'test_engineer', 'sess-te');

		const result = await executeUpdateTaskStatus({
			task_id: '2.1',
			status: 'completed',
			working_directory: tmpDir,
		});
		expect(result.success).toBe(true);
		expect(result.new_status).toBe('completed');
	});

	it('end-to-end: recordGateEvidence → executeUpdateTaskStatus succeeds (docs task)', async () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '2.2',
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'docs task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		await recordGateEvidence(tmpDir, '2.2', 'docs', 'sess-docs');

		const result = await executeUpdateTaskStatus({
			task_id: '2.2',
			status: 'completed',
			working_directory: tmpDir,
		});
		expect(result.success).toBe(true);
	});

	it('error message includes names of missing gates', async () => {
		const { recordAgentDispatch } = await import('../gate-evidence');
		await recordAgentDispatch(tmpDir, '3.9', 'coder');
		await recordGateEvidence(tmpDir, '3.9', 'reviewer', 'sess-r');
		// test_engineer missing

		startAgentSession('session-1', 'architect');

		const result = checkReviewerGate('3.9', tmpDir);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('test_engineer');
	});

	// ── unscoped fallback tests ─────────────────────────────────────────────

	it('allows completion via delegation-chain fallback for pure-verification task', () => {
		// Scenario: Architect delegates reviewer then test_engineer for a code-organization task.
		// No coder delegation occurred. currentTaskId is null in all sessions.
		// The delegation chain has: [..., reviewer, test_engineer]
		// Expected: checkReviewerGate returns blocked: false (via delegation-chain fallback)

		// Set up a session with idle state
		startAgentSession('session-1', 'architect');

		// Create delegation chain with reviewer + test_engineer (no coder)
		const chain: DelegationEntry[] = [
			{ from: 'architect', to: 'mega_reviewer', timestamp: Date.now() },
			{
				from: 'architect',
				to: 'mega_test_engineer',
				timestamp: Date.now() + 1,
			},
		];
		swarmState.delegationChains.set('session-1', chain);

		// Session state is idle (task never assigned to this session)
		const result = checkReviewerGate('4.1', tmpDir);
		expect(result.blocked).toBe(false);
	});

	it('recoverTaskStateFromDelegations unscoped fallback advances state', () => {
		// Scenario: Same as Test 1, but test recoverTaskStateFromDelegations directly.
		// After calling recoverTaskStateFromDelegations(taskId), the session state should be 'tests_run'.
		// Then checkReviewerGate should return blocked: false via session state.

		startAgentSession('session-1', 'architect');

		// Create delegation chain with reviewer + test_engineer (no coder)
		const chain: DelegationEntry[] = [
			{ from: 'architect', to: 'mega_reviewer', timestamp: Date.now() },
			{
				from: 'architect',
				to: 'mega_test_engineer',
				timestamp: Date.now() + 1,
			},
		];
		swarmState.delegationChains.set('session-1', chain);

		// Verify initial state is idle
		const sessionBefore = swarmState.agentSessions.get('session-1')!;
		expect(getTaskState(sessionBefore, '4.2')).toBe('idle');

		// Call recoverTaskStateFromDelegations to advance state
		recoverTaskStateFromDelegations('4.2');

		// State should now be tests_run (both reviewer and test_engineer found)
		const sessionAfter = swarmState.agentSessions.get('session-1')!;
		expect(getTaskState(sessionAfter, '4.2')).toBe('tests_run');

		// checkReviewerGate should now pass via session state
		const result = checkReviewerGate('4.2', tmpDir);
		expect(result.blocked).toBe(false);
	});

	it('unscoped fallback blocks when coder delegation exists but reviewer/test_engineer are missing', () => {
		// Scenario: Delegation chain has coder but no reviewer or test_engineer after it.
		// Expected: checkReviewerGate returns blocked: true (unscoped fallback finds nothing)

		startAgentSession('session-1', 'architect');

		// Create delegation chain with coder but no reviewer/test_engineer after it
		const chain: DelegationEntry[] = [
			{ from: 'architect', to: 'mega_coder', timestamp: Date.now() },
		];
		swarmState.delegationChains.set('session-1', chain);

		// Also set lastCoderDelegationTaskId to simulate coder was delegated for this task
		const session = swarmState.agentSessions.get('session-1')!;
		session.lastCoderDelegationTaskId = '4.3';

		const result = checkReviewerGate('4.3', tmpDir);
		expect(result.blocked).toBe(true);
	});

	it('unscoped fallback only counts reviewer/test_engineer AFTER the last coder delegation', () => {
		// Scenario: Delegation chain is: [reviewer, test_engineer, coder] (reviewer/test_engineer BEFORE coder)
		// Expected: checkReviewerGate returns blocked: true (reviewer/test_engineer are before the last coder, not after)
		//
		// Note: This tests Pass 2 (unscoped fallback) by NOT setting currentTaskId or
		// lastCoderDelegationTaskId, so Pass 1 (task-scoped) doesn't match this task.
		// The unscoped fallback then scans all chains and correctly ignores
		// reviewer/test_engineer that appear BEFORE the last coder.

		startAgentSession('session-1', 'architect');

		// Create delegation chain: reviewer/test_engineer BEFORE coder
		const chain: DelegationEntry[] = [
			{ from: 'architect', to: 'mega_reviewer', timestamp: Date.now() },
			{
				from: 'architect',
				to: 'mega_test_engineer',
				timestamp: Date.now() + 1,
			},
			{ from: 'architect', to: 'mega_coder', timestamp: Date.now() + 2 },
		];
		swarmState.delegationChains.set('session-1', chain);

		// IMPORTANT: Do NOT set lastCoderDelegationTaskId or currentTaskId to this task.
		// This forces the unscoped fallback (Pass 2) to be used, which correctly
		// ignores reviewer/test_engineer that appear BEFORE the last coder.

		// checkReviewerGate should block because reviewer/test_engineer came BEFORE the coder
		const result = checkReviewerGate('4.4', tmpDir);
		expect(result.blocked).toBe(true);
	});

	// ── regression tests for the gate-system blocking bug ──────────────────
	// Issue: evidence file created at in_progress time (with gates: {}) caused checkReviewerGate
	// to return blocked:true even when the delegation hook correctly advanced session state to
	// tests_run. Fix: fall through to session state when evidence is incomplete.

	it('allows completion when evidence file is empty (from in_progress) but session state is tests_run', () => {
		// Scenario: update_task_status("in_progress") creates evidence with gates: {}
		// Then reviewer and test_engineer are delegated — the hook advances session state
		// to tests_run but evidence recording fails silently (lock timeout, etc.)
		// Expected: checkReviewerGate should NOT block — session state wins.

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1')!;
		advanceTaskState(session, '5.1', 'coder_delegated');
		advanceTaskState(session, '5.1', 'pre_check_passed');
		advanceTaskState(session, '5.1', 'reviewer_run');
		advanceTaskState(session, '5.1', 'tests_run');

		// Create the evidence file with empty gates (simulates what in_progress creates)
		mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '5.1.json'),
			JSON.stringify({
				taskId: '5.1',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {},
			}),
		);

		// Session state says tests_run — this should allow completion
		const result = checkReviewerGate('5.1', tmpDir);
		expect(result.blocked).toBe(false);
	});

	it('blocks when evidence is empty and session state is also idle (no delegations occurred)', () => {
		// Scenario: Evidence file created at in_progress but NO delegations ran.
		// Session state: idle. Expected: blocked with clear message about missing gates.

		startAgentSession('session-1', 'architect');
		// session state is idle (no task state advancement)

		mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '5.2.json'),
			JSON.stringify({
				taskId: '5.2',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {},
			}),
		);

		const result = checkReviewerGate('5.2', tmpDir);
		expect(result.blocked).toBe(true);
		// The reason should reference the missing gates from the evidence file (more specific)
		expect(result.reason).toContain('reviewer');
		expect(result.reason).toContain('test_engineer');
	});

	it('allows completion when evidence is partially complete and session state is tests_run', () => {
		// Scenario: Evidence has reviewer but not test_engineer; session state is tests_run.
		// Expected: session state wins, completion allowed.

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1')!;
		advanceTaskState(session, '5.3', 'coder_delegated');
		advanceTaskState(session, '5.3', 'pre_check_passed');
		advanceTaskState(session, '5.3', 'reviewer_run');
		advanceTaskState(session, '5.3', 'tests_run');

		// Evidence only has reviewer, not test_engineer
		mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '5.3.json'),
			JSON.stringify({
				taskId: '5.3',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					reviewer: {
						sessionId: 'sess-r',
						timestamp: new Date().toISOString(),
						agent: 'reviewer',
					},
				},
			}),
		);

		// Session state says tests_run — should still allow completion
		const result = checkReviewerGate('5.3', tmpDir);
		expect(result.blocked).toBe(false);
	});
});
