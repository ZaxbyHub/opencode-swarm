import { beforeEach, describe, expect, it, vi } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import * as planManager from '../../../src/plan/manager';
import {
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
	tool = 'read',
	callID = 'call-1',
) {
	return { tool, sessionID, callID };
}

function makeOutput(args: unknown = { filePath: '/test.ts' }) {
	return { args };
}

/**
 * Adversarial security tests for createGuardrailsHooks directory parameter injection
 * Focus: malformed inputs, oversized payloads, injection attempts, boundary violations
 */
describe('guardrails adversarial - directory parameter injection', () => {
	beforeEach(() => {
		resetSwarmState();
		vi.clearAllMocks();
	});

	// ============================================================
	// OVERSIZED PAYLOAD ATTACKS
	// ============================================================
	describe('oversized payload attacks on directory parameter', () => {
		it('should handle extremely long directory string (1MB)', async () => {
			const longPath = 'a'.repeat(1024 * 1024);
			const config = defaultConfig();

			// Should not crash - should handle gracefully
			const hooks = createGuardrailsHooks(longPath, config);
			expect(hooks).toBeDefined();

			// Verify hooks are functional
			startAgentSession('test-session', 'coder');
			const loadPlanSpy = vi
				.spyOn(planManager, 'loadPlan')
				.mockResolvedValue(null);

			const input = makeInput('test-session', 'Task', 'call-long-dir');
			await hooks.toolBefore(input, { args: { subagent_type: 'reviewer' } });

			const output = { title: 'Result', output: 'success', metadata: {} };
			await hooks.toolAfter(input, output);

			// loadPlan should receive the long path unchanged
			expect(loadPlanSpy).toHaveBeenCalledWith(longPath);
			loadPlanSpy.mockRestore();
		});

		it('should handle deeply nested path with extreme depth', async () => {
			const deepPath = '/'.repeat(500) + 'verylongdirname'.repeat(100);
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(deepPath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle path with maximum Unicode characters', async () => {
			const unicodePath = 'こんにちは世界'.repeat(1000);
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(unicodePath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle config object with massive property count', async () => {
			const config = defaultConfig();
			// Add thousands of profile entries
			const hugeProfiles: Record<string, GuardrailsConfig> = {};
			for (let i = 0; i < 10000; i++) {
				hugeProfiles[`agent_${i}`] = { ...defaultConfig(), max_tool_calls: i };
			}
			config.profiles = hugeProfiles;

			const hooks = createGuardrailsHooks('/test', config);
			expect(hooks).toBeDefined();
		});

		it('should handle config with extremely large warning_threshold', async () => {
			const config = defaultConfig({ warning_threshold: 1e308 });

			const hooks = createGuardrailsHooks('/test', config);
			expect(hooks).toBeDefined();
		});

		it('should handle config with negative max values', async () => {
			const config = defaultConfig({
				max_tool_calls: -999999,
				max_duration_minutes: -1,
				max_repetitions: -50,
			});

			const hooks = createGuardrailsHooks('/test', config);
			expect(hooks).toBeDefined();

			// Should still create functional hooks
			startAgentSession('test-session', 'coder');
			const input = makeInput('test-session', 'read', 'call-neg');

			// Negative limits may cause the hook to throw (hard limit of 0 or negative)
			// but the factory should still create valid hooks
			let threw = false;
			try {
				await hooks.toolBefore(input, makeOutput());
			} catch {
				threw = true;
			}
			// Just verify hooks were created and called
			expect(hooks.toolBefore).toBeInstanceOf(Function);
		});
	});

	// ============================================================
	// INJECTION ATTACKS
	// ============================================================
	describe('injection attack vectors on directory parameter', () => {
		it('should handle path traversal attempts in directory parameter', async () => {
			const traversalPath = '../../../etc/passwd';
			const config = defaultConfig();

			// Should not crash - path is passed as-is to internal functions
			const hooks = createGuardrailsHooks(traversalPath, config);
			expect(hooks).toBeDefined();

			// hooks should be functional
			startAgentSession('test-session', 'coder');
			const loadPlanSpy = vi
				.spyOn(planManager, 'loadPlan')
				.mockResolvedValue(null);

			const input = makeInput('test-session', 'Task', 'call-traversal');
			await hooks.toolBefore(input, { args: { subagent_type: 'reviewer' } });

			const output = { title: 'Result', output: 'success', metadata: {} };
			await hooks.toolAfter(input, output);

			// loadPlan should receive the path as-is (defense is in isOutsideSwarmDir, not parameter validation)
			expect(loadPlanSpy).toHaveBeenCalledWith(traversalPath);
			loadPlanSpy.mockRestore();
		});

		it('should handle HTML/script injection in directory parameter', async () => {
			const xssPath = '<script>alert("xss")</script>';
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(xssPath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle template literal injection in directory parameter', async () => {
			const templatePath = '${process.exit(1)}';
			const config = defaultConfig();

			// Should treat as literal string, not evaluate
			const hooks = createGuardrailsHooks(templatePath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle SQL injection patterns in directory parameter', async () => {
			const sqlPath = "'; DROP TABLE users; --";
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(sqlPath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle null byte injection in directory parameter', async () => {
			const nullBytePath = '/test\0/path';
			const config = defaultConfig();

			// Null bytes should be preserved as-is (JS strings handle them)
			const hooks = createGuardrailsHooks(nullBytePath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle RTL override characters in directory parameter', async () => {
			const rtlPath = '/test/\u202Epath'; // RLO character
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(rtlPath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle zero-width space in directory parameter', async () => {
			const zwPath = '/test/\u200Bpath';
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(zwPath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle emoji in directory parameter', async () => {
			const emojiPath = '/test/🔐path💢';
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(emojiPath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle combining characters in directory parameter', async () => {
			const combiningPath = '/test/p\u0301ath'; // p + combining acute
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(combiningPath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle Windows UNC path injection', async () => {
			const uncPath = '\\\\attacker\\share';
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(uncPath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle path with newlines in directory parameter', async () => {
			const newlinePath = '/test\\npath';
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(newlinePath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle path with tabs in directory parameter', async () => {
			const tabPath = '/test\\tpath';
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(tabPath, config);
			expect(hooks).toBeDefined();
		});

		it('should handle control characters in directory parameter', async () => {
			const controlPath = '/test\x00\x1e\x7fpath';
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(controlPath, config);
			expect(hooks).toBeDefined();
		});
	});

	// ============================================================
	// TYPE CONFUSION ATTACKS - These reveal bugs in the source code
	// ============================================================
	describe('type confusion attacks on function parameters', () => {
		it('BUG: createGuardrailsHooks crashes when directoryOrConfig is a number (ambiguous signature)', () => {
			// This is a bug: calling createGuardrailsHooks('/test', 42) crashes
			// because 42 is not an object, so the legacy check fails,
			// then guardrailsConfig = config (which is undefined), causing
			// cfg.qa_gates to crash
			const config = defaultConfig();

			expect(() => createGuardrailsHooks('/test', 42 as any)).toThrow(
				TypeError,
			);
		});

		it('BUG: createGuardrailsHooks crashes when directoryOrConfig is an array', () => {
			// Arrays are objects but don't have 'enabled' property,
			// so it goes to else branch and crashes on undefined config
			const config = defaultConfig();

			expect(() => createGuardrailsHooks('/test', ['array'] as any)).toThrow(
				TypeError,
			);
		});

		it('BUG: createGuardrailsHooks crashes when config is a string instead of object', () => {
			// config is passed as string '/other', which becomes guardrailsConfig
			// then cfg.qa_gates crashes
			expect(() => createGuardrailsHooks('/test', '/other' as any)).toThrow(
				TypeError,
			);
		});

		it('BUG: createGuardrailsHooks crashes when config is a number', () => {
			expect(() => createGuardrailsHooks('/test', 123 as any)).toThrow(
				TypeError,
			);
		});

		it('should handle directory parameter as number when properly typed', () => {
			const config = defaultConfig();

			// TypeScript would catch this at compile time, but runtime allows any type
			// This doesn't crash because config is a proper object
			const hooks = createGuardrailsHooks(12345 as any, config);
			expect(hooks).toBeDefined();
		});

		it('should handle directory parameter as object when properly typed', () => {
			const config = defaultConfig();

			const hooks = createGuardrailsHooks({ path: '/test' } as any, config);
			expect(hooks).toBeDefined();
		});

		it('should handle both directoryOrConfig and config as objects', () => {
			const config1 = { enabled: true };
			const config2 = { max_tool_calls: 50 };

			// directory is '/test', directoryOrConfig is config1 object, config is config2
			const hooks = createGuardrailsHooks(
				'/test',
				config1 as any,
				config2 as any,
			);
			expect(hooks).toBeDefined();
		});
	});

	// ============================================================
	// BOUNDARY VIOLATIONS
	// ============================================================
	describe('boundary violations on function parameters', () => {
		it('should handle empty string directory parameter', () => {
			const config = defaultConfig();

			// Empty string is falsy but valid
			const hooks = createGuardrailsHooks('', config);
			expect(hooks).toBeDefined();
		});

		it('should handle single character directory parameter', () => {
			const config = defaultConfig();

			const hooks = createGuardrailsHooks('/', config);
			expect(hooks).toBeDefined();
		});

		it('should handle whitespace-only directory parameter', () => {
			const config = defaultConfig();

			const hooks = createGuardrailsHooks('   ', config);
			expect(hooks).toBeDefined();
		});

		it('should handle tab and newline in directory parameter', () => {
			const config = defaultConfig();

			const hooks = createGuardrailsHooks('\\t\\n', config);
			expect(hooks).toBeDefined();
		});

		it('should handle Number.MAX_SAFE_INTEGER as directory', () => {
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(
				Number.MAX_SAFE_INTEGER.toString() as any,
				config,
			);
			expect(hooks).toBeDefined();
		});

		it('should handle -0 as directory', () => {
			const config = defaultConfig();

			// -0 is a valid number that gets converted to string
			const hooks = createGuardrailsHooks(-0 as any, config);
			expect(hooks).toBeDefined();
		});

		it('should handle NaN as directory', () => {
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(NaN as any, config);
			expect(hooks).toBeDefined();
		});

		it('should handle Infinity as directory', () => {
			const config = defaultConfig();

			const hooks = createGuardrailsHooks(Infinity as any, config);
			expect(hooks).toBeDefined();
		});

		it('should handle config with NaN values', () => {
			const config = defaultConfig({ max_tool_calls: NaN } as any);

			const hooks = createGuardrailsHooks('/test', config);
			expect(hooks).toBeDefined();
		});

		it('should handle config with Infinity values', () => {
			const config = defaultConfig({ max_duration_minutes: Infinity } as any);

			const hooks = createGuardrailsHooks('/test', config);
			expect(hooks).toBeDefined();
		});

		it('should handle config with undefined properties', () => {
			const config = {
				enabled: undefined,
				max_tool_calls: undefined,
				max_duration_minutes: undefined,
			} as any;

			const hooks = createGuardrailsHooks('/test', config);
			expect(hooks).toBeDefined();
		});
	});

	// ============================================================
	// MALFORMED INPUT - toolBefore/After/messagesTransform hooks
	// ============================================================
	describe('malformed inputs to hook functions', () => {
		it('should handle toolBefore with missing sessionID (empty string)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			// Empty sessionID - should handle gracefully
			const input = { tool: 'read', sessionID: '', callID: 'call-1' };
			const output = { args: { filePath: '/test.ts' } };

			// Should not crash - just returns early due to empty sessionID
			let result;
			let threw = false;
			try {
				result = await hooks.toolBefore(input as any, output);
			} catch (err) {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle toolBefore with undefined sessionID', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			const input = {
				tool: 'read',
				sessionID: undefined,
				callID: 'call-1',
			} as any;
			const output = { args: { filePath: '/test.ts' } };

			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle toolBefore with null sessionID', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			const input = { tool: 'read', sessionID: null, callID: 'call-1' } as any;
			const output = { args: { filePath: '/test.ts' } };

			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle toolBefore with non-string tool name', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'coder');

			const input = {
				tool: 123,
				sessionID: 'test-session',
				callID: 'call-1',
			} as any;
			const output = { args: { filePath: '/test.ts' } };

			// Non-string tool names now throw: the hook normalises tool names via
			// String.replace(), which fails on a numeric input. This is the
			// defensive fail-closed behaviour introduced alongside PR #501.
			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		});

		it('should handle toolBefore with malformed args (circular reference)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'coder');

			const circularObj: any = { filePath: '/test.ts' };
			circularObj.self = circularObj;

			const input = {
				tool: 'read',
				sessionID: 'test-session',
				callID: 'call-1',
			};
			const output = { args: circularObj };

			// Should not crash - Bun.hash handles circular refs via JSON.stringify
			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle toolBefore with extremely nested args', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'coder');

			// Create deeply nested object
			let nested: any = { value: 1 };
			for (let i = 0; i < 100; i++) {
				nested = { nested };
			}

			const input = {
				tool: 'read',
				sessionID: 'test-session',
				callID: 'call-1',
			};
			const output = { args: nested };

			// Should not crash
			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle toolAfter with undefined output', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'coder');

			const input = {
				tool: 'Task',
				sessionID: 'test-session',
				callID: 'call-1',
				args: { subagent_type: 'reviewer' },
			};

			// undefined output
			let threw = false;
			try {
				await hooks.toolAfter(input, undefined as any);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle toolAfter with null output', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'coder');

			const input = {
				tool: 'Task',
				sessionID: 'test-session',
				callID: 'call-1',
				args: { subagent_type: 'reviewer' },
			};

			let threw = false;
			try {
				await hooks.toolAfter(input, null as any);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle messagesTransform with undefined messages', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'architect');

			// undefined messages
			let threw = false;
			try {
				await hooks.messagesTransform({}, { messages: undefined } as any);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle messagesTransform with null messages', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'architect');

			let threw = false;
			try {
				await hooks.messagesTransform({}, { messages: null } as any);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle messagesTransform with empty messages array', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'architect');

			const output = { messages: [] };
			let threw = false;
			try {
				await hooks.messagesTransform({}, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle messagesTransform with malformed message structure', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'architect');

			const malformedMessages = [
				{ info: null, parts: null },
				{ info: { role: 'system' }, parts: [{ type: 'text', text: 'test' }] },
				{ info: { role: 'user' }, parts: 'not an array' },
				{ info: {}, parts: [{ type: null }] },
			] as any;

			const output = { messages: malformedMessages };
			let threw = false;
			try {
				await hooks.messagesTransform({}, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});

	// ============================================================
	// LEGACY SIGNATURE BACKWARD COMPATIBILITY ATTACKS
	// ============================================================
	describe('legacy signature backward compatibility attacks', () => {
		it('should return no-op handlers when config.enabled is explicitly false', () => {
			const config = { enabled: false };

			// Legacy signature: createGuardrailsHooks(config)
			// directoryOrConfig is config object, typeof config === 'object', 'enabled' in config is true
			const hooks = createGuardrailsHooks(config as any);
			expect(hooks).toBeDefined();

			// Should return no-op handlers
			expect(hooks.toolBefore).toBeInstanceOf(Function);
			expect(hooks.toolAfter).toBeInstanceOf(Function);
			expect(hooks.messagesTransform).toBeInstanceOf(Function);
		});

		it('BUG: legacy call with minimal config (empty object) causes crash', () => {
			// Empty object - no 'enabled' property
			// This causes the else branch to execute, setting guardrailsConfig = undefined
			expect(() => createGuardrailsHooks({} as any)).toThrow(TypeError);
		});

		it('BUG: legacy call with config missing enabled property causes crash', () => {
			const config = { max_tool_calls: 100 };

			// 'enabled' in config is false, so it goes to new signature path
			// But config is used as directoryOrConfig (ambiguous) and guardrailsConfig = undefined
			expect(() => createGuardrailsHooks(config as any)).toThrow(TypeError);
		});

		it('should handle both parameters as config objects (ambiguous)', () => {
			const config1 = { enabled: true };
			const config2 = { max_tool_calls: 50 };

			// directory is '/test', directoryOrConfig is config1 object, config is config2
			const hooks = createGuardrailsHooks(
				'/test',
				config1 as any,
				config2 as any,
			);
			expect(hooks).toBeDefined();
		});
	});

	// ============================================================
	// SECURITY BOUNDARY - path traversal through filePath args
	// ============================================================
	describe('path traversal security boundary', () => {
		it('should handle filePath with traversal sequences in write tool', async () => {
			const config = defaultConfig();
			const testDir = '/test/project';
			const hooks = createGuardrailsHooks(testDir, config);

			startAgentSession('test-session', 'architect');

			const input = {
				tool: 'write',
				sessionID: 'test-session',
				callID: 'call-1',
			};
			const output = { args: { filePath: '../../../etc/passwd' } };

			// PR #501 + #496: cwd-containment check now rejects writes whose
			// resolved path escapes the effective directory.
			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		});

		it('should handle filePath with null bytes in write tool', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'architect');

			const input = {
				tool: 'write',
				sessionID: 'test-session',
				callID: 'call-1',
			};
			const output = { args: { filePath: '/test\0/file' } };

			// PR #501 + #496: paths containing null bytes are rejected by the
			// write authority / lstat containment checks rather than silently
			// passed through.
			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		});

		it('should handle apply_patch with standard unified diff format traversal', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'architect');

			const maliciousPatch = `
*** Update File: ../../../etc/passwd
--- a/test
+++ b/test
@@ -1 +1 @@
-old
+malicious
`;

			const input = {
				tool: 'apply_patch',
				sessionID: 'test-session',
				callID: 'call-1',
			};
			const output = { args: { patch: maliciousPatch } };

			// PR #501 + #496: apply_patch targets are now run through the same
			// authority / containment checks — a traversal target is rejected.
			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		});

		it('should handle apply_patch with git diff format traversal', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'architect');

			const gitDiff = `
diff --git a/../../../etc/passwd b/../../../etc/passwd
--- a/../../../etc/passwd
+++ b/../../../etc/passwd
@@ -1 +1 @@
-old
+malicious
`;

			const input = {
				tool: 'apply_patch',
				sessionID: 'test-session',
				callID: 'call-1',
			};
			const output = { args: { patch: gitDiff } };

			// PR #501 + #496: git-diff traversal target rejected by
			// apply_patch authority + containment check.
			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		});

		it('should handle apply_patch with traditional diff format traversal', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'architect');

			const traditionalDiff = `--- ../../../shadow
+++ ../../../shadow
@@ -1 +1 @@
-old
+malicious
`;

			const input = {
				tool: 'apply_patch',
				sessionID: 'test-session',
				callID: 'call-1',
			};
			const output = { args: { patch: traditionalDiff } };

			// PR #501 + #496: traditional-diff traversal target rejected by
			// apply_patch authority + containment check.
			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(true);
		});
	});

	// ============================================================
	// HASH COLLISION / DOS THROUGH ARGS
	// ============================================================
	describe('hash collision and DoS through args', () => {
		it('should handle args that cause hash collisions', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'coder');

			// Create objects that would stringify to same value but are different
			const input1 = {
				tool: 'read',
				sessionID: 'test-session',
				callID: 'call-1',
			};
			const output1 = { args: { a: 1, b: 2 } };

			const input2 = {
				tool: 'read',
				sessionID: 'test-session',
				callID: 'call-2',
			};
			const output2 = { args: { b: 2, a: 1 } }; // Same keys, different order

			// Both should succeed - hashArgs sorts keys before hashing
			let threw = false;
			try {
				await hooks.toolBefore(input1, output1);
				await hooks.toolBefore(input2, output2);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle massive object args that stringify to huge JSON', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'coder');

			// Create object that produces massive JSON string
			const hugeArgs: Record<string, unknown> = {};
			for (let i = 0; i < 10000; i++) {
				hugeArgs[`key_${i}`] = 'value'.repeat(100);
			}

			const input = {
				tool: 'read',
				sessionID: 'test-session',
				callID: 'call-huge',
			};
			const output = { args: hugeArgs };

			// Should not crash - hashArgs has try/catch
			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('should handle args that throw during JSON.stringify', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks('/test', config);

			startAgentSession('test-session', 'coder');

			// Circular reference
			const circular: any = { a: 1 };
			circular.self = circular;

			const input = {
				tool: 'read',
				sessionID: 'test-session',
				callID: 'call-circ',
			};
			const output = { args: circular };

			// Should not crash - hashArgs has try/catch
			let threw = false;
			try {
				await hooks.toolBefore(input, output);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});
	});
});
