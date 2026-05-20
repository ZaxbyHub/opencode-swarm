import { beforeEach, describe, expect, it } from 'bun:test';
import { ORCHESTRATOR_NAME } from '../../../src/config/constants';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
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

describe('guardrails plan.md write-block guard - adversarial tests', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	describe('attack vector 1: absolute paths to plan.md', () => {
		it('absolute Windows path C:\\project\\.swarm\\plan.md → NOT blocked (bypass gap)', async () => {
			// On Windows, C:\project\... is an absolute path outside the working
			// directory, so the containment check (#496) correctly blocks it.
			// The bypass gap only exists on Linux/Mac where C:\... is relative.
			if (process.platform === 'win32') return;

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'C:\\project\\.swarm\\plan.md' });

			// Guard does NOT block absolute paths - this is a known gap
			// The guard only resolves relative to project directory
			await hooks.toolBefore(input, output);
		});

		it('absolute Unix path /workspace/.swarm/plan.md → blocked (containment, gap closed)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '/workspace/.swarm/plan.md' });

			// Previously this was a known bypass gap — the plan.md guard only
			// resolved relative to the project directory, so an unrelated
			// absolute path wasn't blocked. The rule-level cwd containment
			// check added in #496 final now closes this gap: /workspace/... is
			// outside the running test's cwd and is rejected by the authority
			// layer before it reaches the plan.md guard.
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/resolves outside the working directory/,
			);
		});

		it('absolute path with forward slashes on Windows → NOT blocked (bypass gap)', async () => {
			// On Windows, C:/project/... is an absolute path outside the working
			// directory, so the containment check (#496) correctly blocks it.
			// The bypass gap only exists on Linux/Mac where C:/... is relative.
			if (process.platform === 'win32') return;

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'C:/project/.swarm/plan.md' });

			// Guard does NOT block absolute paths - this is a known gap
			await hooks.toolBefore(input, output);
		});
	});

	describe('attack vector 2: path with trailing slash', () => {
		it('.swarm/plan.md/ with trailing slash → should throw (path resolves)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.swarm/plan.md/' });

			// Note: path.resolve removes trailing slashes, so this should resolve to plan.md
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('.swarm/plan.md// double slash → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.swarm/plan.md//' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});
	});

	describe('attack vector 3: URL encoding attempts', () => {
		it('path with %2F encoded slash → should NOT throw (raw string, not decoded)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.swarm%2Fplan.md' });

			// The guard checks raw string, not decoded - this is NOT blocked
			// This is a known limitation (the guard doesn't decode URLs)
			await hooks.toolBefore(input, output);
		});

		it('path with encoded .. (%2E%2E) → should NOT throw (not decoded)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({
				filePath: '.swarm%2F%2E%2E%2F.swarm%2Fplan.md',
			});

			// URL encoding is not decoded - not blocked
			await hooks.toolBefore(input, output);
		});
	});

	describe('attack vector 4: mixed case variations', () => {
		it('.swarm/Plan.MD mixed case → should throw (case-insensitive)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.swarm/Plan.MD' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('.SWARM/PLAN.MD uppercase → should throw (case-insensitive)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.SWARM/PLAN.MD' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('.SwArm/PlAn.Md random case → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.SwArm/PlAn.Md' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});
	});

	describe('attack vector 5: relative path traversal', () => {
		it('.swarm/../.swarm/plan.md traversal → should throw (resolves to plan.md)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.swarm/../.swarm/plan.md' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('../.swarm/plan.md from subdirectory → blocked (containment, gap closed)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '../.swarm/plan.md' });

			// Previously this was a known bypass: `../.swarm/plan.md` resolves
			// to a parent directory (outside cwd) and the plan.md guard only
			// matched paths that resolved *inside* cwd. The rule-level cwd
			// containment check added in #496 final now rejects any path that
			// escapes cwd for every agent, which closes the bypass.
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/resolves outside the working directory/,
			);
		});

		it.skipIf(process.platform !== 'win32')(
			'..\\.swarm\\plan.md Windows backslash → blocked (traversal caught by containment)',
			async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(config);
				startAgentSession('test-session', ORCHESTRATOR_NAME);

				const input = makeInput('test-session', 'write', 'call-1');
				const output = makeOutput({ filePath: '..\\.swarm\\plan.md' });

				// On Windows backslash is a path separator, so ..\.swarm\plan.md is a
				// traversal to the parent directory. The containment check (#496) catches
				// it as "resolves outside the working directory" — the bypass gap is closed.
				await expect(hooks.toolBefore(input, output)).rejects.toThrow(
					/resolves outside the working directory/,
				);
			},
		);
	});

	describe('attack vector 6: apply_patch with plan.md in diff content', () => {
		it('apply_patch with *** Update File: .swarm/plan.md → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'apply_patch', 'call-1');
			const output = makeOutput({
				input: `*** Update File: .swarm/plan.md
--- a/.swarm/plan.md
+++ b/.swarm/plan.md`,
			});

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('apply_patch with +++ b/.swarm/plan.md (unified diff) → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'apply_patch', 'call-1');
			const output = makeOutput({
				input: `--- a/.swarm/plan.md
+++ b/.swarm/plan.md
@@ -1,3 +1,4 @@
+# Added line`,
			});

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('apply_patch with *** Add File: .swarm/plan.md → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'apply_patch', 'call-1');
			const output = makeOutput({
				input: `*** Add File: .swarm/plan.md`,
			});

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('apply_patch with mixed case .SWARM/PLAN.MD → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'apply_patch', 'call-1');
			const output = makeOutput({
				input: `*** Update File: .SWARM/PLAN.MD`,
			});

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('apply_patch with patch content only (no targetPath arg) → should work for non-plan paths', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'apply_patch', 'call-1');
			const output = makeOutput({
				input: `*** Update File: src/index.ts
--- a/src/index.ts
+++ b/src/index.ts`,
			});

			// Should NOT throw - just increments architectWriteCount
			await hooks.toolBefore(input, output);
		});
	});

	describe('attack vector 7: non-string targetPath (should NOT throw)', () => {
		it('null targetPath → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: null });

			// Should not throw - just run the function
			await hooks.toolBefore(input, output);
		});

		it('undefined targetPath → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({});

			await hooks.toolBefore(input, output);
		});

		it('number targetPath (123) → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 123 });

			await hooks.toolBefore(input, output);
		});

		it('object targetPath → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: { path: '.swarm/plan.md' } });

			await hooks.toolBefore(input, output);
		});

		it('array targetPath → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: ['.swarm', 'plan.md'] });

			await hooks.toolBefore(input, output);
		});

		it('boolean targetPath (true) → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: true });

			await hooks.toolBefore(input, output);
		});
	});

	describe('attack vector 8: empty string targetPath (should NOT throw)', () => {
		it('empty string targetPath → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '' });

			await hooks.toolBefore(input, output);
		});

		it('whitespace-only targetPath → should NOT throw (length > 0 passes)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '   ' });

			// Whitespace passes the length check but won't match plan.md
			await hooks.toolBefore(input, output);
		});
	});

	describe('edge cases and boundary conditions', () => {
		it('plan.md without .swarm prefix → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: 'plan.md' });

			// Only .swarm/plan.md is blocked, not standalone plan.md
			await hooks.toolBefore(input, output);
		});

		it('.swarm/plan.md.txt (different extension) → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.swarm/plan.md.txt' });

			await hooks.toolBefore(input, output);
		});

		it('.swarm/plan.md.bak (backup file) → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.swarm/plan.md.bak' });

			await hooks.toolBefore(input, output);
		});

		it('.swarm/plan.md.old → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.swarm/plan.md.old' });

			await hooks.toolBefore(input, output);
		});

		it('.swarm/plan.md~ (vim backup) → should NOT throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ filePath: '.swarm/plan.md~' });

			await hooks.toolBefore(input, output);
		});

		it('using different arg key: path → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ path: '.swarm/plan.md' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('using different arg key: file → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ file: '.swarm/plan.md' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('using different arg key: target → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'write', 'call-1');
			const output = makeOutput({ target: '.swarm/plan.md' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});
	});

	describe('tool type variations', () => {
		it('edit tool with .swarm/plan.md → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'edit', 'call-1');
			const output = makeOutput({ filePath: '.swarm/plan.md' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('patch tool with .swarm/plan.md → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'patch', 'call-1');
			const output = makeOutput({ input: '*** Update File: .swarm/plan.md' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('create_file tool with .swarm/plan.md → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'create_file', 'call-1');
			const output = makeOutput({ filePath: '.swarm/plan.md' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('insert tool with .swarm/plan.md → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'insert', 'call-1');
			const output = makeOutput({ filePath: '.swarm/plan.md' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});

		it('replace tool with .swarm/plan.md → should throw', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);
			startAgentSession('test-session', ORCHESTRATOR_NAME);

			const input = makeInput('test-session', 'replace', 'call-1');
			const output = makeOutput({ filePath: '.swarm/plan.md' });

			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'PLAN STATE VIOLATION',
			);
		});
	});
});
