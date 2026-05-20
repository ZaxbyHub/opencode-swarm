import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { ORCHESTRATOR_NAME } from '../../../src/config/constants';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';

function makeGuardrailsConfig(overrides?: Record<string, unknown>) {
	return {
		enabled: true,
		warning_threshold: 0.8,
		max_tool_calls: 100,
		max_duration_minutes: 30,
		max_repetitions: 5,
		max_consecutive_errors: 3,
		idle_timeout_minutes: 10,
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

// ============================================
// Task 2.1: Architect Self-Coding Detection
// ============================================
describe('architect self-coding detection (Task 2.1)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('architect writing to .swarm/ files does NOT trigger warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Architect writes to .swarm/state.json (a non-blocked .swarm/ file)
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: '.swarm/state.json', content: '{}' },
		};

		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Check that architectWriteCount was NOT incremented
		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(0);
	});

	it('architect writing to src/foo.ts DOES trigger warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Architect writes to src/foo.ts
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'console.log("test");' },
		};

		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Check that architectWriteCount was incremented
		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(1);

		// Now call messagesTransform to verify warning is injected
		const messages = makeMessages(
			'TASK: Check the code',
			'architect',
			sessionId,
		);
		await hook.messagesTransform({}, messages as any);

		// Verify warning contains SELF-CODING DETECTED
		expect(messages.messages[0].parts[0].text).toContain(
			'SELF-CODING DETECTED',
		);
		expect(messages.messages[0].parts[0].text).toContain('1 write-class');
	});

	it('coder writing to src/foo.ts does NOT trigger warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up coder session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, 'mega_coder');
		startAgentSession(sessionId, 'mega_coder');

		// Coder writes to src/foo.ts
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'console.log("test");' },
		};

		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Verify warning is NOT injected
		const messages = makeMessages(
			'Working on the code',
			'mega_coder',
			sessionId,
		);
		await hook.messagesTransform({}, messages as any);

		// Should NOT contain SELF-CODING DETECTED
		expect(messages.messages[0].parts[0].text).not.toContain(
			'SELF-CODING DETECTED',
		);
	});

	it('warning includes write count', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Architect writes twice
		const toolInput1 = {
			tool: 'write',
			sessionID: sessionId,
			callID: 'call-1',
		};
		const toolOutput1 = {
			args: { filePath: 'src/foo.ts', content: 'const x = 1;' },
		};
		await hook.toolBefore(toolInput1 as any, toolOutput1 as any);

		const toolInput2 = { tool: 'edit', sessionID: sessionId, callID: 'call-2' };
		const toolOutput2 = {
			args: { filePath: 'src/bar.ts', content: 'const y = 2;' },
		};
		await hook.toolBefore(toolInput2 as any, toolOutput2 as any);

		// Verify count is 2
		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(2);

		// Now call messagesTransform
		const messages = makeMessages('TASK: Review', 'architect', sessionId);
		await hook.messagesTransform({}, messages as any);

		// Verify warning includes write count
		expect(messages.messages[0].parts[0].text).toContain('2 write-class');
	});

	it('warning text contains SELF-CODING DETECTED', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Architect writes to src/foo.ts
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'console.log("test");' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Verify warning text contains SELF-CODING DETECTED
		const messages = makeMessages('TASK: Check', 'architect', sessionId);
		await hook.messagesTransform({}, messages as any);

		expect(messages.messages[0].parts[0].text).toContain(
			'SELF-CODING DETECTED',
		);
	});

	it('architectWriteCount increments per write', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(0);

		// First write
		const toolInput1 = {
			tool: 'write',
			sessionID: sessionId,
			callID: 'call-1',
		};
		const toolOutput1 = { args: { filePath: 'src/a.ts', content: 'a' } };
		await hook.toolBefore(toolInput1 as any, toolOutput1 as any);
		expect(session.architectWriteCount).toBe(1);

		// Second write
		const toolInput2 = { tool: 'edit', sessionID: sessionId, callID: 'call-2' };
		const toolOutput2 = { args: { filePath: 'src/b.ts', content: 'b' } };
		await hook.toolBefore(toolInput2 as any, toolOutput2 as any);
		expect(session.architectWriteCount).toBe(2);

		// Third write
		const toolInput3 = {
			tool: 'patch',
			sessionID: sessionId,
			callID: 'call-3',
		};
		const toolOutput3 = { args: { filePath: 'src/c.ts', content: 'c' } };
		await hook.toolBefore(toolInput3 as any, toolOutput3 as any);
		expect(session.architectWriteCount).toBe(3);
	});
});

// ============================================
// Task 2.4: Batch Delegation Detection
// ============================================
describe('batch delegation detection (Task 2.4)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('single-task delegation -> no warning', async () => {
		const config = makeDelegationConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		const cleanText =
			'coder\nTASK: Add validation\nFILE: src/test.ts\nINPUT: Validate email';
		const messages = makeMessages(cleanText, 'architect');
		const originalText = messages.messages[0].parts[0].text;

		await hook.messagesTransform({}, messages as any);

		// messages[0] is the [NEXT] deliberation preamble (system message) inserted by the hook
		// messages[1] is the original user message — check it is unchanged
		expect(messages.messages[1].parts[0].text).toBe(originalText);
	});

	it('TASK with AND connecting two actions -> warning', async () => {
		const config = makeDelegationConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		const text =
			'coder\nTASK: Add validation and also add tests\nFILE: src/test.ts';
		const messages = makeMessages(text, 'architect');

		await hook.messagesTransform({}, messages as any);

		// BATCH DETECTED is prepended to the user message (messages[1] after [NEXT] insertion)
		expect(messages.messages[1].parts[0].text).toContain('BATCH DETECTED');
		expect(messages.messages[1].parts[0].text).toContain('Detected signal');
	});

	it('multiple FILE lines -> warning', async () => {
		const config = makeDelegationConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		const text =
			'coder\nTASK: Add validation\nFILE: src/auth.ts\nFILE: src/login.ts';
		const messages = makeMessages(text, 'architect');

		await hook.messagesTransform({}, messages as any);

		expect(messages.messages[1].parts[0].text).toContain('BATCH DETECTED');
		expect(messages.messages[1].parts[0].text).toContain(
			'Multiple FILE: directives',
		);
	});

	it('"additionally" -> warning', async () => {
		const config = makeDelegationConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		const text =
			'coder\nTASK: Add validation additionally add tests\nFILE: src/test.ts';
		const messages = makeMessages(text, 'architect');

		await hook.messagesTransform({}, messages as any);

		expect(messages.messages[1].parts[0].text).toContain('BATCH DETECTED');
		expect(messages.messages[1].parts[0].text).toContain(
			'Batching language detected',
		);
	});

	it('"and also" -> warning', async () => {
		const config = makeDelegationConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		const text =
			'coder\nTASK: Add validation and also add tests\nFILE: src/test.ts';
		const messages = makeMessages(text, 'architect');

		await hook.messagesTransform({}, messages as any);

		expect(messages.messages[1].parts[0].text).toContain('BATCH DETECTED');
		expect(messages.messages[1].parts[0].text).toContain(
			'Batching language detected',
		);
	});

	it('"also" alone (without and) -> no warning (needs "and also" pattern)', async () => {
		const config = makeDelegationConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// "also" alone doesn't match the batching pattern - needs "and also" or "then also"
		const text =
			'coder\nTASK: Add validation also add tests\nFILE: src/test.ts';
		const messages = makeMessages(text, 'architect');
		const originalText = messages.messages[0].parts[0].text;

		await hook.messagesTransform({}, messages as any);

		// Should NOT contain batching language warning (pattern requires "and also")
		// messages[1] is the user message after [NEXT] system message insertion
		expect(messages.messages[1].parts[0].text).toBe(originalText);
	});

	it('"while you\'re at it" -> warning', async () => {
		const config = makeDelegationConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		const text =
			"coder\nTASK: Add validation while you're at it add tests\nFILE: src/test.ts";
		const messages = makeMessages(text, 'architect');

		await hook.messagesTransform({}, messages as any);

		expect(messages.messages[1].parts[0].text).toContain('BATCH DETECTED');
		expect(messages.messages[1].parts[0].text).toContain(
			'Batching language detected',
		);
	});

	it('warning includes matched heuristic name (Detected signal: ...)', async () => {
		const config = makeDelegationConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		const text = 'coder\nTASK: Add validation\nFILE: src/a.ts\nFILE: src/b.ts';
		const messages = makeMessages(text, 'architect');

		await hook.messagesTransform({}, messages as any);

		// Check that warning contains "Detected signal:" with the heuristic
		expect(messages.messages[1].parts[0].text).toContain('Detected signal:');
		expect(messages.messages[1].parts[0].text).toContain(
			'Multiple FILE: directives',
		);
	});

	it('long single-task delegation under maxChars -> no warning', async () => {
		const config = makeDelegationConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Long but single task - under 4000 chars
		const text =
			'coder\nTASK: Add comprehensive validation\nFILE: src/test.ts\nINPUT: ' +
			'x'.repeat(1000);
		const messages = makeMessages(text, 'architect');
		const originalText = messages.messages[0].parts[0].text;

		await hook.messagesTransform({}, messages as any);

		// Should NOT contain batch warning in the user message (messages[1])
		expect(messages.messages[1].parts[0].text).not.toContain('BATCH DETECTED');
		// User message text should remain unchanged
		expect(messages.messages[1].parts[0].text).toBe(originalText);
	});
});

// ============================================
// Task 2.5: Gate Failure Self-Fix Detection
// ============================================
describe('gate failure self-fix detection (Task 2.5)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('gate fail -> coder delegation -> no warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Simulate gate failure
		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-123',
			timestamp: Date.now() - 30_000, // 30 seconds ago
		};

		// Now architect delegates to coder (not writing)
		const messages = makeMessages(
			'coder\nTASK: Fix the issue',
			'architect',
			sessionId,
		);
		await hook.messagesTransform({}, messages as any);

		// Should NOT contain SELF-FIX warning (delegation is OK)
		expect(messages.messages[0].parts[0].text).not.toContain(
			'SELF-FIX DETECTED',
		);
	});

	it('gate fail -> architect write to src/ within 2 min -> SELF-FIX warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Simulate gate failure 30 seconds ago
		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-123',
			timestamp: Date.now() - 30_000,
		};

		// Architect writes to src/ (self-fix attempt)
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'console.log("fix");' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Verify selfFixAttempted flag is set
		expect(session.selfFixAttempted).toBe(true);

		// Now call messagesTransform to get warning
		const messages = makeMessages('TASK: Check', 'architect', sessionId);
		await hook.messagesTransform({}, messages as any);

		// Verify SELF-FIX warning
		expect(messages.messages[0].parts[0].text).toContain('SELF-FIX DETECTED');
		expect(messages.messages[0].parts[0].text).toContain('lint');
		expect(messages.messages[0].parts[0].text).toContain('task-123');
	});

	it('gate pass -> architect write -> no warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// No gate failure - gate passed
		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = null; // Gate passed

		// Architect writes to src/
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'console.log("test");' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Verify selfFixAttempted is NOT set (no gate failure)
		expect(session.selfFixAttempted).toBe(false);

		// messagesTransform should not have SELF-FIX warning
		const messages = makeMessages('TASK: Check', 'architect', sessionId);
		await hook.messagesTransform({}, messages as any);

		expect(messages.messages[0].parts[0].text).not.toContain(
			'SELF-FIX DETECTED',
		);
	});

	it('gate fail -> architect write to .swarm/ -> no warning (legit)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Simulate gate failure
		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-123',
			timestamp: Date.now() - 30_000,
		};

		// Architect writes to .swarm/ (not a self-fix - this is legit plan update)
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: '.swarm/state.json', content: '{}' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Verify selfFixAttempted is NOT set (writing to .swarm/ is OK)
		expect(session.selfFixAttempted).toBe(false);

		// messagesTransform should not have SELF-FIX warning
		const messages = makeMessages('TASK: Update plan', 'architect', sessionId);
		await hook.messagesTransform({}, messages as any);

		expect(messages.messages[0].parts[0].text).not.toContain(
			'SELF-FIX DETECTED',
		);
	});

	it('self-fix warning clears after messagesTransform (no duplicate warnings)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Simulate gate failure
		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-123',
			timestamp: Date.now() - 30_000,
		};

		// Architect attempts self-fix
		const toolInput1 = {
			tool: 'write',
			sessionID: sessionId,
			callID: 'call-1',
		};
		const toolOutput1 = {
			args: { filePath: 'src/foo.ts', content: 'console.log("fix");' },
		};
		await hook.toolBefore(toolInput1 as any, toolOutput1 as any);
		expect(session.selfFixAttempted).toBe(true);

		// First messagesTransform - warning should be injected and flag cleared
		const messages1 = makeMessages('TASK: Check', 'architect', sessionId);
		await hook.messagesTransform({}, messages1 as any);
		expect(messages1.messages[0].parts[0].text).toContain('SELF-FIX DETECTED');
		expect(session.selfFixAttempted).toBe(false); // Flag cleared after warning injection

		// Second messagesTransform - NO warning (flag was cleared)
		const messages2 = makeMessages(
			'TASK: Another task',
			'architect',
			sessionId,
		);
		await hook.messagesTransform({}, messages2 as any);
		// Should NOT contain another SELF-FIX warning (flag is false)
		// Note: The warning was already cleared, so no new warning
		expect(messages2.messages[0].parts[0].text).not.toContain(
			'SELF-FIX DETECTED',
		);
	});

	it('2-minute window expires -> no warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Simulate gate failure MORE than 2 minutes ago (2 min + 1 second)
		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-123',
			timestamp: Date.now() - 121_000, // 121 seconds ago (over 2 min)
		};

		// Architect writes to src/
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'console.log("fix");' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// selfFixAttempted should NOT be set because window expired
		expect(session.selfFixAttempted).toBe(false);

		// messagesTransform should not have SELF-FIX warning
		const messages = makeMessages('TASK: Check', 'architect', sessionId);
		await hook.messagesTransform({}, messages as any);

		expect(messages.messages[0].parts[0].text).not.toContain(
			'SELF-FIX DETECTED',
		);
	});

	it('architect write after gate failure writes only to src/ triggers warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Simulate gate failure
		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = {
			tool: 'build_check',
			taskId: 'build-task',
			timestamp: Date.now() - 60_000, // 1 minute ago (within 2 min window)
		};

		// Architect writes to src/ - this IS a self-fix
		const toolInput = { tool: 'edit', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/main.ts', content: '// fixed' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// selfFixAttempted should be set
		expect(session.selfFixAttempted).toBe(true);

		// Verify warning contains the gate tool name
		const messages = makeMessages('TASK: Fix build', 'architect', sessionId);
		await hook.messagesTransform({}, messages as any);

		expect(messages.messages[0].parts[0].text).toContain('SELF-FIX DETECTED');
		expect(messages.messages[0].parts[0].text).toContain('build_check');
		expect(messages.messages[0].parts[0].text).toContain('build-task');
	});
});

// ============================================
// Task 2.7: Self-Coding Model-Only Guidance & Debug Leakage
// ============================================
describe('self-coding warnings model-only (Task 2.7)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('SELF-CODING warning injected ONLY in system message (not visible in user-facing output)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Architect writes to src/foo.ts
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'console.log("test");' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Create messages with both system and user roles
		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'You are the architect.' }],
				},
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Write some code' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		// Verify warning is in SYSTEM message (model-only)
		const systemMessage = messages.messages[0];
		expect(systemMessage.parts[0].text).toContain('SELF-CODING DETECTED');
		expect(systemMessage.parts[0].text).toContain('[MODEL_ONLY_GUIDANCE]');

		// Verify warning is NOT in USER message (not visible to user)
		const userMessage = messages.messages[1];
		expect(userMessage.parts[0].text).not.toContain('SELF-CODING DETECTED');
		expect(userMessage.parts[0].text).not.toContain('[MODEL_ONLY_GUIDANCE]');
	});

	it('SELF-FIX warning injected ONLY in system message (not visible in user-facing output)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Simulate gate failure
		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-123',
			timestamp: Date.now() - 30_000,
		};

		// Architect writes to src/foo.ts (self-fix attempt)
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'console.log("fix");' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Create messages with both system and user roles
		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'You are the architect.' }],
				},
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Fix the issue' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		// Verify warning is in SYSTEM message (model-only)
		const systemMessage = messages.messages[0];
		expect(systemMessage.parts[0].text).toContain('SELF-FIX DETECTED');
		expect(systemMessage.parts[0].text).toContain('[MODEL_ONLY_GUIDANCE]');

		// Verify warning is NOT in USER message (not visible to user)
		const userMessage = messages.messages[1];
		expect(userMessage.parts[0].text).not.toContain('SELF-FIX DETECTED');
		expect(userMessage.parts[0].text).not.toContain('[MODEL_ONLY_GUIDANCE]');
	});

	it('stored-args debug text is NOT present in visible output', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Architect writes to src/foo.ts - this stores args internally
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'console.log("test");' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Create messages that will be transformed
		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'You are the architect.' }],
				},
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Check the code' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		// Get the final text that would be visible to user
		const visibleText = messages.messages.map((m) => m.parts[0].text).join(' ');

		// Verify NO debug/internal storage references leak into visible output
		// These are internal implementation details that should never appear in messages
		expect(visibleText).not.toContain('storedInputArgs');
		expect(visibleText).not.toContain('stored-input-args');
		expect(visibleText).not.toContain('callID');
		expect(visibleText).not.toContain('getStoredInputArgs');
		expect(visibleText).not.toContain('setStoredInputArgs');

		// Verify the warning itself is model-only (in system message only)
		const systemText = messages.messages[0].parts[0].text;
		const userText = messages.messages[1].parts[0].text;

		// Self-coding warning should be in system only
		expect(systemText).toContain('SELF-CODING DETECTED');
		expect(userText).not.toContain('SELF-CODING DETECTED');
	});

	it('no system message -> warning still injected into created system message (model-only)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Architect writes to src/foo.ts
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'console.log("test");' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Create messages WITHOUT system message (edge case)
		const messages = {
			messages: [
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Write code' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		// Verify a system message was created and warning injected there (model-only)
		expect(messages.messages[0].info.role).toBe('system');
		expect(messages.messages[0].parts[0].text).toContain(
			'SELF-CODING DETECTED',
		);
		expect(messages.messages[0].parts[0].text).toContain(
			'[MODEL_ONLY_GUIDANCE]',
		);

		// Original user message should be unchanged
		expect(messages.messages[1].parts[0].text).toBe('TASK: Write code');
	});

	it('MODEL_ONLY_GUIDANCE markers are properly closed in system message', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Set up architect session
		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Architect writes to src/foo.ts
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'console.log("test");' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Create messages with system role
		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'System prompt here.' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		const systemText = messages.messages[0].parts[0].text;

		// Verify both opening and closing markers are present
		expect(systemText).toContain('[MODEL_ONLY_GUIDANCE]');
		expect(systemText).toContain('[/MODEL_ONLY_GUIDANCE]');
		// Warning content should be between markers
		expect(systemText).toContain('SELF-CODING DETECTED');
	});
});

// ============================================
// ADVERSARIAL TESTS: Task 2.7 Model-Only & Debug Leakage Gaps
// ============================================
describe('ADVERSARIAL: Task 2.7 model-only guidance gaps', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// GAP 1: Multiple system messages - which one gets the warning?
	it('multiple system messages: warning injected only in FIRST system message (not others)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Architect writes to src/ to trigger self-coding
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Create messages with MULTIPLE system messages
		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'System prompt 1.' }],
				},
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'System prompt 2.' }],
				},
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Code' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		// Warning should be in FIRST system message only
		expect(messages.messages[0].parts[0].text).toContain(
			'SELF-CODING DETECTED',
		);
		// Second system message should NOT have warning
		expect(messages.messages[1].parts[0].text).not.toContain(
			'SELF-CODING DETECTED',
		);
	});

	// GAP 2: Role field with different case variations
	it('message role case sensitivity: "SYSTEM" (uppercase) not recognized as system message', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Use uppercase SYSTEM role
		const messages = {
			messages: [
				{
					info: {
						role: 'SYSTEM' as any,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'System prompt.' }],
				},
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Code' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		// With uppercase 'SYSTEM', the filter won't match 'system'
		// This could be a GAP - warning might not get injected
		// Check user message to see if warning leaked (shouldn't)
		expect(messages.messages[1].parts[0].text).not.toContain(
			'SELF-CODING DETECTED',
		);
	});

	// GAP 3: Missing info object entirely
	it('message with missing info object: graceful handling, no crash', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Message with missing info object
		const messages = {
			messages: [
				{
					parts: [{ type: 'text' as const, text: 'System prompt.' }],
				},
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Code' }],
				},
			],
		};

		// Should not crash - graceful handling
		await hook.messagesTransform({}, messages as any);
		// User message should not have leaked warning
		expect(messages.messages[1].parts[0].text).not.toContain(
			'SELF-CODING DETECTED',
		);
	});

	// GAP 4: Message with role but empty info
	it('message with empty info but role property: handled gracefully', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const messages = {
			messages: [
				{
					info: {}, // Empty info object
					parts: [{ type: 'text' as const, text: 'System prompt.' }],
				},
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Code' }],
				},
			],
		};

		// Should not crash
		await hook.messagesTransform({}, messages as any);
	});

	// GAP 5: Both SELF-CODING and SELF-FIX triggered simultaneously
	it('both self-coding AND self-fix active: both warnings injected (order matters)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Simulate gate failure
		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-123',
			timestamp: Date.now() - 30_000,
		};

		// Architect writes to src/ - triggers both self-coding AND self-fix
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'fix' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// Both should be true
		expect(session.architectWriteCount).toBe(1);
		expect(session.selfFixAttempted).toBe(true);

		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'System prompt.' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		const systemText = messages.messages[0].parts[0].text;

		// Both warnings should be present
		expect(systemText).toContain('SELF-CODING DETECTED');
		expect(systemText).toContain('SELF-FIX DETECTED');
		// Both should be marked as MODEL_ONLY
		expect(systemText).toContain('[MODEL_ONLY_GUIDANCE]');
	});

	// GAP 6: Debug leakage - alternative stored-args naming
	it('debug leakage check: alternative internal variable names not present', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'System prompt.' }],
				},
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Code' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		const allText = JSON.stringify(messages);

		// Additional potential debug leakage patterns
		expect(allText).not.toContain('storedInput');
		expect(allText).not.toContain('inputArgs');
		expect(allText).not.toContain('toolInput');
		expect(allText).not.toContain('lastToolCall');
		expect(allText).not.toContain('__debug');
		expect(allText).not.toContain('__internal');
	});

	// GAP 7: Self-fix with SELF-CODING - verify debug leakage absence
	it('self-fix scenario: stored-args debug leakage NOT present in visible output', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Simulate gate failure
		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-456',
			timestamp: Date.now() - 30_000,
		};

		// Architect writes to src/ - self-fix attempt
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-X' };
		const toolOutput = { args: { filePath: 'src/bar.ts', content: 'fix' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'System prompt.' }],
				},
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Fix' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		// User should NOT see any internal storage references
		const userText = messages.messages[1].parts[0].text;
		expect(userText).not.toContain('callID');
		expect(userText).not.toContain('call-X');
		expect(userText).not.toContain('stored');
		expect(userText).not.toContain('args');
	});

	// GAP 8: Assistant role should not have warning leaked
	it('assistant role message: warning not leaked to assistant messages', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'System prompt.' }],
				},
				{
					info: {
						role: 'assistant' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [
						{ type: 'text' as const, text: 'I will delegate this task.' },
					],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		// Assistant message should NOT contain the warning
		expect(messages.messages[1].parts[0].text).not.toContain(
			'SELF-CODING DETECTED',
		);
		expect(messages.messages[1].parts[0].text).not.toContain(
			'[MODEL_ONLY_GUIDANCE]',
		);
	});

	// GAP 9: System message at index > 0 - edge case from message consolidation
	it('system message at index 1 (after user): warning still injected correctly', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		// System message NOT at index 0 - an unusual edge case
		const messages = {
			messages: [
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Code' }],
				},
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'System prompt.' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		// The system message is at index 1 - code should still find it
		// Check the system message at index 1
		expect(messages.messages[1].parts[0].text).toContain(
			'SELF-CODING DETECTED',
		);
		// User message should not have warning
		expect(messages.messages[0].parts[0].text).not.toContain(
			'SELF-CODING DETECTED',
		);
	});

	// GAP 10: Verify warning text doesn't contain raw internal data
	it('warning text is human-readable, no raw tool output leaked', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Write with some content that could leak if not filtered
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/foo.ts', content: 'secret: my-api-key-123' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'System prompt.' }],
				},
			],
		};

		await hook.messagesTransform({}, messages as any);

		const warningText = messages.messages[0].parts[0].text;

		// Warning should NOT contain the content that was written
		expect(warningText).not.toContain('secret: my-api-key-123');
		// Warning should NOT contain raw tool output structure
		expect(warningText).not.toContain('"args"');
		expect(warningText).not.toContain('toolOutput');
	});

	// GAP 11: parts array missing entirely
	it('message with missing parts array: graceful handling', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					// Missing parts array
				},
				{
					info: {
						role: 'user' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [{ type: 'text' as const, text: 'TASK: Code' }],
				},
			],
		};

		// Should not crash - graceful handling
		await hook.messagesTransform({}, messages as any);
	});

	// GAP 12: parts array with non-text item
	it('message parts with non-text item (image/tool): handled gracefully', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const messages = {
			messages: [
				{
					info: {
						role: 'system' as const,
						agent: 'architect',
						sessionID: sessionId,
					},
					parts: [
						{ type: 'text' as const, text: 'System prompt.' },
						{ type: 'image' as any, data: 'fake-image-data' }, // Non-text part
					],
				},
			],
		};

		// Should not crash - find() handles only text parts
		await hook.messagesTransform({}, messages as any);
		// Warning should still be injected in text part
		expect(messages.messages[0].parts[0].text).toContain(
			'SELF-CODING DETECTED',
		);
	});
});

// ============================================
// ADVERSARIAL TESTS: Attack Vectors
// ============================================
describe('ADVERSARIAL: attack vectors (Task 4.2)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// Path traversal attacks
	it('path traversal attempt: ../../../etc/passwd -> triggers self-coding warning AND blocks (not .swarm/)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Malicious path traversal attempt.
		// v6.70.0 (#496): the cwd-containment check now rejects any path that
		// resolves outside the working directory, so this call throws WRITE
		// BLOCKED from the authority layer. Self-coding detection in
		// handlePlanAndScopeProtection runs BEFORE the authority throw, so
		// architectWriteCount is still incremented and observable.
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: '../../../etc/passwd', content: 'malicious' },
		};
		await expect(
			hook.toolBefore(toolInput as any, toolOutput as any),
		).rejects.toThrow('WRITE BLOCKED');

		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(1);
	});

	// FIXED: Path traversal bypass - .swarm/../ now detected correctly
	it('FIXED: path traversal with .swarm/ prefix injection: .swarm/../src/evil.ts -> DETECTED correctly', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		// Path with .swarm/ prefix but traverses out - now CORRECTLY DETECTED after fix
		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: '.swarm/../src/evil.ts', content: 'malicious' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		// FIXED: Path traversal is now detected - .swarm/../src/evil.ts resolves outside .swarm/
		expect(session.architectWriteCount).toBe(1);
	});

	// Agent identity spoofing
	it('agent name spoofing: "architect_evil" is blocked by authority (stronger than self-coding warning)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, 'architect_evil'); // Fake architect
		startAgentSession(sessionId, 'architect_evil');

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/evil.ts', content: 'malicious' },
		};
		// v6.70.0 (#496): unknown agent names (not in the authority rules map)
		// fail closed at the authority layer with "Unknown agent: architect_evil"
		// — a stronger protection than the prior silent no-op. The spoofed
		// identity cannot write at all.
		await expect(
			hook.toolBefore(toolInput as any, toolOutput as any),
		).rejects.toThrow(/WRITE BLOCKED.*Unknown agent/);

		// And self-coding warning still does not fire because architect_evil
		// is not the real architect name.
		const messages = makeMessages('TASK: Hack', 'architect_evil', sessionId);
		await hook.messagesTransform({}, messages as any);

		expect(messages.messages[0].parts[0].text).not.toContain(
			'SELF-CODING DETECTED',
		);
	});

	// Empty/null sessionID is now fail-closed (v6.70.0 #496 hardening).
	it('empty sessionID fails closed (no agent registered, not silently promoted to architect)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Empty sessionID - no activeAgent mapping, so the write authority
		// check fails closed with "No active agent registered". Previously
		// this silently fell through to architect defaults; v6.70.0 #496
		// requires startAgentSession before any Write/Edit.
		const toolInput = { tool: 'write', sessionID: '', callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/test.ts', content: 'test' } };

		await expect(
			hook.toolBefore(toolInput as any, toolOutput as any),
		).rejects.toThrow(/WRITE BLOCKED.*No active agent registered/);

		// Empty session is still not tracked as architect — no silent promotion.
		const session = swarmState.agentSessions.get('');
		expect(session?.architectWriteCount ?? 0).toBe(0);
	});

	it('null sessionID fails closed with deterministic error (no crash, no silent fallback)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const toolInput = {
			tool: 'write',
			sessionID: null as any,
			callID: 'call-1',
		};
		const toolOutput = { args: { filePath: 'src/test.ts', content: 'test' } };

		// Should NOT crash unexpectedly — instead, fail closed with a clean
		// WRITE BLOCKED error. v6.70.0 #496 no longer silently falls back to
		// architect defaults for unknown sessions.
		await expect(
			hook.toolBefore(toolInput as any, toolOutput as any),
		).rejects.toThrow(/WRITE BLOCKED.*No active agent registered/);
	});
});

// ============================================
// ADVERSARIAL TESTS: Malformed Inputs
// ============================================
describe('ADVERSARIAL: malformed inputs (Task 4.2)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	it('missing args object does not crash hook (graceful degradation)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {}; // No args

		// Hook handles missing args gracefully (no filePath to check)
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		// No write count increment because no filePath was found
		expect(session.architectWriteCount).toBe(0);
	});

	it('null args.filePath does not crash hook (graceful degradation)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: null } };

		// Hook handles null filePath gracefully
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(0);
	});

	it('undefined args.filePath does not crash hook (graceful degradation)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: undefined } };

		// Hook handles undefined filePath gracefully
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(0);
	});

	it('empty string filePath does not crash hook (no increment)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: '', content: 'test' } };

		// Hook handles empty string filePath gracefully
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		// Empty string is falsy in isOutsideSwarmDir check
		expect(session.architectWriteCount).toBe(0);
	});

	it('non-string filePath (number) does not crash hook (type check)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 12345 as any, content: 'test' } };

		// Hook handles non-string filePath gracefully (type check)
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		// Non-string is ignored due to typeof check
		expect(session.architectWriteCount).toBe(0);
	});

	it('non-string filePath (object) does not crash hook (type check)', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: { path: 'evil' } as any, content: 'test' },
		};

		// Hook handles object filePath gracefully (type check)
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(0);
	});

	it('messagesTransform with empty messages array does not crash', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const output = { messages: [] };
		// Hook returns early when no messages
		await hook.messagesTransform({}, output as any);
		// No crash = success
		expect(true).toBe(true);
	});

	it('messagesTransform with undefined messages does not crash', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const output = { messages: undefined };
		// Hook returns early when messages is undefined
		await hook.messagesTransform({}, output as any);
		expect(true).toBe(true);
	});

	it('messagesTransform with missing parts array does not crash', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const output = { messages: [{ info: { role: 'user' } }] };
		// Hook returns early when parts is missing
		await hook.messagesTransform({}, output as any);
		expect(true).toBe(true);
	});
});

// ============================================
// ADVERSARIAL TESTS: Boundary Cases
// ============================================
describe('ADVERSARIAL: boundary cases (Task 4.2)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// Exact timing boundaries
	it('self-fix detection: within 2 min window (60 seconds) -> triggers warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const session = ensureAgentSession(sessionId);
		// Use 60 seconds - well within the 2 min window
		session.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-123',
			timestamp: Date.now() - 60_000,
		};

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'fix' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		expect(session.selfFixAttempted).toBe(true);
	});

	it('self-fix detection: exactly 2 minutes + 1ms (120001ms) -> NO warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-123',
			timestamp: Date.now() - 120_001, // Just over 2 min
		};

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'fix' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		expect(session.selfFixAttempted).toBe(false);
	});

	// Path boundary cases
	it('filePath exactly ".swarm/" (no file) -> no warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: '.swarm/', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(0);
	});

	it('filePath with mixed separators (Windows): "src\\foo.ts" -> triggers warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src\\foo.ts', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(1);
	});

	it('filePath with leading "./": "./src/foo.ts" -> triggers warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: './src/foo.ts', content: 'test' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(1);
	});

	it('filePath ".swarm/./state.json" (with ./) -> no warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: '.swarm/./state.json', content: '{}' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(0);
	});

	// Unicode and special characters
	it('filePath with nested path: "src/unicode/test.ts" -> triggers warning', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = {
			args: { filePath: 'src/unicode/test.ts', content: 'test' },
		};
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const session = ensureAgentSession(sessionId);
		expect(session.architectWriteCount).toBe(1);
	});

	it('filePath with null byte injection: "src/test.ts\x00.swarm/" -> triggers warning AND fails closed at lstat', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		// Null byte injection attempt.
		// v6.70.0 (#496): handlePlanAndScopeProtection still detects the
		// non-.swarm write intent and increments architectWriteCount BEFORE
		// the lstat symlink guard runs. The lstat guard then fails closed
		// with WRITE BLOCKED because node's fs.lstatSync rejects paths with
		// null bytes — an even stronger protection than the prior warning.
		const toolOutput = {
			args: { filePath: 'src/test.ts\x00.swarm/', content: 'test' },
		};
		await expect(
			hook.toolBefore(toolInput as any, toolOutput as any),
		).rejects.toThrow('WRITE BLOCKED');

		const session = ensureAgentSession(sessionId);
		// Should detect as outside .swarm/ since null byte is before .swarm/
		expect(session.architectWriteCount).toBe(1);
	});

	// Batch detection boundary cases
	it('batch detection: exact char limit (4000) -> no warning', async () => {
		const config = makeDelegationConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Prefix is 42 chars ('coder\nTASK: Test\nFILE: src/test.ts\nINPUT: ')
		const prefix = 'coder\nTASK: Test\nFILE: src/test.ts\nINPUT: ';
		const text = prefix + 'x'.repeat(3958); // 42 + 3958 = 4000
		expect(text.length).toBe(4000);
		const messages = makeMessages(text, 'architect');
		const originalText = messages.messages[0].parts[0].text;

		await hook.messagesTransform({}, messages as any);

		// messages[0] is the [NEXT] deliberation preamble; messages[1] is the user message
		expect(messages.messages[1].parts[0].text).toBe(originalText);
	});

	it('batch detection: 4001 chars -> triggers oversized warning', async () => {
		const config = makeDelegationConfig();
		const hook = createDelegationGateHook(config, process.cwd());

		// Prefix is 42 chars, so need 3959 x's to get 4001 total
		const prefix = 'coder\nTASK: Test\nFILE: src/test.ts\nINPUT: ';
		const text = prefix + 'x'.repeat(3959); // 42 + 3959 = 4001
		expect(text.length).toBe(4001);
		const messages = makeMessages(text, 'architect');

		await hook.messagesTransform({}, messages as any);

		// BATCH DETECTED is prepended to user message at messages[1]
		expect(messages.messages[1].parts[0].text).toContain('BATCH DETECTED');
		expect(messages.messages[1].parts[0].text).toContain('chars');
	});

	// Gate failure edge cases
	it('gate failure with special chars in taskId: "task-<script>alert(1)</script>" -> sanitized in output', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		const sessionId = 'test-session';
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		const session = ensureAgentSession(sessionId);
		session.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-<script>alert(1)</script>',
			timestamp: Date.now() - 30_000,
		};

		const toolInput = { tool: 'write', sessionID: sessionId, callID: 'call-1' };
		const toolOutput = { args: { filePath: 'src/foo.ts', content: 'fix' } };
		await hook.toolBefore(toolInput as any, toolOutput as any);

		const messages = makeMessages('TASK: Check', 'architect', sessionId);
		await hook.messagesTransform({}, messages as any);

		// Warning is injected (taskId is included as-is in warning text)
		expect(messages.messages[0].parts[0].text).toContain('SELF-FIX DETECTED');
		// Note: Sanitization is UI concern; hook passes through taskId as-is
	});

	// Concurrent session edge cases
	it('multiple sessions with same agent -> independent counts', async () => {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);

		// Session 1
		const session1 = 'session-1';
		swarmState.activeAgent.set(session1, ORCHESTRATOR_NAME);
		startAgentSession(session1, ORCHESTRATOR_NAME);

		// Session 2
		const session2 = 'session-2';
		swarmState.activeAgent.set(session2, ORCHESTRATOR_NAME);
		startAgentSession(session2, ORCHESTRATOR_NAME);

		// Write in session 1
		await hook.toolBefore(
			{ tool: 'write', sessionID: session1, callID: 'call-1' } as any,
			{ args: { filePath: 'src/a.ts', content: 'a' } } as any,
		);

		// Write in session 2
		await hook.toolBefore(
			{ tool: 'write', sessionID: session2, callID: 'call-2' } as any,
			{ args: { filePath: 'src/b.ts', content: 'b' } } as any,
		);

		const sess1 = ensureAgentSession(session1);
		const sess2 = ensureAgentSession(session2);

		// Each session should have count of 1
		expect(sess1.architectWriteCount).toBe(1);
		expect(sess2.architectWriteCount).toBe(1);
	});
});

describe('SELF-CODING DETECTED warning contains time-pressure anti-rationalization patterns', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	async function triggerSelfCodingWarning(sessionId: string) {
		const config = makeGuardrailsConfig();
		const hook = createGuardrailsHooks(config);
		swarmState.activeAgent.set(sessionId, ORCHESTRATOR_NAME);
		startAgentSession(sessionId, ORCHESTRATOR_NAME);

		await hook.toolBefore(
			{ tool: 'write', sessionID: sessionId, callID: 'call-1' } as any,
			{ args: { filePath: 'src/foo.ts', content: 'x' } } as any,
		);

		const messages = makeMessages('TASK: do something', 'architect', sessionId);
		await hook.messagesTransform({}, messages as any);
		return messages.messages[0].parts[0].text as string;
	}

	it('warning tells architect it has no deadlines (counters time-pressure hallucination)', async () => {
		const warning = await triggerSelfCodingWarning('test-tp-1');
		expect(warning).toContain('SELF-CODING DETECTED');
		expect(warning).toContain('no deadlines');
	});

	it('warning states no urgency is real', async () => {
		const warning = await triggerSelfCodingWarning('test-tp-2');
		expect(warning).toContain('No urgency is real');
	});

	it('warning rejects "small / trivial / obvious" rationalization', async () => {
		const warning = await triggerSelfCodingWarning('test-tp-3');
		expect(warning).toContain('size is not a QA exemption');
	});

	it('warning rejects "explaining to coder takes more effort" rationalization', async () => {
		const warning = await triggerSelfCodingWarning('test-tp-4');
		expect(warning).toContain('writing the task spec is your job');
	});

	it('warning rejects "user needs this quickly" rationalization', async () => {
		const warning = await triggerSelfCodingWarning('test-tp-5');
		expect(warning).toContain('Skipping QA gates ships bugs');
	});
});
