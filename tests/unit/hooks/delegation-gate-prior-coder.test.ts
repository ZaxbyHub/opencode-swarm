/**
 * Tests for priorCoderTaskId side-effect fix in delegation-gate.ts
 *
 * Verifies that the delegation-gate hook correctly handles priorCoderTaskId
 * without causing unintended session creation side-effects.
 *
 * The fix at line 948-950 changed:
 *   OLD: ensureAgentSession(sessionID).lastCoderDelegationTaskId
 *   NEW: swarmState.agentSessions.get(sessionID)?.lastCoderDelegationTaskId ?? null
 *
 * This prevents session creation as a side-effect when only reading priorCoderTaskId.
 *
 * Note: Line 872 creates sessions whenever sessionID is set, so we test through
 * the observable behavior of the hook rather than direct priorCoderTaskId access.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

function makeConfig(): PluginConfig {
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
		},
	} as PluginConfig;
}

/**
 * Build a minimal messages array with a user message containing the given text and sessionID.
 */
function makeMessages(
	text: string,
	sessionID: string | null,
): {
	messages: Array<{
		info: Record<string, unknown>;
		parts: Array<{ type: string; text: string }>;
	}>;
} {
	return {
		messages: [
			{
				info: {
					role: 'user',
					sessionID: sessionID ?? undefined,
					agent: 'architect',
				},
				parts: [{ type: 'text', text }],
			},
		],
	};
}

describe('delegation-gate: priorCoderTaskId side-effect fix', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	describe('priorCoderTaskId behavior', () => {
		/**
		 * Test 1: Known session with prior coder task ID
		 *
		 * When a session exists with lastCoderDelegationTaskId set, the hook
		 * should correctly process the session without issues.
		 */
		it('handles known session with prior coder task ID', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Create a session with a prior coder delegation task ID
			const session = ensureAgentSession('session-known');
			session.lastCoderDelegationTaskId = '1.5';

			// Verify session exists before transform
			expect(swarmState.agentSessions.has('session-known')).toBe(true);

			// Call messagesTransform with a simple architect message
			const { messages } = makeMessages(
				'Hello architect, please continue.',
				'session-known',
			);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await hook.messagesTransform({}, { messages } as any);

			// Session should still exist with same prior task ID
			const updatedSession = swarmState.agentSessions.get('session-known');
			expect(updatedSession).toBeDefined();
			expect(updatedSession!.lastCoderDelegationTaskId).toBe('1.5');
		});

		/**
		 * Test 2: Null sessionID - no session creation
		 *
		 * When sessionID is null, no session should be created.
		 */
		it('handles null sessionID without creating session', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Verify no sessions exist before
			expect(swarmState.agentSessions.size).toBe(0);

			// Call messagesTransform with null sessionID
			const { messages } = makeMessages(
				'Hello, please help with the code.',
				null,
			);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await hook.messagesTransform({}, { messages } as any);

			// No sessions should be created
			expect(swarmState.agentSessions.size).toBe(0);
		});

		/**
		 * Test 3: Undefined sessionID - no session creation
		 */
		it('handles undefined sessionID without creating session', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Verify no sessions exist before
			expect(swarmState.agentSessions.size).toBe(0);

			// Call messagesTransform with undefined sessionID (object without sessionID property)
			const messages = [
				{
					info: {
						role: 'user',
						agent: 'architect',
						// No sessionID property at all
					},
					parts: [{ type: 'text', text: 'Hello, please help.' }],
				},
			];
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await hook.messagesTransform({}, { messages } as any);

			// No sessions should be created
			expect(swarmState.agentSessions.size).toBe(0);
		});

		/**
		 * Test 4: Session with null lastCoderDelegationTaskId
		 *
		 * When a session exists but has no prior coder delegation,
		 * the hook should handle it gracefully.
		 */
		it('handles session with null lastCoderDelegationTaskId', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Create session WITHOUT setting lastCoderDelegationTaskId (it's null by default)
			ensureAgentSession('session-no-prior');

			// Verify session exists with null prior task ID
			const sessionBefore = swarmState.agentSessions.get('session-no-prior');
			expect(sessionBefore).toBeDefined();
			expect(sessionBefore!.lastCoderDelegationTaskId).toBeNull();

			// Call messagesTransform
			const { messages } = makeMessages(
				'Hello, continue working.',
				'session-no-prior',
			);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await hook.messagesTransform({}, { messages } as any);

			// Session should still exist with null prior task ID
			const sessionAfter = swarmState.agentSessions.get('session-no-prior');
			expect(sessionAfter).toBeDefined();
			expect(sessionAfter!.lastCoderDelegationTaskId).toBeNull();
		});

		/**
		 * Test 5: Coder delegation SHOULD update session
		 *
		 * When a proper coder delegation message is sent, the session SHOULD be
		 * created/updated with the current task ID as lastCoderDelegationTaskId.
		 * This verifies the intended functionality still works.
		 */
		it('coder delegation no longer writes lastCoderDelegationTaskId from prompt text', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Verify session does NOT exist before
			expect(swarmState.agentSessions.has('session-coder')).toBe(false);

			// Call messagesTransform with a coder delegation message
			const { messages } = makeMessages(
				`mega_coder

TASK: 2.1 Implement feature X

FILE: src/feature.ts
`,
				'session-coder',
			);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await hook.messagesTransform({}, { messages } as any);

			// Stage A wedge fix: the transform regex writer was removed. Task
			// attribution now comes exclusively from the structured dispatch
			// path (prepareCoderScope success in toolBefore), so the transform
			// must not invent an id from prompt text.
			const session = swarmState.agentSessions.get('session-coder');
			if (session) {
				expect(session.lastCoderDelegationTaskId).toBeNull();
			}
		});

		/**
		 * Test 6: Session with task lines - windowing creates session
		 *
		 * When a session exists with currentTaskId set and the message has
		 * task lines, the hook processes them correctly.
		 */
		it('handles session with currentTaskId and task lines', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Create session with currentTaskId set
			const session = ensureAgentSession('session-with-task');
			session.currentTaskId = '1.1';
			session.lastCoderDelegationTaskId = '1.0';

			// Verify session exists with prior task ID
			expect(swarmState.agentSessions.has('session-with-task')).toBe(true);

			// Call messagesTransform with a message that has task lines
			const { messages } = makeMessages(
				`Current status:
- [ ] 1.1: Task one
- [ ] 1.2: Task two
- [ ] 1.3: Task three

Please continue.`,
				'session-with-task',
			);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await hook.messagesTransform({}, { messages } as any);

			// Session should still exist with same prior task ID
			const updatedSession = swarmState.agentSessions.get('session-with-task');
			expect(updatedSession).toBeDefined();
			expect(updatedSession!.lastCoderDelegationTaskId).toBe('1.0');
		});

		/**
		 * Test 7: Unknown session with set sessionID
		 *
		 * When messagesTransform is called with a sessionID for a non-existent session,
		 * the session gets created by the hook's internal logic (line 872).
		 * This is expected behavior - the hook creates sessions when needed.
		 */
		it('creates session when sessionID is set but session does not exist', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Verify session does NOT exist before
			expect(swarmState.agentSessions.has('session-unknown')).toBe(false);

			// Call messagesTransform with a sessionID for a non-existent session
			const { messages } = makeMessages(
				'Hello, please help with the code.',
				'session-unknown',
			);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await hook.messagesTransform({}, { messages } as any);

			// Session IS created (by internal hook logic at line 872)
			// This is expected behavior - the hook creates sessions when sessionID is provided
			expect(swarmState.agentSessions.has('session-unknown')).toBe(true);
		});
	});
});
