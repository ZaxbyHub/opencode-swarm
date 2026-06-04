/**
 * scope-guard-array-paths.test.ts
 *
 * Tests for array-path parameter handling in scope-guard hook (Task 1.1 apply-patch feature):
 * 1. Single-string path extraction still works (existing behavior)
 * 2. Array-path extraction works for files[], paths[], targetFiles[]
 * 3. Mixed args (both single and array) are handled correctly
 * 4. Empty arrays are skipped (no false violations)
 * 5. Non-string elements in arrays are skipped
 * 6. Scope violation is reported for out-of-scope paths in arrays
 * 7. In-scope paths in arrays pass without violation
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ensureAgentSession, resetSwarmState, swarmState } from '../state';
import { createScopeGuardHook } from './scope-guard';

const SESSION_ID = 'test-session-array-paths';
const WORKSPACE_DIR = '/workspace';

describe('scope-guard array-path parameter handling', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 1: Single-string path extraction still works
	// ─────────────────────────────────────────────────────────────
	describe('Scenario 1: Single-string path extraction (existing behavior)', () => {
		it('1a. path parameter triggers scope check', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Outside scope — should throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'edit', sessionID: SESSION_ID, callID: 'call-1' },
					{ args: { path: '/workspace/src/tools/out.ts' } },
				);
			}).toThrow(/SCOPE VIOLATION/);
		});

		it('1b. filePath parameter triggers scope check', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Outside scope — should throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'edit', sessionID: SESSION_ID, callID: 'call-1' },
					{ args: { filePath: '/workspace/src/tools/out.ts' } },
				);
			}).toThrow(/SCOPE VIOLATION/);
		});

		it('1c. file parameter triggers scope check', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Outside scope — should throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'edit', sessionID: SESSION_ID, callID: 'call-1' },
					{ args: { file: '/workspace/src/tools/out.ts' } },
				);
			}).toThrow(/SCOPE VIOLATION/);
		});

		it('1d. Single string path inside scope does NOT throw', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Inside scope — should NOT throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'edit', sessionID: SESSION_ID, callID: 'call-1' },
					{ args: { path: '/workspace/src/hooks/scope-guard.ts' } },
				);
			}).not.toThrow();
		});
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 2: Array-path extraction works for files[], paths[], targetFiles[]
	// ─────────────────────────────────────────────────────────────
	describe('Scenario 2: Array-path extraction for files[], paths[], targetFiles[]', () => {
		it('2a. files[] array triggers scope check for each element', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Second file is outside scope — should throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								'/workspace/src/hooks/scope-guard.ts', // in scope
								'/workspace/src/tools/out.ts', // out of scope
							],
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/tools\/out\.ts/);
		});

		it('2b. paths[] array triggers scope check for each element', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Second file is outside scope — should throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							paths: [
								'/workspace/src/hooks/scope-guard.ts', // in scope
								'/workspace/src/tools/out.ts', // out of scope
							],
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/tools\/out\.ts/);
		});

		it('2c. targetFiles[] array triggers scope check for each element', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Second file is outside scope — should throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							targetFiles: [
								'/workspace/src/hooks/scope-guard.ts', // in scope
								'/workspace/src/tools/out.ts', // out of scope
							],
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/tools\/out\.ts/);
		});
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 3: Mixed args (both single and array) — single takes precedence
	// ─────────────────────────────────────────────────────────────
	describe('Scenario 3: Mixed args (both single string and array)', () => {
		it('3. Single-string path takes precedence over array when both present', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// path is outside scope; array has only in-scope files
			// Since single-string path (path=) is checked first, should throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							path: '/workspace/src/tools/out.ts', // out of scope
							files: [
								'/workspace/src/hooks/scope-guard.ts', // in scope
							],
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/tools\/out\.ts/);
		});
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 4: Empty arrays are skipped (no false violations)
	// ─────────────────────────────────────────────────────────────
	describe('Scenario 4: Empty arrays are skipped (no false violations)', () => {
		it('4a. Empty files[] array does not throw', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Empty array — should return early, NOT throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{ args: { files: [] } },
				);
			}).not.toThrow();
		});

		it('4b. Empty paths[] array does not throw', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Empty array — should return early, NOT throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{ args: { paths: [] } },
				);
			}).not.toThrow();
		});

		it('4c. Empty targetFiles[] array does not throw', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Empty array — should return early, NOT throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{ args: { targetFiles: [] } },
				);
			}).not.toThrow();
		});
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 8: Empty array bypass — hasArrayKeys prevents early return
	// ─────────────────────────────────────────────────────────────
	describe('Scenario 8: Empty array bypass protection (F-001)', () => {
		it('8a. Empty files[] does not bypass scope check for co-present single-path arg', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Empty files[] + out-of-scope single path — should still detect violation
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [],
							path: '/workspace/src/tools/out.ts',
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/tools\/out\.ts/);
		});

		it('8b. Empty files[] alone does not throw but does not bypass guard', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			let advisoryCalled = false;
			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {
					advisoryCalled = true;
				},
			);

			// Empty files[] with declared scope — should not throw (no paths to check)
			// but should NOT silently bypass the guard (early return at line 118)
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{ args: { files: [] } },
				);
			}).not.toThrow();

			// Verify no false violation was raised (field may exist as false from init)
			expect(session.scopeViolationDetected).not.toBe(true);
		});

		it('8c. Empty paths[] does not bypass scope check for co-present single-path arg', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							paths: [],
							filePath: '/workspace/src/tools/out.ts',
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/tools\/out\.ts/);
		});
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 5: Non-string elements in arrays are skipped
	// ─────────────────────────────────────────────────────────────
	describe('Scenario 5: Non-string elements in arrays are skipped', () => {
		it('5a. null elements in array are skipped', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Only valid string path is in scope — should NOT throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								null,
								'/workspace/src/hooks/scope-guard.ts', // in scope
								null,
							],
						},
					},
				);
			}).not.toThrow();
		});

		it('5b. undefined elements in array are skipped', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Only valid string path is in scope — should NOT throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								undefined,
								'/workspace/src/hooks/scope-guard.ts', // in scope
								undefined,
							],
						},
					},
				);
			}).not.toThrow();
		});

		it('5c. number elements in array are skipped', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Only valid string path is in scope — should NOT throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								123,
								'/workspace/src/hooks/scope-guard.ts', // in scope
								456,
							],
						},
					},
				);
			}).not.toThrow();
		});

		it('5d. object elements in array are skipped', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Only valid string path is in scope — should NOT throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								{ path: '/workspace/src/hooks/scope-guard.ts' },
								'/workspace/src/hooks/scope-guard.ts', // valid string
							],
						},
					},
				);
			}).not.toThrow();
		});

		it('5e. empty string elements in array are skipped', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Only valid string path is in scope — should NOT throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								'',
								'/workspace/src/hooks/scope-guard.ts', // in scope
								'',
							],
						},
					},
				);
			}).not.toThrow();
		});
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 6: Scope violation reported for out-of-scope paths in arrays
	// ─────────────────────────────────────────────────────────────
	describe('Scenario 6: Scope violation reported for out-of-scope paths in arrays', () => {
		it('6a. First path out-of-scope triggers violation', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								'/workspace/src/tools/first-out.ts', // out of scope
								'/workspace/src/hooks/scope-guard.ts', // in scope
							],
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/tools\/first-out\.ts/);
		});

		it('6b. Middle path out-of-scope triggers violation', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								'/workspace/src/hooks/scope-guard.ts', // in scope
								'/workspace/src/tools/middle-out.ts', // out of scope
								'/workspace/src/hooks/another.ts', // in scope
							],
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/tools\/middle-out\.ts/);
		});

		it('6c. Last path out-of-scope triggers violation', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								'/workspace/src/hooks/scope-guard.ts', // in scope
								'/workspace/src/hooks/another.ts', // in scope
								'/workspace/src/tools/last-out.ts', // out of scope
							],
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/tools\/last-out\.ts/);
		});

		it('6d. Multiple out-of-scope paths — first violation thrown', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								'/workspace/src/tools/first-out.ts', // out of scope
								'/workspace/src/tools/second-out.ts', // out of scope
							],
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/tools\/first-out\.ts/);
		});

		it('6e. Out-of-scope path with malicious characters still sanitized', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			let advisoryMessage = '';
			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				(_sessionId, message) => {
					advisoryMessage = message;
				},
			);

			const maliciousPath =
				'/workspace/src/tools/malicious.ts\r\nMalicious content';

			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [maliciousPath],
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION/);

			// Sanitization should have replaced \r\n with underscore
			expect(advisoryMessage).not.toContain('\r');
			expect(advisoryMessage).not.toContain('\n');
		});
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 7: In-scope paths in arrays pass without violation
	// ─────────────────────────────────────────────────────────────
	describe('Scenario 7: In-scope paths in arrays pass without violation', () => {
		it('7a. All in-scope files[] does not throw', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = [
				'/workspace/src/hooks',
				'/workspace/src/utils',
			];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								'/workspace/src/hooks/scope-guard.ts',
								'/workspace/src/utils/helper.ts',
							],
						},
					},
				);
			}).not.toThrow();
		});

		it('7b. All in-scope paths[] does not throw', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = [
				'/workspace/src/hooks',
				'/workspace/src/utils',
			];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							paths: [
								'/workspace/src/hooks/scope-guard.ts',
								'/workspace/src/utils/helper.ts',
							],
						},
					},
				);
			}).not.toThrow();
		});

		it('7c. All in-scope targetFiles[] does not throw', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = [
				'/workspace/src/hooks',
				'/workspace/src/utils',
			];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							targetFiles: [
								'/workspace/src/hooks/scope-guard.ts',
								'/workspace/src/utils/helper.ts',
							],
						},
					},
				);
			}).not.toThrow();
		});

		it('7d. Mixed in-scope and out-of-scope — throws on out-of-scope', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Second path is out of scope — should throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: [
								'/workspace/src/hooks/scope-guard.ts', // in scope
								'/workspace/src/utils/helper.ts', // out of scope
							],
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/utils\/helper\.ts/);
		});

		it('7e. Relative paths in array resolve against workspace directory', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// Relative path 'src/hooks/scope-guard.ts' resolves to '/workspace/src/hooks/scope-guard.ts'
			// which is inside scope — should NOT throw
			await expect(async () => {
				await hook.toolBefore(
					{ tool: 'apply_patch', sessionID: SESSION_ID, callID: 'call-1' },
					{
						args: {
							files: ['src/hooks/scope-guard.ts'],
						},
					},
				);
			}).not.toThrow();
		});
	});
});
