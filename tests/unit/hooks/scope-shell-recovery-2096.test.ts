import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
	AuthorityConfig,
	GuardrailsConfig,
} from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let testDirectory = '';
let cleanup = () => {};

const config: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 200,
	max_duration_minutes: 30,
	idle_timeout_minutes: 60,
	max_repetitions: 10,
	max_consecutive_errors: 5,
	warning_threshold: 0.75,
	profiles: undefined,
	block_destructive_commands: true,
};

describe('issue #2096 shell scope recovery contract', () => {
	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('shell-scope-recovery-2096-');
		testDirectory = created.dir;
		cleanup = created.cleanup;
		startAgentSession('shell-scope-session', 'coder', testDirectory);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
		cleanup = () => {};
	});

	test('same-root out-of-scope write is typed and architect-actionable', async () => {
		installActiveScopeBinding({
			directory: testDirectory,
			childSessionId: 'shell-scope-session',
			taskId: '1.1',
			files: ['src/allowed.ts'],
		});
		const hooks = createGuardrailsHooks(testDirectory, undefined, config);
		const call = hooks.toolBefore(
			{
				tool: 'bash',
				sessionID: 'shell-scope-session',
				callID: 'scope-violation',
			},
			{ args: { command: 'echo nope > src/outside.ts' } },
		);
		await expect(call).rejects.toThrow(/^WRITE BLOCKED: SCOPE_VIOLATION:/);
		await expect(call).rejects.toThrow(/ACTION\[architect\].*declare_scope/i);
	});

	test('missing binding remains distinct from a same-root violation', async () => {
		const hooks = createGuardrailsHooks(testDirectory, undefined, config);
		await expect(
			hooks.toolBefore(
				{
					tool: 'bash',
					sessionID: 'shell-scope-session',
					callID: 'scope-missing',
				},
				{ args: { command: 'echo nope > src/outside.ts' } },
			),
		).rejects.toThrow(
			/SCOPE_NOT_DECLARED.*ACTION\[architect\].*declare_scope.*new Task call/i,
		);
	});

	test('scope diagnostic is bounded when many entries exist', async () => {
		installActiveScopeBinding({
			directory: testDirectory,
			childSessionId: 'shell-scope-session',
			taskId: '1.1',
			files: Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`),
		});
		const hooks = createGuardrailsHooks(testDirectory, undefined, config);
		try {
			await hooks.toolBefore(
				{
					tool: 'bash',
					sessionID: 'shell-scope-session',
					callID: 'scope-bounded',
				},
				{ args: { command: 'echo nope > src/outside.ts' } },
			);
			throw new Error('expected scope violation');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain('... (+20 more)');
			expect(message.length).toBeLessThan(2200);
		}
	});

	test('no-scope shell path uses the same lexical universal deny matcher', async () => {
		startAgentSession('shell-scope-session', 'explorer', testDirectory);
		const authority: AuthorityConfig = {
			enabled: true,
			rules: {},
			universal_deny_prefixes: ['.env'],
		};
		const hooks = createGuardrailsHooks(
			testDirectory,
			undefined,
			config,
			authority,
		);
		await expect(
			hooks.toolBefore(
				{
					tool: 'bash',
					sessionID: 'shell-scope-session',
					callID: 'universal-env-local',
				},
				{ args: { command: 'echo nope > .env.local' } },
			),
		).rejects.toThrow(/universal deny prefix.*\.env/i);
	});

	test('prefixed read-only shell role cannot be made writable by config', async () => {
		startAgentSession('shell-scope-session', 'local_explorer', testDirectory);
		const authority: AuthorityConfig = {
			enabled: true,
			rules: { local_explorer: { readOnly: false } },
			universal_deny_prefixes: [],
		};
		const hooks = createGuardrailsHooks(
			testDirectory,
			undefined,
			config,
			authority,
		);
		await expect(
			hooks.toolBefore(
				{
					tool: 'bash',
					sessionID: 'shell-scope-session',
					callID: 'prefixed-read-only',
				},
				{ args: { command: 'echo nope > src/not-allowed.ts' } },
			),
		).rejects.toThrow(/AUTHORITY_ROLE_READ_ONLY.*read-only/i);
	});
});
