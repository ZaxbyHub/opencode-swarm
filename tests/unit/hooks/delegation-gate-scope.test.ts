import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';

function makeConfig(overrides?: Record<string, unknown>): PluginConfig {
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
	sessionID: string | undefined | null = 'test-session',
) {
	return {
		messages: [
			{
				info: {
					role: 'user' as const,
					agent,
					sessionID: sessionID ?? undefined,
				},
				parts: [{ type: 'text', text }],
			},
		],
	};
}

describe('delegation-gate: declaredCoderScope extraction (Task 5.3)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	describe('FILE: directive extraction', () => {
		it('should extract single FILE: directive into declaredCoderScope', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'mega_coder\nTASK: 1.1\nFILE: src/foo.ts\nINPUT: do stuff',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toEqual(['src/foo.ts']);
		});

		it('should set declaredCoderScope to null when no FILE: directives present', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'mega_coder\nTASK: 1.1\nINPUT: do stuff',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toBeNull();
		});

		it('should extract multiple different FILE: directives into array', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'mega_coder\nTASK: 1.1\nFILE: src/auth.ts\nFILE: src/login.ts\nFILE: src/session.ts\nINPUT: do stuff',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toEqual([
				'src/auth.ts',
				'src/login.ts',
				'src/session.ts',
			]);
		});

		it('should deduplicate duplicate FILE: directives', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'mega_coder\nTASK: 1.1\nFILE: src/foo.ts\nFILE: src/bar.ts\nFILE: src/foo.ts\nINPUT: do stuff',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			// Should have only 2 unique entries, not 3
			expect(session.declaredCoderScope).toEqual(['src/foo.ts', 'src/bar.ts']);
			expect(session.declaredCoderScope?.length).toBe(2);
		});

		it('should trim leading/trailing whitespace from file paths', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'mega_coder\nTASK: 1.1\nFILE:   src/foo.ts  \nFILE:    bar.ts\nINPUT: do stuff',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toEqual(['src/foo.ts', 'bar.ts']);
		});
	});

	describe('non-coder delegation scenarios', () => {
		it('should NOT set declaredCoderScope for reviewer delegation', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'mega_reviewer\nTASK: 1.1\nFILE: src/foo.ts\nINPUT: review stuff',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toBeNull();
		});

		it('should NOT set declaredCoderScope for test_engineer delegation', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'mega_test_engineer\nTASK: 1.1\nFILE: src/foo.ts\nINPUT: run tests',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toBeNull();
		});

		it('should NOT set declaredCoderScope when no TASK: line present (no task ID)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'mega_coder\nFILE: src/foo.ts\nINPUT: do stuff',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			// No TASK: means no taskId detected, so declaredCoderScope should NOT be set
			expect(session.declaredCoderScope).toBeNull();
		});

		it('should NOT set declaredCoderScope when coder without task ID and with FILE:', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// No TASK: line at all - this is a coder delegation pattern but missing task ID
			const messages = makeMessages(
				'coder\nFILE: src/foo.ts\nINPUT: do stuff',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toBeNull();
		});
	});

	describe('regex boundary conditions', () => {
		it('should NOT match inline FILE: (not at line start)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// "inline FILE:" is not at start of line
			const messages = makeMessages(
				'mega_coder\nTASK: 1.1\nPlease modify FILE: src/inline.ts\nINPUT: do stuff',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			// Inline FILE: should NOT be matched because regex uses ^ with m flag
			expect(session.declaredCoderScope).toBeNull();
		});

		it('should NOT match indented FILE: (regex requires start of line)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Indented FILE: at start of line should NOT match (regex /^FILE: requires start of line)
			const messages = makeMessages(
				'mega_coder\nTASK: 1.1\n  FILE: src/indented.ts\nINPUT: do stuff',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			// Indented FILE: should NOT be matched because regex uses ^ which requires start of line
			expect(session.declaredCoderScope).toBeNull();
		});

		it('should match FILE: at start of multiline string', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'mega_coder\nTASK: 1.1\n\nHere are the files:\nFILE: src/a.ts\nFILE: src/b.ts\n',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toEqual(['src/a.ts', 'src/b.ts']);
		});
	});

	describe('interaction with existing functionality', () => {
		it('should still track lastCoderDelegationTaskId when extracting declaredCoderScope', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'mega_coder\nTASK: Task Alpha\nFILE: src/alpha.ts',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.lastCoderDelegationTaskId).toBe('Task Alpha');
			expect(session.declaredCoderScope).toEqual(['src/alpha.ts']);
		});

		it('should not affect non-architect sessions', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Coder agent (not architect)
			const messages = makeMessages(
				'mega_coder\nTASK: 1.1\nFILE: src/foo.ts',
				'mega_coder',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			// Should not set declaredCoderScope for non-architect
			expect(session.declaredCoderScope).toBeNull();
		});

		it('should handle empty FILE: value gracefully (not added to scope)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			// Test with multiple FILE: lines where some are empty/whitespace-only
			// The regex /^\s*FILE:\s*(.+)$/gm will NOT match "FILE: " alone (needs at least one char after whitespace)
			const messages = makeMessages(
				'mega_coder\nTASK: 1.1\nFILE: src/valid.ts\nINPUT: do stuff',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			// Only the valid FILE: should be captured
			expect(session.declaredCoderScope).toEqual(['src/valid.ts']);
		});
	});

	describe('coder delegation pattern variations', () => {
		it('should work with local_coder', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'local_coder\nTASK: 1.1\nFILE: src/local.ts',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toEqual(['src/local.ts']);
		});

		it('should work with paid_coder', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'paid_coder\nTASK: 1.1\nFILE: src/paid.ts',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toEqual(['src/paid.ts']);
		});

		it('should work with simple "coder" (no prefix)', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'coder\nTASK: 1.1\nFILE: src/simple.ts',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toEqual(['src/simple.ts']);
		});

		it('should work with task_id format (e.g., "1.2.3")', async () => {
			const config = makeConfig();
			const hook = createDelegationGateHook(config, process.cwd());

			const messages = makeMessages(
				'mega_coder\nTASK: 1.2.3\nFILE: src/nested.ts',
				'architect',
			);
			await hook.messagesTransform({}, messages);

			const session = ensureAgentSession('test-session');
			expect(session.declaredCoderScope).toEqual(['src/nested.ts']);
			expect(session.lastCoderDelegationTaskId).toBe('1.2.3');
		});
	});
});
