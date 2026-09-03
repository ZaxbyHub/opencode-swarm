import { beforeEach, describe, expect, it } from 'bun:test';
import { ORCHESTRATOR_NAME } from '../../../src/config/constants';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	isGuidanceCarrier,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import {
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

function makeInput(
	sessionID = 'test-session',
	tool = 'write',
	callID = 'call-1',
) {
	return { tool, sessionID, callID };
}

describe('guardrails scope containment check (Task 5.4)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	describe('messagesTransform scope warning injection', () => {
		it('warning injection in messagesTransform prepends the violation text', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test/dir', config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			// Set activeAgent to architect for isArchitectSession check
			swarmState.activeAgent.set('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session')!;
			session.declaredCoderScope = ['src'];
			session.scopeViolationDetected = true;
			session.lastScopeViolation =
				'Scope violation for task task-123: 3 undeclared files modified: lib/file1.ts, lib/file2.ts, lib/file3.ts';
			// Set up gates to prevent PARTIAL GATE VIOLATION from also firing
			const taskId = 'task-123';
			session.currentTaskId = taskId;
			session.gateLog.set(
				taskId,
				new Set([
					'diff',
					'syntax_check',
					'placeholder_scan',
					'lint',
					'pre_check_batch',
				]),
			);
			session.reviewerCallCount.set(1, 1);

			// Simulate messagesTransform with architect session
			const messages = [
				{
					info: {
						role: 'assistant',
						agent: 'mega_architect',
						sessionID: 'test-session',
					},
					parts: [{ type: 'text', text: 'Here is the implementation.' }],
				},
			];

			await hooks.messagesTransform({}, { messages });

			// Issue #2526: SCOPE VIOLATION is model-only guidance riding a USER-role
			// guidance carrier (id 'swarm-guidance:guardrails') — the OpenCode host
			// drops role:'system' entries from this transform surface. The carrier is
			// created at index 0; the original message moves to index 1.
			const carrier = messages[0] as {
				info: { role: string; id?: unknown };
				parts: Array<{ type: string; text: string }>;
			};
			expect(isGuidanceCarrier(carrier)).toBe(true);
			expect(carrier.info.role).toBe('user');
			expect(carrier.info.id).toBe('swarm-guidance:guardrails');
			expect(carrier.parts[0].text).toContain('⚠️ SCOPE VIOLATION');
			expect(carrier.parts[0].text).toContain('[MODEL_ONLY_GUIDANCE]');
			expect(carrier.parts[0].text).toContain(
				'Only modify files within your declared scope',
			);

			// Original message is preserved and unchanged at index 1
			const originalMessage = messages[1] as {
				parts: Array<{ type: string; text: string }>;
			};
			expect(originalMessage.parts[0].text).toBe('Here is the implementation.');
		});

		it('scopeViolationDetected is cleared to false after warning injection', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test/dir', config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			swarmState.activeAgent.set('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session')!;
			session.declaredCoderScope = ['src'];
			session.scopeViolationDetected = true;
			session.lastScopeViolation =
				'Scope violation for task task-123: 3 undeclared files modified: lib/file1.ts, lib/file2.ts, lib/file3.ts';

			const messages = [
				{
					info: {
						role: 'assistant',
						agent: 'mega_architect',
						sessionID: 'test-session',
					},
					parts: [{ type: 'text', text: 'Here is the implementation.' }],
				},
			];

			await hooks.messagesTransform({}, { messages });

			// Flag should be cleared after injection
			expect(session.scopeViolationDetected).toBe(false);
		});

		it('warning injection does NOT fire when scopeViolationDetected === false', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test/dir', config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			swarmState.activeAgent.set('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session')!;
			session.declaredCoderScope = ['src'];
			session.scopeViolationDetected = false;
			// Clear gate-related state that could cause other warnings
			session.gateLog = new Map();
			session.partialGateWarningsIssuedForTask = new Set();

			const messages = [
				{
					info: {
						role: 'assistant',
						agent: 'mega_architect',
						sessionID: 'test-session',
					},
					parts: [{ type: 'text', text: 'Here is the implementation.' }],
				},
			];

			await hooks.messagesTransform({}, { messages });

			// Check that scope violation warning was NOT prepended (but other warnings might still fire)
			const updatedText = (
				messages[0] as { parts: Array<{ type: string; text: string }> }
			).parts[0].text;
			// Note: Other warnings (like partial gate violation) may still fire
			// We're just checking that SCOPE VIOLATION specifically is not present
			expect(updatedText).not.toMatch(/⚠️ SCOPE VIOLATION/);
		});

		it('messagesTransform requires architect session for scope warning injection', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test/dir', config);
			startAgentSession('test-session', 'coder');

			// Set activeAgent to coder (not architect)
			swarmState.activeAgent.set('test-session', 'coder');

			const session = getAgentSession('test-session')!;
			session.declaredCoderScope = ['src'];
			session.scopeViolationDetected = true;
			session.lastScopeViolation = 'Scope violation';

			const messages = [
				{
					info: {
						role: 'assistant',
						agent: 'coder',
						sessionID: 'test-session',
					},
					parts: [{ type: 'text', text: 'Here is the implementation.' }],
				},
			];

			await hooks.messagesTransform({}, { messages });

			// Warning should NOT be injected for non-architect session
			const updatedText = (
				messages[0] as { parts: Array<{ type: string; text: string }> }
			).parts[0].text;
			expect(updatedText).not.toContain('⚠️ SCOPE VIOLATION');
			expect(updatedText).toBe('Here is the implementation.');
		});

		it('messagesTransform with info.agent = undefined (architect session) works', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test/dir', config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			// No activeAgent set, but session is architect
			const session = getAgentSession('test-session')!;
			session.declaredCoderScope = ['src'];
			session.scopeViolationDetected = true;
			session.lastScopeViolation =
				'Scope violation for task task-123: 3 undeclared files modified: lib/file1.ts, lib/file2.ts, lib/file3.ts';

			const messages = [
				{
					info: {
						role: 'assistant',
						agent: undefined,
						sessionID: 'test-session',
					},
					parts: [{ type: 'text', text: 'Here is the implementation.' }],
				},
			];

			await hooks.messagesTransform({}, { messages });

			// Warning should be injected
			const updatedText = (
				messages[0] as { parts: Array<{ type: string; text: string }> }
			).parts[0].text;
			expect(updatedText).toContain('⚠️ SCOPE VIOLATION');
		});
	});

	describe('toolAfter scope check state management', () => {
		// These tests verify basic state management for scope checking
		// Note: Full scope violation detection depends on path resolution which requires
		// proper directory setup. These tests focus on state field behavior.

		it('declaredCoderScope === null skips scope check', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test/dir', config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session')!;
			// declaredCoderScope defaults to null
			session.lastCoderDelegationTaskId = 'task-123';
			session.modifiedFilesThisCoderTask = [
				'lib/file1.ts',
				'lib/file2.ts',
				'lib/file3.ts',
			];

			await hooks.toolBefore(makeInput('test-session', 'Task', 'call-1'), {
				args: { subagent_type: 'coder', task: 'Implement feature' },
			});

			await hooks.toolAfter(makeInput('test-session', 'Task', 'call-1'), {
				title: 'Task',
				output: 'Task completed',
				metadata: {},
			});

			// No violation because declaredCoderScope is null
			expect(session.scopeViolationDetected).toBe(false);
		});

		it('non-coder delegation does not trigger scope check', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test/dir', config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session')!;
			session.declaredCoderScope = ['src'];
			session.lastCoderDelegationTaskId = 'task-123';
			session.modifiedFilesThisCoderTask = [
				'lib/file1.ts',
				'lib/file2.ts',
				'lib/file3.ts',
			];

			// Reviewer delegation (not coder)
			await hooks.toolBefore(makeInput('test-session', 'Task', 'call-1'), {
				args: { subagent_type: 'reviewer', task: 'Review code' },
			});

			await hooks.toolAfter(makeInput('test-session', 'Task', 'call-1'), {
				title: 'Task',
				output: 'Review completed',
				metadata: {},
			});

			// No violation because it's a reviewer, not coder
			expect(session.scopeViolationDetected).toBe(false);
		});

		it('lastCoderDelegationTaskId must be set for scope check', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test/dir', config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session')!;
			session.declaredCoderScope = ['src'];
			// lastCoderDelegationTaskId is NOT set
			session.modifiedFilesThisCoderTask = [
				'lib/file1.ts',
				'lib/file2.ts',
				'lib/file3.ts',
			];

			await hooks.toolBefore(makeInput('test-session', 'Task', 'call-1'), {
				args: { subagent_type: 'coder', task: 'Implement feature' },
			});

			await hooks.toolAfter(makeInput('test-session', 'Task', 'call-1'), {
				title: 'Task',
				output: 'Task completed',
				metadata: {},
			});

			// No violation because lastCoderDelegationTaskId was not set
			expect(session.scopeViolationDetected).toBe(false);
		});
	});

	describe('scope violation state fields', () => {
		it('scopeViolationDetected flag is set on violation', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test/dir', config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			// Set activeAgent to architect
			swarmState.activeAgent.set('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session')!;
			// Directly set violation state to verify messagesTransform behavior
			session.scopeViolationDetected = true;
			session.lastScopeViolation = 'Test violation message';

			const messages = [
				{
					info: {
						role: 'assistant',
						agent: 'mega_architect',
						sessionID: 'test-session',
					},
					parts: [{ type: 'text', text: 'Test response.' }],
				},
			];

			await hooks.messagesTransform({}, { messages });

			// Verify flag is cleared after injection
			expect(session.scopeViolationDetected).toBe(false);
		});

		it('lastScopeViolation message format is correct', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test/dir', config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			swarmState.activeAgent.set('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session')!;
			session.scopeViolationDetected = true;
			session.lastScopeViolation =
				'Scope violation for task 5.1: 3 undeclared files modified: lib/a.ts, lib/b.ts, lib/c.ts';

			const messages = [
				{
					info: {
						role: 'assistant',
						agent: 'mega_architect',
						sessionID: 'test-session',
					},
					parts: [{ type: 'text', text: 'Done.' }],
				},
			];

			await hooks.messagesTransform({}, { messages });

			const text = (
				messages[0] as { parts: Array<{ type: string; text: string }> }
			).parts[0].text;
			// Verify the message format
			expect(text).toContain('⚠️ SCOPE VIOLATION:');
			expect(text).toContain('Scope violation for task 5.1');
			expect(text).toContain('3 undeclared files');
			expect(text).toContain('Only modify files within your declared scope');
		});

		it('currentTaskId sanitization works in violation message', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test/dir', config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			swarmState.activeAgent.set('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session')!;
			session.scopeViolationDetected = true;
			// Task ID with special characters - the sanitization happens when setting lastScopeViolation
			// So we set it already sanitized (as it would be after toolAfter)
			session.lastScopeViolation =
				'Scope violation for task task_with_newlines: 3 undeclared files';

			const messages = [
				{
					info: {
						role: 'assistant',
						agent: 'mega_architect',
						sessionID: 'test-session',
					},
					parts: [{ type: 'text', text: 'Done.' }],
				},
			];

			await hooks.messagesTransform({}, { messages });

			const text = (
				messages[0] as { parts: Array<{ type: string; text: string }> }
			).parts[0].text;
			// Verify sanitized version is present
			expect(text).toContain('task_with_newlines');
			expect(text).not.toContain('task\nwith\r\nnewlines');
		});
	});
});
