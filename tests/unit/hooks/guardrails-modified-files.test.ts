import { beforeEach, describe, expect, it } from 'bun:test';
import { ORCHESTRATOR_NAME } from '../../../src/config/constants';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
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

function makeOutput(args: unknown = { filePath: '/test.ts' }) {
	return { args };
}

describe('guardrails modifiedFilesThisCoderTask tracking (Task 5.2)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	describe('basic tracking - delegationActive=true', () => {
		it('write tool with filePath → tracks path in modifiedFilesThisCoderTask', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			// Start as architect but set delegationActive=true to simulate coder subagent
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			// Enable delegation to simulate coder subagent
			const session = getAgentSession('test-session');
			session!.delegationActive = true;

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'src/foo.ts' });

			await hooks.toolBefore(input, output);

			expect(session?.modifiedFilesThisCoderTask).toContain('src/foo.ts');
		});

		it('same path added twice → only one entry (dedup)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = true;

			// Add same path twice
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'src/foo.ts' }),
			);
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-2'),
				makeOutput({ filePath: 'src/foo.ts' }),
			);

			// Should only have one entry
			const files = session?.modifiedFilesThisCoderTask ?? [];
			expect(files.filter((f) => f === 'src/foo.ts').length).toBe(1);
		});

		it('non-write tool (bash) → modifiedFilesThisCoderTask unchanged', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = true;

			// Call bash tool (not a write tool)
			await hooks.toolBefore(
				makeInput('test-session', 'bash', 'call-1'),
				makeOutput({ cmd: 'echo hello' }),
			);

			// Should be empty since no write tools were called
			expect(session?.modifiedFilesThisCoderTask?.length ?? 0).toBe(0);
		});
	});

	describe('path extraction from different arg fields', () => {
		it('args.path works for path extraction', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = true;

			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ path: 'src/using-path.ts' }),
			);

			expect(session?.modifiedFilesThisCoderTask).toContain(
				'src/using-path.ts',
			);
		});

		it('args.file works for path extraction', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = true;

			await hooks.toolBefore(
				makeInput('test-session', 'edit', 'call-1'),
				makeOutput({ file: 'src/using-file.ts' }),
			);

			expect(session?.modifiedFilesThisCoderTask).toContain(
				'src/using-file.ts',
			);
		});

		it('args.target works for path extraction', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = true;

			await hooks.toolBefore(
				makeInput('test-session', 'replace', 'call-1'),
				makeOutput({ target: 'src/using-target.ts' }),
			);

			expect(session?.modifiedFilesThisCoderTask).toContain(
				'src/using-target.ts',
			);
		});
	});

	describe('architect coder dispatch reset', () => {
		it('architect dispatches Task with subagent_type=coder → resets modifiedFilesThisCoderTask to []', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			// Start as architect
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');

			// Pre-populate modifiedFilesThisCoderTask (simulating prior coder activity)
			session!.modifiedFilesThisCoderTask = ['src/old1.ts', 'src/old2.ts'];

			// Architect dispatches a Task with subagent_type='coder'
			await hooks.toolBefore(
				makeInput('test-session', 'Task', 'call-1'),
				makeOutput({ subagent_type: 'coder', task: 'Implement feature X' }),
			);

			// Should be reset to empty array
			expect(session?.modifiedFilesThisCoderTask?.length ?? 0).toBe(0);
		});

		it('Task with subagent_type=reviewer → does NOT reset', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.modifiedFilesThisCoderTask = ['src/old.ts'];

			// Architect dispatches reviewer (not coder)
			await hooks.toolBefore(
				makeInput('test-session', 'Task', 'call-1'),
				makeOutput({ subagent_type: 'reviewer', task: 'Review code' }),
			);

			// Should NOT be reset
			expect(session?.modifiedFilesThisCoderTask).toContain('src/old.ts');
			expect(session?.modifiedFilesThisCoderTask?.length).toBe(1);
		});

		it('Task with subagent_type=test_engineer → does NOT reset', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.modifiedFilesThisCoderTask = ['src/old.ts'];

			// Architect dispatches test_engineer (not coder)
			await hooks.toolBefore(
				makeInput('test-session', 'Task', 'call-1'),
				makeOutput({ subagent_type: 'test_engineer', task: 'Run tests' }),
			);

			// Should NOT be reset
			expect(session?.modifiedFilesThisCoderTask).toContain('src/old.ts');
			expect(session?.modifiedFilesThisCoderTask?.length).toBe(1);
		});

		it('Task with no subagent_type → does NOT reset', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.modifiedFilesThisCoderTask = ['src/old.ts'];

			// Task without subagent_type
			await hooks.toolBefore(
				makeInput('test-session', 'Task', 'call-1'),
				makeOutput({ task: 'Some task' }),
			);

			// Should NOT be reset
			expect(session?.modifiedFilesThisCoderTask).toContain('src/old.ts');
			expect(session?.modifiedFilesThisCoderTask?.length).toBe(1);
		});
	});

	describe('accumulation and reset flow', () => {
		it('tracking accumulates across multiple write-tool calls within one delegation', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = true;

			// Multiple writes within the same delegation
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'src/a.ts' }),
			);
			await hooks.toolBefore(
				makeInput('test-session', 'edit', 'call-2'),
				makeOutput({ filePath: 'src/b.ts' }),
			);
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-3'),
				makeOutput({ filePath: 'src/c.ts' }),
			);

			expect(session?.modifiedFilesThisCoderTask?.length).toBe(3);
			expect(session?.modifiedFilesThisCoderTask).toEqual([
				'src/a.ts',
				'src/b.ts',
				'src/c.ts',
			]);
		});

		it('after reset on new coder dispatch, subsequent writes track fresh list', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = true;

			// First round of coder writes
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'src/first-round.ts' }),
			);
			expect(session?.modifiedFilesThisCoderTask).toContain(
				'src/first-round.ts',
			);

			// Now simulate architect dispatching a NEW coder delegation (reset)
			// First, turn off delegationActive to simulate architect's perspective
			session!.delegationActive = false;

			// Architect dispatches new coder
			await hooks.toolBefore(
				makeInput('test-session', 'Task', 'call-2'),
				makeOutput({ subagent_type: 'coder', task: 'New task' }),
			);

			// Now enable delegation again for the new coder
			session!.delegationActive = true;

			// New coder writes should start fresh
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-3'),
				makeOutput({ filePath: 'src/second-round.ts' }),
			);

			// Should have only the new file, not the old one
			expect(session?.modifiedFilesThisCoderTask).toContain(
				'src/second-round.ts',
			);
			expect(session?.modifiedFilesThisCoderTask).not.toContain(
				'src/first-round.ts',
			);
			expect(session?.modifiedFilesThisCoderTask?.length).toBe(1);
		});
	});

	describe('delegationActive=false scenarios', () => {
		it('delegationActive=false → write tool does NOT track', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			// delegationActive is false by default (or explicitly set to false)
			session!.delegationActive = false;

			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'src/foo.ts' }),
			);

			// Should NOT track because delegation is not active
			expect(session?.modifiedFilesThisCoderTask?.length ?? 0).toBe(0);
		});

		it('no session → fail-closed with WRITE BLOCKED (no active agent)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			// No session started

			const input = makeInput('non-existent-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'src/foo.ts' });

			// PR #501: writes from unknown sessions are now fail-closed rather
			// than silently defaulting to architect. The hook throws
			// "WRITE BLOCKED: No active agent registered ..." so unregistered
			// sessions can never reach the per-agent authority check.
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'No active agent registered',
			);
		});
	});

	describe('existing architect behavior preserved', () => {
		it('architect direct write still increments architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			// Start as architect (NOT delegationActive)
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = false; // Explicitly not in delegation

			// Architect writes directly to source code
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'src/architect-write.ts' }),
			);

			// Should increment architectWriteCount
			expect(session?.architectWriteCount).toBe(1);
		});

		it('architect direct write to non-source (README) → does NOT increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = false;

			// Architect writes to README.md (not source code)
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'README.md' }),
			);

			// Should NOT increment architectWriteCount
			expect(session?.architectWriteCount).toBe(0);
		});

		it('coder subagent write - tracks in modifiedFilesThisCoderTask (architectWriteCount behavior may vary)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = true; // Coder subagent is active

			// Coder (via delegationActive) writes to source code
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'src/coder-write.ts' }),
			);

			// Should track in modifiedFilesThisCoderTask (Task 5.2 primary behavior)
			expect(session?.modifiedFilesThisCoderTask).toContain(
				'src/coder-write.ts',
			);

			// Note: architectWriteCount may or may not be incremented depending on implementation
			// The key is that modifiedFilesThisCoderTask is populated for the delegation flow
		});
	});

	describe('edge cases', () => {
		it('empty string path fails closed and does not track', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = true;

			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'write', 'call-1'),
					makeOutput({ filePath: '' }),
				),
			).rejects.toThrow('WRITE TARGET UNVERIFIABLE');

			expect(session?.modifiedFilesThisCoderTask?.length ?? 0).toBe(0);
		});

		it('undefined path fails closed and does not track', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = true;

			await expect(
				hooks.toolBefore(
					makeInput('test-session', 'write', 'call-1'),
					makeOutput({ content: 'some content' }), // No path field
				),
			).rejects.toThrow('WRITE TARGET UNVERIFIABLE');

			expect(session?.modifiedFilesThisCoderTask?.length ?? 0).toBe(0);
		});

		it('namespace-prefixed tool name (opencode:write) → still tracks', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const session = getAgentSession('test-session');
			session!.delegationActive = true;

			// Tool name with namespace prefix
			await hooks.toolBefore(
				makeInput('test-session', 'opencode:write', 'call-1'),
				makeOutput({ filePath: 'src/namespaced.ts' }),
			);

			expect(session?.modifiedFilesThisCoderTask).toContain(
				'src/namespaced.ts',
			);
		});
	});
});
