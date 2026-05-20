/**
 * Task 5.2 Guardrails Modified Files Tracking — ADVERSARIAL SECURITY TESTS
 *
 * This test suite probes ATTACK VECTORS only for the modifiedFilesThisCoderTask feature.
 * Tests verify that malicious inputs, boundary violations, and edge cases are handled safely.
 *
 * Attack vectors probed:
 * 1. Null/undefined/0/{}/[]/Symbol injected in path fields
 * 2. Oversized payload (>10000 characters)
 * 3. Null byte injection (\x00)
 * 4. Memory stress (1000+ unique paths)
 * 5. subagent_type bypass attempts ('coder_evil', 'CODER', ' coder', 'coder ')
 * 6. Multi-session isolation
 * 7. delegationActive=true + architect=true edge case
 * 8. Non-string subagent_type values
 * 9. Task tool with no args
 * 10. Write tool with args as string instead of object
 * 11. Path with only whitespace
 */

import { beforeEach, describe, expect, it } from 'bun:test';
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
		max_tool_calls: 10000, // High limit for stress tests
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

describe('Task 5.2 Modified Files Tracking — ADVERSARIAL SECURITY TESTS', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	// ============================================================
	// ATTACK VECTOR 1: Null/undefined/0/{}/[]/Symbol in path fields
	// ============================================================
	describe('Attack Vector 1 — Null/undefined/0/{}/[]/Symbol in path fields', () => {
		const maliciousValues = [
			{ name: 'null', value: null },
			{ name: 'undefined', value: undefined },
			{ name: 'zero', value: 0 },
			{ name: 'empty object', value: {} },
			{ name: 'empty array', value: [] },
			{ name: 'number', value: 12345 },
			{ name: 'boolean true', value: true },
			{ name: 'boolean false', value: false },
			{ name: 'Symbol', value: Symbol('test') },
		];

		for (const { name, value } of maliciousValues) {
			it(`should not crash with ${name} in filePath`, async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(config);

				// Set up session as architect (to avoid circuit breaker)
				startAgentSession('session-1', 'architect');
				swarmState.activeAgent.set('session-1', 'architect');

				const input = makeInput('session-1', 'write', 'call-1');
				const output = { args: { filePath: value } };

				// Should not throw
				await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			});

			it(`should not add ${name} to modifiedFilesThisCoderTask`, async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(config);

				// Set up session with delegationActive=true (coder subagent)
				startAgentSession('session-1', 'coder');
				const session = getAgentSession('session-1');
				expect(session).toBeDefined();
				session!.delegationActive = true;

				const input = makeInput('session-1', 'write', 'call-1');
				const output = { args: { filePath: value } };

				await hooks.toolBefore(input, output);

				// Array should remain empty (no valid string path added)
				expect(session!.modifiedFilesThisCoderTask).toEqual([]);
			});
		}

		it('should handle all path field variations with null', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up as architect to avoid circuit breaker
			startAgentSession('session-1', 'architect');
			swarmState.activeAgent.set('session-1', 'architect');

			// Test all field priorities: filePath, path, file, target
			const variations = [
				{ args: { path: null } },
				{ args: { file: null } },
				{ args: { target: null } },
				{ args: { filePath: null, path: null } },
				{ args: { path: undefined } },
				{ args: { file: undefined } },
				{ args: { target: undefined } },
			];

			for (const output of variations) {
				await expect(
					hooks.toolBefore(makeInput('session-1', 'write', 'call-1'), output),
				).resolves.toBeUndefined();
			}
		});
	});

	// ============================================================
	// ATTACK VECTOR 2: Oversized payload (>10000 characters)
	// ============================================================
	describe('Attack Vector 2 — Oversized payload', () => {
		it('should fail-closed on 10000+ character path (lstat ENAMETOOLONG)', async () => {
			// Windows throws ENOENT (not ENAMETOOLONG) for overlong paths,
			// so the lstat guard does not block. Skip on Windows.
			if (process.platform === 'win32') return;

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Set up as architect to avoid circuit breaker
			startAgentSession('session-1', 'architect');
			swarmState.activeAgent.set('session-1', 'architect');

			const longPath = 'a'.repeat(15000);
			const input = makeInput('session-1', 'write', 'call-1');
			const output = { args: { filePath: longPath } };

			// PR #501: lstat on a path that triggers ENAMETOOLONG is converted
			// to a WRITE BLOCKED error instead of silently passing, so the
			// unverifiable path cannot reach the filesystem.
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'WRITE BLOCKED',
			);
		});

		it('should fail-closed when tracking 10000+ character path (lstat ENAMETOOLONG)', async () => {
			// Windows throws ENOENT (not ENAMETOOLONG) for overlong paths,
			// so the lstat guard does not block. Skip on Windows.
			if (process.platform === 'win32') return;

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			const longPath = 'src/' + 'a'.repeat(14996);
			const input = makeInput('session-1', 'write', 'call-1');
			const output = { args: { filePath: longPath } };

			// PR #501: oversized paths trip the lstat guard in the transparent
			// write path (ENAMETOOLONG → WRITE BLOCKED). Delegated-write
			// tracking runs earlier and may record the path before the guard
			// throws — that's benign because the throw aborts the write.
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'WRITE BLOCKED',
			);
		});

		it('should fail-closed on sequence of large paths (lstat ENAMETOOLONG)', async () => {
			// Windows throws ENOENT (not ENAMETOOLONG) for overlong paths,
			// so the lstat guard does not block. Skip on Windows.
			if (process.platform === 'win32') return;

			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			// PR #501: each oversized path is rejected by the lstat guard.
			for (let i = 0; i < 5; i++) {
				const longPath = `src/file${i}.ts`.padEnd(5000, 'x');
				await expect(
					hooks.toolBefore(makeInput('session-1', 'write', `call-${i}`), {
						args: { filePath: longPath },
					}),
				).rejects.toThrow('WRITE BLOCKED');
			}

			// Session remains defined — the guard throws synchronously inside
			// toolBefore without corrupting agent state.
			expect(session).toBeDefined();
		});
	});

	// ============================================================
	// ATTACK VECTOR 3: Null byte injection
	// ============================================================
	describe('Attack Vector 3 — Null byte injection', () => {
		it('should reject path with null byte (lstat fail-closed)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			const pathWithNullByte = 'src/file\x00.ts';
			const input = makeInput('session-1', 'write', 'call-1');
			const output = { args: { filePath: pathWithNullByte } };

			// PR #501: paths containing null bytes fail the lstat guard (node
			// rejects null-byte paths with ERR_INVALID_ARG_VALUE) which is
			// converted to a WRITE BLOCKED error. The delegated-write tracker
			// may record the path before the guard fires; the throw still
			// aborts the write.
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				'WRITE BLOCKED',
			);
			expect(session).toBeDefined();
		});

		it('should reject path with multiple null bytes (lstat fail-closed)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			const pathWithNulls = 'src/a\x00b\x00c\x00d.ts';

			// PR #501: multi-null-byte paths are likewise rejected by the
			// lstat guard.
			await expect(
				hooks.toolBefore(makeInput('session-1', 'write', 'call-1'), {
					args: { filePath: pathWithNulls },
				}),
			).rejects.toThrow('WRITE BLOCKED');

			expect(session).toBeDefined();
		});
	});

	// ============================================================
	// ATTACK VECTOR 4: Memory stress (1000+ unique paths)
	// ============================================================
	describe('Attack Vector 4 — Memory stress (1000+ unique paths)', () => {
		it('should handle 1000+ unique paths without crashing', async () => {
			// Use custom profile to override coder limits
			const config = defaultConfig({
				profiles: { coder: { max_tool_calls: 5000, warning_threshold: 0.9 } },
			});
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			// Add 1000 unique paths
			for (let i = 0; i < 1000; i++) {
				await hooks.toolBefore(makeInput('session-1', 'write', `call-${i}`), {
					args: { filePath: `src/file${i}.ts` },
				});
			}

			// Should not crash - all should be added
			expect(session!.modifiedFilesThisCoderTask).toHaveLength(1000);
		});

		it('should handle rapid additions efficiently', async () => {
			const config = defaultConfig({
				profiles: { coder: { max_tool_calls: 2000, warning_threshold: 0.9 } },
			});
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			const startTime = Date.now();

			// Add 500 paths
			for (let i = 0; i < 500; i++) {
				await hooks.toolBefore(makeInput('session-1', 'write', `call-${i}`), {
					args: { filePath: `src/file${i}.ts` },
				});
			}

			const duration = Date.now() - startTime;

			// Should complete in reasonable time (< 5 seconds)
			expect(duration).toBeLessThan(5000);
			expect(session!.modifiedFilesThisCoderTask).toHaveLength(500);
		});
	});

	// ============================================================
	// ATTACK VECTOR 5: subagent_type bypass attempts
	// ============================================================
	describe('Attack Vector 5 — subagent_type bypass attempts', () => {
		const bypassAttempts = [
			{ name: 'coder_evil', value: 'coder_evil', shouldReset: false },
			{ name: 'CODER (uppercase)', value: 'CODER', shouldReset: false },
			{ name: 'coder with prefix space', value: ' coder', shouldReset: false },
			{ name: 'coder with suffix space', value: 'coder ', shouldReset: false },
			{ name: 'coder with both spaces', value: ' coder ', shouldReset: false },
			{ name: 'c0der (zero substitution)', value: 'c0der', shouldReset: false },
			{ name: 'cođer (unicode)', value: 'cođer', shouldReset: false },
			{ name: 'exact coder', value: 'coder', shouldReset: true },
			{ name: 'Coder (capitalized)', value: 'Coder', shouldReset: false },
		];

		for (const { name, value, shouldReset } of bypassAttempts) {
			it(`subagent_type='${name}' should ${shouldReset ? '' : 'NOT '}reset array`, async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(config);

				// Set up architect session
				startAgentSession('architect-session', 'architect');
				swarmState.activeAgent.set('architect-session', 'architect');

				// Pre-populate the modified files array
				const session = getAgentSession('architect-session');
				session!.modifiedFilesThisCoderTask = ['pre-existing-file.ts'];

				// Simulate Task tool call from architect
				const input = makeInput('architect-session', 'Task', 'call-1');
				const output = { args: { subagent_type: value } };

				await hooks.toolBefore(input, output);

				if (shouldReset) {
					expect(session!.modifiedFilesThisCoderTask).toEqual([]);
				} else {
					// Should NOT reset - array should remain unchanged
					expect(session!.modifiedFilesThisCoderTask).toEqual([
						'pre-existing-file.ts',
					]);
				}
			});
		}
	});

	// ============================================================
	// ATTACK VECTOR 6: Multi-session isolation
	// ============================================================
	describe('Attack Vector 6 — Multi-session isolation', () => {
		it('should keep sessions isolated', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Create two separate sessions
			startAgentSession('session-1', 'coder');
			startAgentSession('session-2', 'coder');

			const session1 = getAgentSession('session-1');
			const session2 = getAgentSession('session-2');

			session1!.delegationActive = true;
			session2!.delegationActive = true;

			// Add files to session 1
			await hooks.toolBefore(makeInput('session-1', 'write', 'call-1'), {
				args: { filePath: 'src/session1-file.ts' },
			});

			// Add files to session 2
			await hooks.toolBefore(makeInput('session-2', 'write', 'call-2'), {
				args: { filePath: 'src/session2-file.ts' },
			});

			// Each session should have its own files
			expect(session1!.modifiedFilesThisCoderTask).toEqual([
				'src/session1-file.ts',
			]);
			expect(session2!.modifiedFilesThisCoderTask).toEqual([
				'src/session2-file.ts',
			]);
		});

		it('should isolate reset operations between sessions', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Create architect session
			startAgentSession('architect-session', 'architect');
			swarmState.activeAgent.set('architect-session', 'architect');
			const architectSession = getAgentSession('architect-session');
			architectSession!.modifiedFilesThisCoderTask = ['file1.ts', 'file2.ts'];

			// Create coder session with its own files
			startAgentSession('coder-session', 'coder');
			const coderSession = getAgentSession('coder-session');
			coderSession!.delegationActive = true;
			coderSession!.modifiedFilesThisCoderTask = ['coder-file.ts'];

			// Architect dispatches new coder task - should only reset architect's array
			await hooks.toolBefore(makeInput('architect-session', 'Task', 'call-1'), {
				args: { subagent_type: 'coder' },
			});

			// Architect's array should be reset
			expect(architectSession!.modifiedFilesThisCoderTask).toEqual([]);
			// Coder's array should be unaffected
			expect(coderSession!.modifiedFilesThisCoderTask).toEqual([
				'coder-file.ts',
			]);
		});
	});

	// ============================================================
	// ATTACK VECTOR 7: delegationActive=true + architect=true edge case
	// ============================================================
	describe('Attack Vector 7 — delegationActive + architect edge case', () => {
		it('should handle architect session with delegationActive flag', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Create architect session but with delegationActive=true (edge case)
			startAgentSession('edge-session', 'architect');
			swarmState.activeAgent.set('edge-session', 'architect');

			const session = getAgentSession('edge-session');
			session!.delegationActive = true; // Edge case: architect with delegationActive=true

			// Write tool call - the code checks delegationActive FIRST, so it will track
			await hooks.toolBefore(makeInput('edge-session', 'write', 'call-1'), {
				args: { filePath: 'some-file.ts' },
			});

			// Since delegationActive is checked first, file WILL be added
			expect(session!.modifiedFilesThisCoderTask).toEqual(['some-file.ts']);
		});

		it('should not crash with delegationActive + architect combo', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Create session with both flags
			startAgentSession('edge-session', 'architect');
			swarmState.activeAgent.set('edge-session', 'architect');

			const session = getAgentSession('edge-session');
			session!.delegationActive = true; // Edge case

			// Should not crash
			await expect(
				hooks.toolBefore(makeInput('edge-session', 'write', 'call-1'), {
					args: { filePath: 'test.ts' },
				}),
			).resolves.toBeUndefined();
		});
	});

	// ============================================================
	// ATTACK VECTOR 8: Non-string subagent_type values
	// ============================================================
	describe('Attack Vector 8 — Non-string subagent_type values', () => {
		const nonStringTypes = [
			{ name: 'number', value: 123 },
			{ name: 'boolean true', value: true },
			{ name: 'boolean false', value: false },
			{ name: 'object', value: { type: 'coder' } },
			{ name: 'array', value: ['coder'] },
			{ name: 'null', value: null },
			{ name: 'undefined', value: undefined },
		];

		for (const { name, value } of nonStringTypes) {
			it(`should not crash with subagent_type=${name}`, async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(config);

				startAgentSession('architect-session', 'architect');
				swarmState.activeAgent.set('architect-session', 'architect');

				const input = makeInput('architect-session', 'Task', 'call-1');
				const output = { args: { subagent_type: value } };

				// Should not throw
				await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			});

			it(`should not reset array with subagent_type=${name}`, async () => {
				const config = defaultConfig();
				const hooks = createGuardrailsHooks(config);

				startAgentSession('architect-session', 'architect');
				swarmState.activeAgent.set('architect-session', 'architect');

				const session = getAgentSession('architect-session');
				session!.modifiedFilesThisCoderTask = ['file1.ts', 'file2.ts'];

				const input = makeInput('architect-session', 'Task', 'call-1');
				const output = { args: { subagent_type: value } };

				await hooks.toolBefore(input, output);

				// Should NOT reset (only exact 'coder' string triggers reset)
				expect(session!.modifiedFilesThisCoderTask).toEqual([
					'file1.ts',
					'file2.ts',
				]);
			});
		}
	});

	// ============================================================
	// ATTACK VECTOR 9: Task tool with no args
	// ============================================================
	describe('Attack Vector 9 — Task tool with no args', () => {
		it('should not crash with missing args', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('architect-session', 'architect');
			swarmState.activeAgent.set('architect-session', 'architect');

			const session = getAgentSession('architect-session');
			session!.modifiedFilesThisCoderTask = ['file1.ts'];

			const input = makeInput('architect-session', 'Task', 'call-1');
			const output = { args: undefined };

			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			// Should not reset due to missing args
			expect(session!.modifiedFilesThisCoderTask).toEqual(['file1.ts']);
		});

		it('should not crash with empty args object', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('architect-session', 'architect');
			swarmState.activeAgent.set('architect-session', 'architect');

			const session = getAgentSession('architect-session');
			session!.modifiedFilesThisCoderTask = ['file1.ts'];

			const input = makeInput('architect-session', 'Task', 'call-1');
			const output = { args: {} };

			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			expect(session!.modifiedFilesThisCoderTask).toEqual(['file1.ts']);
		});

		it('should not crash with null args', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('architect-session', 'architect');
			swarmState.activeAgent.set('architect-session', 'architect');

			const session = getAgentSession('architect-session');
			session!.modifiedFilesThisCoderTask = ['file1.ts'];

			const input = makeInput('architect-session', 'Task', 'call-1');
			const output = { args: null };

			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			expect(session!.modifiedFilesThisCoderTask).toEqual(['file1.ts']);
		});
	});

	// ============================================================
	// ATTACK VECTOR 10: Write tool with args as string instead of object
	// ============================================================
	describe('Attack Vector 10 — Write tool with args as string', () => {
		it('should not crash with string args', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			// Use architect to avoid circuit breaker
			startAgentSession('session-1', 'architect');
			swarmState.activeAgent.set('session-1', 'architect');

			const input = makeInput('session-1', 'write', 'call-1');
			const output = { args: 'some random string' };

			// Should not throw
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		it('should not crash with number args', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'architect');
			swarmState.activeAgent.set('session-1', 'architect');

			const input = makeInput('session-1', 'write', 'call-1');
			const output = { args: 12345 };

			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		it('should not crash with array args', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'architect');
			swarmState.activeAgent.set('session-1', 'architect');

			const input = makeInput('session-1', 'write', 'call-1');
			const output = { args: ['file1.ts', 'file2.ts'] };

			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});

		it('should not add to array with invalid args structure', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			const input = makeInput('session-1', 'write', 'call-1');
			const output = { args: 'just a string' };

			await hooks.toolBefore(input, output);

			// Should not add anything (string doesn't have path fields)
			expect(session!.modifiedFilesThisCoderTask).toEqual([]);
		});
	});

	// ============================================================
	// ATTACK VECTOR 11: Path with only whitespace
	// ============================================================
	describe('Attack Vector 11 — Path with only whitespace', () => {
		// PR #501 + #496 (coder.allowedPrefix removal): coder no longer has a
		// positive-prefix whitelist, so whitespace-only paths are no longer
		// rejected by the authority check. They still resolve inside cwd and
		// do not escape the sandbox, so the hook records them and returns.
		// These tests previously asserted a WRITE BLOCKED throw; they now
		// assert the resolve-and-track path.
		it('should accept whitespace-only path (tracked, contained in cwd)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			const input = makeInput('session-1', 'write', 'call-1');
			const output = { args: { filePath: '   ' } };

			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			expect(session!.modifiedFilesThisCoderTask).toContain('   ');
		});

		it('should accept tab-only path (tracked, contained in cwd)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			const input = makeInput('session-1', 'write', 'call-1');
			const output = { args: { filePath: '\t\t' } };

			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			expect(session!.modifiedFilesThisCoderTask).toContain('\t\t');
		});

		it('should accept newline-only path (tracked, contained in cwd)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			const input = makeInput('session-1', 'write', 'call-1');
			const output = { args: { filePath: '\n\n' } };

			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			expect(session!.modifiedFilesThisCoderTask).toContain('\n\n');
		});

		it('should accept path with surrounding whitespace (tracked, contained in cwd)', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			const input = makeInput('session-1', 'write', 'call-1');
			const output = { args: { filePath: '  valid/path.ts  ' } };

			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
			expect(session!.modifiedFilesThisCoderTask).toContain(
				'  valid/path.ts  ',
			);
		});
	});

	// ============================================================
	// EDGE CASE: Duplicate path prevention
	// ============================================================
	describe('Edge Case — Duplicate path prevention', () => {
		it('should not add duplicate paths', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			// Add same file multiple times
			for (let i = 0; i < 5; i++) {
				await hooks.toolBefore(makeInput('session-1', 'write', `call-${i}`), {
					args: { filePath: 'src/same-file.ts' },
				});
			}

			// Should only have one entry
			expect(session!.modifiedFilesThisCoderTask).toEqual(['src/same-file.ts']);
		});

		it('should handle duplicates with different casing', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			// Add same file with different casing (JavaScript is case-sensitive)
			await hooks.toolBefore(makeInput('session-1', 'write', 'call-1'), {
				args: { filePath: 'src/File.ts' },
			});
			await hooks.toolBefore(makeInput('session-1', 'write', 'call-2'), {
				args: { filePath: 'src/file.ts' },
			});

			// Both should be added (case-sensitive)
			expect(session!.modifiedFilesThisCoderTask).toHaveLength(2);
		});
	});

	// ============================================================
	// EDGE CASE: Path field priority
	// ============================================================
	describe('Edge Case — Path field priority', () => {
		it('should use filePath over path', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			await hooks.toolBefore(makeInput('session-1', 'write', 'call-1'), {
				args: { filePath: 'src/from-filePath.ts', path: 'src/from-path.ts' },
			});

			expect(session!.modifiedFilesThisCoderTask).toEqual([
				'src/from-filePath.ts',
			]);
		});

		it('should use path over file', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			await hooks.toolBefore(makeInput('session-1', 'write', 'call-1'), {
				args: { path: 'src/from-path.ts', file: 'src/from-file.ts' },
			});

			expect(session!.modifiedFilesThisCoderTask).toEqual(['src/from-path.ts']);
		});

		it('should use file over target', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			await hooks.toolBefore(makeInput('session-1', 'write', 'call-1'), {
				args: { file: 'src/from-file.ts', target: 'src/from-target.ts' },
			});

			expect(session!.modifiedFilesThisCoderTask).toEqual(['src/from-file.ts']);
		});

		it('should fall back to target when others missing', async () => {
			const config = defaultConfig();
			const hooks = createGuardrailsHooks(config);

			startAgentSession('session-1', 'coder');
			const session = getAgentSession('session-1');
			session!.delegationActive = true;

			await hooks.toolBefore(makeInput('session-1', 'write', 'call-1'), {
				args: { target: 'src/from-target.ts' },
			});

			expect(session!.modifiedFilesThisCoderTask).toEqual([
				'src/from-target.ts',
			]);
		});
	});
});
