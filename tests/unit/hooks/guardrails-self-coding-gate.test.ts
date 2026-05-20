import { beforeEach, describe, expect, it } from 'bun:test';
import { ORCHESTRATOR_NAME } from '../../../src/config/constants';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	getAgentSession,
	getTaskState,
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

describe('guardrails self-coding detection gate (Task 7A.2)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	describe('verification tests - isSourceCodePath gating', () => {
		it('architect writes to src/auth/login.ts → should increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'src/auth/login.ts' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(1);
		});

		it('architect writes to README.md → should NOT increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'README.md' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(0);
		});

		it('architect writes to package.json → should NOT increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'package.json' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(0);
		});

		it('architect writes to .github/workflows/ci.yml → should NOT increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.github/workflows/ci.yml' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(0);
		});

		it('architect writes to src/hooks/guardrails.ts → should increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'src/hooks/guardrails.ts' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(1);
		});
	});

	describe('adversarial tests - edge cases and bypass attempts', () => {
		it('architect attempts write to src/../README.md (path traversal) → should NOT increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'src/../README.md' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			// Path should be normalized to README.md, which is not source code
			expect(session?.architectWriteCount).toBe(0);
		});

		it('architect writes to SRC/index.ts (case sensitivity) → should increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'SRC/index.ts' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			// Uppercase SRC doesn't match non-source patterns, so it should be counted
			expect(session?.architectWriteCount).toBe(1);
		});

		it('architect writes to CHANGELOG.md → should NOT increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'CHANGELOG.md' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(0);
		});

		it('architect writes to docs/guide.md → should NOT increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'docs/guide.md' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(0);
		});

		it('architect writes to .swarm/context.md → should NOT increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.swarm/context.md' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(0);
		});
	});

	describe('mixed write scenarios', () => {
		it('architect writes to src/ (counted) and README.md (not counted) → correct counts', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			// Write to source code (counted)
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'src/test.ts' }),
			);

			// Write to README (not counted)
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-2'),
				makeOutput({ filePath: 'README.md' }),
			);

			// Write to another source file (counted)
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-3'),
				makeOutput({ filePath: 'src/auth/login.ts' }),
			);

			// Write to package.json (not counted)
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-4'),
				makeOutput({ filePath: 'package.json' }),
			);

			const session = getAgentSession('test-session');
			// Only source code writes should be counted
			expect(session?.architectWriteCount).toBe(2);
		});
	});

	describe('non-architect sessions are unaffected', () => {
		it('coder writes to src/test.ts → should NOT increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', 'coder');

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'src/test.ts' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(0);
		});
	});

	describe('write tool variants', () => {
		it('architect uses edit tool on src/test.ts → should increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'edit', 'call-1');
			const output = makeOutput({ filePath: 'src/test.ts' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(1);
		});

		it('architect uses patch tool on src/test.ts → should increment architectWriteCount', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'patch', 'call-1');
			const output = makeOutput({ filePath: 'src/test.ts' });

			await hooks.toolBefore(input, output);

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(1);
		});
	});

	describe('hard block at architectWriteCount >= 3 (Task 1.3)', () => {
		it('architectWriteCount = 1: write tool on source file → increments to 1, NO throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'src/test.ts' });

			// Should NOT throw at count 1
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(1);
		});

		it('architectWriteCount = 2: write tool on source file → increments to 2, NO throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			// Pre-set count to 1
			await hooks.toolBefore(
				makeInput('test-session', 'write', 'call-1'),
				makeOutput({ filePath: 'src/file1.ts' }),
			);

			// This should increment to 2 and NOT throw
			const input = makeInput('test-session', 'write', 'call-2');
			const output = makeOutput({ filePath: 'src/file2.ts' });

			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();

			const session = getAgentSession('test-session');
			expect(session?.architectWriteCount).toBe(2);
		});

		it('no session (session lookup returns undefined): → fail-closed WRITE BLOCKED', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			// Do NOT start an agent session

			const input = makeInput('non-existent-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'src/test.ts' });

			// PR #501: writes from sessions without a registered active agent
			// are now fail-closed with "WRITE BLOCKED: No active agent
			// registered ...". Defaulting unregistered sessions to architect
			// would grant broad write authority to any unknown caller, so the
			// hook blocks the write instead.
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'No active agent registered',
			);
		});

		it('non-architect agent at count 3: → no throw (block only runs for architect)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			// Start as 'coder' agent, not ORCHESTRATOR_NAME
			startAgentSession('test-session', 'coder');

			// Pre-set architectWriteCount to 2 (simulating edge case from prior session data)
			const session = getAgentSession('test-session');
			if (session) {
				session.architectWriteCount = 2;
			}

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'src/test.ts' });

			// Should NOT throw for non-architect
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();

			// Count should remain at 2 for coder (not incremented since coder is not architect)
			const updatedSession = getAgentSession('test-session');
			expect(updatedSession?.architectWriteCount).toBe(2);
		});
	});
});
