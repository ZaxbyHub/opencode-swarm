/**
 * v6.12 Task 4.4: Gate-Tracking ADVERSARIAL TESTS
 *
 * This test suite covers the adversarial tests for gate-tracking functionality:
 * 1. Partial gate violation detection (guardrails.messagesTransform)
 * 2. Reviewer call tracking (catastrophic warning)
 * 3. Delegation violation detection (Task 3.1)
 *
 * These tests verify that the gate-tracking system correctly detects and warns
 * about process violations while preventing false positives.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { ORCHESTRATOR_NAME } from '../../../src/config/constants';
import type { Plan } from '../../../src/config/plan-schema';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { isGuidanceCarrier } from '../../../src/hooks/system-guidance-carrier';
import {
	beginInvocation,
	getActiveWindow,
	getAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		...overrides,
	};
}

function makeDelegationConfig(
	overrides?: Record<string, unknown>,
): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
			...(overrides?.hooks as Record<string, unknown>),
		},
	} as PluginConfig;
}

function makeMessages(
	text: string,
	agent?: string,
	sessionID = 'test-session',
) {
	return {
		messages: [
			{
				info: { role: 'user' as const, agent, sessionID },
				parts: [{ type: 'text', text }],
			},
		],
	};
}

describe('v6.12 Task 4.4: Gate-Tracking ADVERSARIAL TESTS', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-gate-tracking-')),
		);
		originalCwd = process.cwd();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		fs.rmSync(tempDir, { recursive: true, force: true });
		resetSwarmState();
	});

	// ============================================================
	// HELPER: Create temp plan.json for catastrophic warning tests
	// ============================================================
	function createTempPlan(
		phases: Array<{ id: number; name: string; status: string }>,
		currentPhase: number,
	): void {
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });

		const plan: Plan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'mega',
			current_phase: currentPhase,
			phases: phases.map((p) => ({
				id: p.id,
				name: p.name,
				status: p.status as 'pending' | 'in_progress' | 'complete' | 'blocked',
				tasks: [],
			})),
		};

		const planPath = path.join(swarmDir, 'plan.json');
		fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
	}

	// ============================================================
	// PARTIAL GATE VIOLATION TESTS (Task 2.3)
	// ============================================================
	describe('Partial Gate Violation Detection', () => {
		it('all required gates observed -> no warning on messagesTransform', async () => {
			// Create temp plan with current_phase = 1 (matches our reviewerCallCount setup)
			createTempPlan([{ id: 1, name: 'Phase 1', status: 'in_progress' }], 1);
			process.chdir(tempDir);

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up architect session
			startAgentSession('full-gates', ORCHESTRATOR_NAME);
			beginInvocation('full-gates', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('full-gates', ORCHESTRATOR_NAME);

			// Manually set gateLog with all required gates
			// Set currentTaskId so getCurrentTaskId() returns the same key as gateLog
			const session = getAgentSession('full-gates');
			const taskId = 'full-gates:current';
			session!.currentTaskId = taskId;
			session!.gateLog.set(
				taskId,
				new Set([
					'diff',
					'syntax_check',
					'placeholder_scan',
					'lint',
					'pre_check_batch',
				]),
			);

			// Set reviewerCallCount for phase 1 to 1 (has reviewer delegation)
			session!.reviewerCallCount.set(1, 1);

			// Transform messages - should NOT add warning
			const messages = [
				{
					info: { role: 'assistant', sessionID: 'full-gates' },
					parts: [{ type: 'text', text: 'Task complete!' }],
				},
			];
			await hooks.messagesTransform({}, { messages });

			expect(messages[0].parts[0].text).not.toContain('PARTIAL GATE VIOLATION');
		});

		it('only pre_check_batch + syntax_check -> warning listing reviewer/test_engineer and missing gates', async () => {
			// Create temp plan with current_phase = 1 but phase is NOT complete (so catastrophic doesn't trigger)
			createTempPlan([{ id: 1, name: 'Phase 1', status: 'in_progress' }], 1);
			process.chdir(tempDir);

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up architect session
			startAgentSession('partial-gates', ORCHESTRATOR_NAME);
			beginInvocation('partial-gates', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('partial-gates', ORCHESTRATOR_NAME);

			// Manually set gateLog with only partial gates.
			// B10 (issue #1976): set currentTaskId so getCurrentTaskId() resolves to
			// the same key the gateLog was populated under. Without this the lookup
			// key fell back to 'partial-gates:unknown', missed the gateLog entirely,
			// and reported ALL gates as missing — so the test passed for the wrong
			// reason (validating the no-gateLog fallback, not the partial-gates path).
			const session = getAgentSession('partial-gates');
			const taskId = 'partial-gates:current';
			session!.currentTaskId = taskId;
			session!.gateLog.set(
				taskId,
				new Set(['pre_check_batch', 'syntax_check']),
			);

			// Set NO reviewer delegation (reviewerCallCount is empty or 0 for phase 1)
			session!.reviewerCallCount.set(1, 0);

			// Transform messages - SHOULD add warning
			const messages = [
				{
					info: { role: 'assistant', sessionID: 'partial-gates' },
					parts: [{ type: 'text', text: 'Task done!' }],
				},
			];
			await hooks.messagesTransform({}, { messages });

			expect(messages[0].parts[0].text).toContain('PARTIAL GATE VIOLATION');
			expect(messages[0].parts[0].text).toContain('reviewer/test_engineer');
			expect(messages[0].parts[0].text).toContain('diff');
			expect(messages[0].parts[0].text).toContain('placeholder_scan');
			expect(messages[0].parts[0].text).toContain('lint');
			// Strengthened (B10): the PRESENT gates must NOT be reported as missing —
			// this is what distinguishes the partial-gates path from the
			// no-gateLog fallback the test previously exercised by accident.
			expect(messages[0].parts[0].text).not.toContain('pre_check_batch');
			expect(messages[0].parts[0].text).not.toContain('syntax_check');
		});

		it('only reviewer (no pre_check_batch) -> warning listing pre_check_batch', async () => {
			// Create temp plan with current_phase = 1, not complete
			createTempPlan([{ id: 1, name: 'Phase 1', status: 'in_progress' }], 1);
			process.chdir(tempDir);

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up architect session
			startAgentSession('reviewer-only', ORCHESTRATOR_NAME);
			beginInvocation('reviewer-only', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('reviewer-only', ORCHESTRATOR_NAME);

			// Manually set gateLog with empty gates.
			// B10 (issue #1976): set currentTaskId so the lookup resolves to this
			// empty gateLog key (not the no-gateLog fallback).
			const session = getAgentSession('reviewer-only');
			const taskId = 'reviewer-only:current';
			session!.currentTaskId = taskId;
			session!.gateLog.set(taskId, new Set());

			// Set reviewerCallCount for phase 1 (has reviewer)
			session!.reviewerCallCount.set(1, 1);

			// Transform messages - SHOULD add warning about missing gates
			const messages = [
				{
					info: { role: 'assistant', sessionID: 'reviewer-only' },
					parts: [{ type: 'text', text: 'Task done!' }],
				},
			];
			await hooks.messagesTransform({}, { messages });

			expect(messages[0].parts[0].text).toContain('PARTIAL GATE VIOLATION');
			expect(messages[0].parts[0].text).toContain('pre_check_batch');
		});

		it('warning text contains PARTIAL GATE VIOLATION', async () => {
			// Create temp plan with current_phase = 1, not complete
			createTempPlan([{ id: 1, name: 'Phase 1', status: 'in_progress' }], 1);
			process.chdir(tempDir);

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up architect session
			startAgentSession('warn-test', ORCHESTRATOR_NAME);
			beginInvocation('warn-test', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('warn-test', ORCHESTRATOR_NAME);

			// Manually set gateLog with partial gates but no reviewer.
			// B10 (issue #1976): set currentTaskId so the lookup resolves to this
			// gateLog key (lint present), validating the partial-gates path rather
			// than the no-gateLog fallback.
			const session = getAgentSession('warn-test');
			const taskId = 'warn-test:current';
			session!.currentTaskId = taskId;
			session!.gateLog.set(taskId, new Set(['lint']));

			// NO reviewerCallCount (defaults to 0 for phase 1 check)

			// Transform messages
			const messages = [
				{
					info: { role: 'assistant', sessionID: 'warn-test' },
					parts: [{ type: 'text', text: 'Done!' }],
				},
			];
			await hooks.messagesTransform({}, { messages });

			expect(messages[0].parts[0].text).toContain('PARTIAL GATE VIOLATION');
			// Strengthened (B10): 'lint' is PRESENT in the gateLog, so it must not be
			// reported as missing (a missing-gates list omits observed gates).
			expect(messages[0].parts[0].text).not.toMatch(/\blint\b.*missing/);
		});

		it('uses guardrails.qa_gates.required_tools when checking partial gate violations', async () => {
			createTempPlan([{ id: 1, name: 'Phase 1', status: 'in_progress' }], 1);
			process.chdir(tempDir);

			const config = defaultConfig({
				qa_gates: {
					required_tools: ['lint'],
					require_reviewer_test_engineer: true,
				},
			} as Partial<GuardrailsConfig>);
			const hooks = createGuardrailsHooks(config);

			startAgentSession('custom-tools', ORCHESTRATOR_NAME);
			beginInvocation('custom-tools', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('custom-tools', ORCHESTRATOR_NAME);

			const session = getAgentSession('custom-tools');
			const taskId = 'custom-tools:current';
			session!.currentTaskId = taskId;
			session!.gateLog.set(taskId, new Set(['lint']));
			session!.reviewerCallCount.set(1, 1);

			const messages = [
				{
					info: { role: 'assistant', sessionID: 'custom-tools' },
					parts: [{ type: 'text', text: 'Task done!' }],
				},
			];
			await hooks.messagesTransform({}, { messages });

			expect(messages[0].parts[0].text).not.toContain('PARTIAL GATE VIOLATION');
		});

		it('can disable reviewer/test_engineer requirement via guardrails.qa_gates', async () => {
			createTempPlan([{ id: 1, name: 'Phase 1', status: 'in_progress' }], 1);
			process.chdir(tempDir);

			const config = defaultConfig({
				qa_gates: {
					required_tools: ['lint'],
					require_reviewer_test_engineer: false,
				},
			} as Partial<GuardrailsConfig>);
			const hooks = createGuardrailsHooks(config);

			startAgentSession('no-reviewer-required', ORCHESTRATOR_NAME);
			beginInvocation('no-reviewer-required', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('no-reviewer-required', ORCHESTRATOR_NAME);

			const session = getAgentSession('no-reviewer-required');
			const taskId = 'no-reviewer-required:current';
			session!.currentTaskId = taskId;
			session!.gateLog.set(taskId, new Set(['lint']));

			const messages = [
				{
					info: { role: 'assistant', sessionID: 'no-reviewer-required' },
					parts: [{ type: 'text', text: 'Task done!' }],
				},
			];
			await hooks.messagesTransform({}, { messages });

			expect(messages[0].parts[0].text).not.toContain('reviewer/test_engineer');
			expect(messages[0].parts[0].text).not.toContain('PARTIAL GATE VIOLATION');
		});

		it('gateLog does not bleed across tasks', async () => {
			// Single session with multiple task IDs
			startAgentSession('task-session', ORCHESTRATOR_NAME);
			beginInvocation('task-session', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('task-session', ORCHESTRATOR_NAME);
			const session = getAgentSession('task-session');

			// Task 1 has gates
			session!.gateLog.set('task-1', new Set(['lint', 'diff']));

			// Verify task-1 has gates
			expect(session?.gateLog.get('task-1')?.has('lint')).toBe(true);
			expect(session?.gateLog.get('task-1')?.has('diff')).toBe(true);

			// Verify task-2 does NOT inherit task-1 gates
			expect(session?.gateLog.has('task-2')).toBe(false);
		});

		it('gateLog resets on resetSwarmState', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up session with gates
			startAgentSession('before-reset', ORCHESTRATOR_NAME);
			beginInvocation('before-reset', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('before-reset', ORCHESTRATOR_NAME);
			const session = getAgentSession('before-reset');
			session!.gateLog.set('before-reset:current', new Set(['lint']));

			// Verify gateLog has entry
			expect(
				swarmState.agentSessions.get('before-reset')?.gateLog.size,
			).toBeGreaterThan(0);

			// Reset state
			resetSwarmState();

			// Verify gateLog is cleared (session is removed)
			const sessionAfterReset = swarmState.agentSessions.get('before-reset');
			expect(sessionAfterReset).toBeUndefined();
		});
	});

	// ============================================================
	// REVIEWER CALL TRACKING / CATASTROPHIC WARNING TESTS
	// ============================================================
	describe('Reviewer Call Tracking / Catastrophic Warning', () => {
		it('3 reviewer calls in phase 1 -> no catastrophic warning', async () => {
			// Create temp plan with Phase 1 complete, current phase = 2
			createTempPlan(
				[
					{ id: 1, name: 'Phase 1', status: 'complete' },
					{ id: 2, name: 'Phase 2', status: 'in_progress' },
				],
				2,
			);
			process.chdir(tempDir);

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up architect session with 3 reviewer calls in phase 1
			startAgentSession('reviewed-session', ORCHESTRATOR_NAME);
			beginInvocation('reviewed-session', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('reviewed-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('reviewed-session');
			session!.reviewerCallCount.set(1, 3); // 3 reviewer calls in phase 1
			// Ensure catastrophicPhaseWarnings is initialized
			session!.catastrophicPhaseWarnings = new Set();

			// Transform messages
			const messages = [
				{
					info: { role: 'assistant', sessionID: 'reviewed-session' },
					parts: [{ type: 'text', text: 'Phase 1 complete!' }],
				},
			];
			await hooks.messagesTransform({}, { messages });

			// Should NOT contain catastrophic warning
			expect(messages[0].parts[0].text).not.toContain('CATASTROPHIC VIOLATION');
		});

		it('0 reviewer calls in phase 1 -> catastrophic warning', async () => {
			// Create temp plan with Phase 1 complete, current phase = 2
			createTempPlan(
				[
					{ id: 1, name: 'Phase 1', status: 'complete' },
					{ id: 2, name: 'Phase 2', status: 'in_progress' },
				],
				2,
			);
			process.chdir(tempDir);

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up architect session with 0 reviewer calls in phase 1
			startAgentSession('unreviewed-session', ORCHESTRATOR_NAME);
			beginInvocation('unreviewed-session', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('unreviewed-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('unreviewed-session');
			// NO reviewerCallCount for phase 1 (or explicitly set to 0)
			session!.reviewerCallCount.set(1, 0);
			session!.catastrophicPhaseWarnings = new Set();

			// Transform messages
			const messages = [
				{
					info: { role: 'assistant', sessionID: 'unreviewed-session' },
					parts: [{ type: 'text', text: 'Phase 1 complete!' }],
				},
			];
			await hooks.messagesTransform({}, { messages });

			// Should contain catastrophic warning
			expect(messages[0].parts[0].text).toContain('CATASTROPHIC VIOLATION');
			expect(messages[0].parts[0].text).toContain('Phase 1');
			expect(messages[0].parts[0].text).toContain('ZERO reviewer');
		});

		it('does not emit catastrophic warning when reviewer/test_engineer requirement is disabled', async () => {
			// Create temp plan with Phase 1 complete, current phase = 2
			createTempPlan(
				[
					{ id: 1, name: 'Phase 1', status: 'complete' },
					{ id: 2, name: 'Phase 2', status: 'in_progress' },
				],
				2,
			);
			process.chdir(tempDir);

			const config = {
				...defaultConfig(),
				qa_gates: {
					required_tools: ['diff', 'lint'],
					require_reviewer_test_engineer: false,
				},
			};
			const hooks = createGuardrailsHooks(config);

			startAgentSession('qa-override-no-cat', ORCHESTRATOR_NAME);
			beginInvocation('qa-override-no-cat', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('qa-override-no-cat', ORCHESTRATOR_NAME);

			const session = getAgentSession('qa-override-no-cat');
			session!.reviewerCallCount.set(1, 0);
			session!.catastrophicPhaseWarnings = new Set();

			const messages = [
				{
					info: { role: 'assistant', sessionID: 'qa-override-no-cat' },
					parts: [{ type: 'text', text: 'Phase 1 complete!' }],
				},
			];
			await hooks.messagesTransform({}, { messages });

			expect(messages[0].parts[0].text).not.toContain('CATASTROPHIC VIOLATION');
		});

		it('reviewer count resets per phase: verify map values', async () => {
			// Create temp plan
			createTempPlan(
				[
					{ id: 1, name: 'Phase 1', status: 'complete' },
					{ id: 2, name: 'Phase 2', status: 'in_progress' },
				],
				2,
			);
			process.chdir(tempDir);

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up architect session
			startAgentSession('multi-phase', ORCHESTRATOR_NAME);
			beginInvocation('multi-phase', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('multi-phase', ORCHESTRATOR_NAME);

			const session = getAgentSession('multi-phase');
			// Set phase 1 count = 2, phase 2 undefined
			session!.reviewerCallCount.set(1, 2);

			// Verify map values
			expect(session!.reviewerCallCount.get(1)).toBe(2);
			expect(session!.reviewerCallCount.get(2)).toBeUndefined();

			// Transform messages - phase 1 should warn since it's complete (via plan check)
			// but phase 2 has no reviewer calls yet (not complete)
			session!.catastrophicPhaseWarnings = new Set();

			const messages = [
				{
					info: { role: 'assistant', sessionID: 'multi-phase' },
					parts: [{ type: 'text', text: 'Working on Phase 2!' }],
				},
			];
			await hooks.messagesTransform({}, { messages });

			// Phase 1 was complete but had reviewer calls (2), so no catastrophic warning
			expect(messages[0].parts[0].text).not.toContain('CATASTROPHIC VIOLATION');
		});

		it('warning text contains CATASTROPHIC VIOLATION', async () => {
			// Create temp plan with Phase 1 complete
			createTempPlan([{ id: 1, name: 'Phase 1', status: 'complete' }], 2);
			process.chdir(tempDir);

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up architect session with 0 reviewer calls
			startAgentSession('catastrophic-test', ORCHESTRATOR_NAME);
			beginInvocation('catastrophic-test', ORCHESTRATOR_NAME);
			swarmState.activeAgent.set('catastrophic-test', ORCHESTRATOR_NAME);

			const session = getAgentSession('catastrophic-test');
			session!.reviewerCallCount.set(1, 0);
			session!.catastrophicPhaseWarnings = new Set();

			// Transform messages
			const messages = [
				{
					info: { role: 'assistant', sessionID: 'catastrophic-test' },
					parts: [{ type: 'text', text: 'Done!' }],
				},
			];
			await hooks.messagesTransform({}, { messages });

			// Warning text should contain bracketed CATASTROPHIC VIOLATION
			expect(messages[0].parts[0].text).toContain('[CATASTROPHIC VIOLATION');
		});
	});

	// ============================================================
	// DELEGATION VIOLATION TESTS (Task 3.1)
	// ============================================================
	describe('Delegation Violation Detection (Task 3.1)', () => {
		it('architectWriteCount > 0 and lastCoderDelegationTaskId != currentTaskId -> warning', async () => {
			const config = makeDelegationConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Simulate session where architect has written files but NOT for current task
			const session =
				getAgentSession('delegation-test') ||
				swarmState.agentSessions.get('delegation-test') ||
				(() => {
					startAgentSession('delegation-test', 'architect');
					return getAgentSession('delegation-test')!;
				})();

			session.architectWriteCount = 3;
			session.lastCoderDelegationTaskId = 'Previous Task';

			// Current task is different from last coder delegation
			const messages = makeMessages(
				'TASK: Current Task',
				'architect',
				'delegation-test',
			);

			await hook.messagesTransform({}, messages);
			expect(messages.messages[0].parts[0].text).toContain(
				'zero coder delegations',
			);
		});

		it('architectWriteCount > 0 but lastCoderDelegationTaskId == currentTaskId -> no warning', async () => {
			const config = makeDelegationConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Simulate session where architect wrote files BUT also delegated to coder for same task
			const session =
				getAgentSession('delegation-match-test') ||
				swarmState.agentSessions.get('delegation-match-test') ||
				(() => {
					startAgentSession('delegation-match-test', 'architect');
					return getAgentSession('delegation-match-test')!;
				})();

			session.architectWriteCount = 3;
			session.lastCoderDelegationTaskId = 'Same Task';

			// Same task ID as last coder delegation
			const messages = makeMessages(
				'TASK: Same Task',
				'architect',
				'delegation-match-test',
			);
			const originalText = messages.messages[0].parts[0].text;

			await hook.messagesTransform({}, messages);

			// No warning because task matches coder delegation
			// (The [NEXT] deliberation preamble is inserted as a system message before the user message)
			const userMsg1 = messages.messages.find(
				(m: { info: { role: string } }) =>
					m.info.role === 'user' && !isGuidanceCarrier(m),
			);
			expect(userMsg1?.parts[0].text).toBe(originalText);
			expect(userMsg1?.parts[0].text).not.toContain('DELEGATION VIOLATION');
		});

		it('coder delegated then architect writes .swarm/ -> no warning', async () => {
			const config = makeDelegationConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Session with no architect writes (e.g., only .swarm/state.json updates)
			const session =
				getAgentSession('no-writes-test') ||
				swarmState.agentSessions.get('no-writes-test') ||
				(() => {
					startAgentSession('no-writes-test', 'architect');
					return getAgentSession('no-writes-test')!;
				})();

			session.architectWriteCount = 0;
			session.lastCoderDelegationTaskId = 'Plan Update Task';

			// Task matches coder delegation (no warning expected)
			const messages = makeMessages(
				'TASK: Plan Update Task',
				'architect',
				'no-writes-test',
			);
			const originalText = messages.messages[0].parts[0].text;

			await hook.messagesTransform({}, messages);

			// No warning
			const userMsg2 = messages.messages.find(
				(m: { info: { role: string } }) =>
					m.info.role === 'user' && !isGuidanceCarrier(m),
			);
			expect(userMsg2?.parts[0].text).toBe(originalText);
			expect(userMsg2?.parts[0].text).not.toContain('DELEGATION VIOLATION');
		});

		it('architectWriteCount > 0 with coder delegation message -> no warning', async () => {
			const config = makeDelegationConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Session with architect writes
			const session =
				getAgentSession('coder-delegation-test') ||
				swarmState.agentSessions.get('coder-delegation-test') ||
				(() => {
					startAgentSession('coder-delegation-test', 'architect');
					return getAgentSession('coder-delegation-test')!;
				})();

			session.architectWriteCount = 5;

			// This IS a coder delegation message
			const messages = makeMessages(
				'coder\nTASK: Implement Feature\nFILE: src/feature.ts',
				'architect',
				'coder-delegation-test',
			);
			const originalText = messages.messages[0].parts[0].text;

			await hook.messagesTransform({}, messages);

			// No DELEGATION VIOLATION warning (just clean coder delegation)
			// (The [NEXT] deliberation preamble is inserted as a system message before the user message)
			const userMsg3 = messages.messages.find(
				(m: { info: { role: string } }) =>
					m.info.role === 'user' && !isGuidanceCarrier(m),
			);
			expect(userMsg3?.parts[0].text).not.toContain('DELEGATION VIOLATION');
			expect(userMsg3?.parts[0].text).toBe(originalText);
		});
	});
});
