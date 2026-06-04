/**
 * scope-guard-single-path-keys.test.ts
 *
 * Targeted regression tests for the single-path multi-key iteration fix.
 *
 * PRIOR BUG: `argsObj?.path ?? argsObj?.filePath ?? argsObj?.file` used first-match-wins
 * semantics — only the first present key was validated. If `path` was in-scope but `filePath`
 * was out-of-scope, the guard passed because it never checked `filePath`.
 *
 * FIX: Iterates all three single-path keys (path, filePath, file), collects ALL string values
 * into candidatePaths[], and validates EVERY one. First out-of-scope detection throws.
 *
 * These tests verify all 7 scenarios:
 * 1.  path in-scope + filePath out-of-scope → SCOPE VIOLATION reported
 * 2.  path in-scope + file out-of-scope → SCOPE VIOLATION reported
 * 3.  filePath in-scope + file out-of-scope → SCOPE VIOLATION reported
 * 4.  All three single-path keys in-scope → no violation
 * 5.  All three single-path keys out-of-scope → VIOLATION on first detected
 * 6.  path out-of-scope + files[] in-scope → VIOLATION reported
 * 7.  Non-string values for single-path keys (null, undefined, number, object) → safely skipped
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ensureAgentSession, resetSwarmState, swarmState } from '../state';
import { createScopeGuardHook } from './scope-guard';

const SESSION_ID = 'test-session-single-path-keys';
const WORKSPACE_DIR = '/workspace';

describe('scope-guard single-path multi-key iteration — regression: first-match-wins bypass (F#)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 1: path in-scope + filePath out-of-scope → VIOLATION
	// This was the core bypass: old code stopped after `path` (in-scope → allow)
	// and never checked `filePath` (out-of-scope → should have blocked)
	// ─────────────────────────────────────────────────────────────
	it('1. path in-scope + filePath out-of-scope → SCOPE VIOLATION is reported', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// path is IN-scope (attacker uses this as cover), but filePath is OUT-OF-scope
		// Old first-match-wins: checked `path` only → passed → bypass!
		// Fix: iterates ALL three keys → filePath detected as out-of-scope → throw
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-sp-1',
				},
				{
					args: {
						path: '/workspace/src/hooks/safe.ts', // in-scope (cover)
						filePath: '/workspace/src/tools/evil.ts', // out-of-scope (bypass attempt)
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 2: path in-scope + file out-of-scope → VIOLATION
	// Same bypass pattern with `file` instead of `filePath`
	// ─────────────────────────────────────────────────────────────
	it('2. path in-scope + file out-of-scope → SCOPE VIOLATION is reported', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// path is in-scope (cover), file is out-of-scope (bypass attempt)
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-sp-2',
				},
				{
					args: {
						path: '/workspace/src/hooks/safe.ts', // in-scope (cover)
						file: '/workspace/src/tools/evil.ts', // out-of-scope (bypass attempt)
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 3: filePath in-scope + file out-of-scope → VIOLATION
	// ─────────────────────────────────────────────────────────────
	it('3. filePath in-scope + file out-of-scope → SCOPE VIOLATION is reported', async () => {
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
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-sp-3',
				},
				{
					args: {
						filePath: '/workspace/src/hooks/safe.ts', // in-scope (cover)
						file: '/workspace/src/tools/evil.ts', // out-of-scope (bypass attempt)
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 4: All three single-path keys in-scope → no violation
	// Legitimate multi-key usage with all paths valid
	// ─────────────────────────────────────────────────────────────
	it('4. All three single-path keys in-scope → no violation', async () => {
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

		// All three keys present, all in-scope → should NOT throw
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-sp-4',
				},
				{
					args: {
						path: '/workspace/src/hooks/a.ts', // in-scope
						filePath: '/workspace/src/hooks/b.ts', // in-scope
						file: '/workspace/src/utils/c.ts', // in-scope
					},
				},
			);
		}).not.toThrow();
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 5: All three single-path keys out-of-scope → VIOLATION on first detected
	// ─────────────────────────────────────────────────────────────
	it('5. All three single-path keys out-of-scope → first detected violation thrown', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// All three are out-of-scope; whichever is checked first triggers the throw
		// The important thing: ALL three are checked, not just the first
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-sp-5',
				},
				{
					args: {
						path: '/workspace/src/tools/evil1.ts', // out-of-scope
						filePath: '/workspace/src/tools/evil2.ts', // out-of-scope
						file: '/workspace/src/tools/evil3.ts', // out-of-scope
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION/);
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 6: path out-of-scope + files[] in-scope → VIOLATION reported
	// Mixed single-path and array keys; single-path out-of-scope should throw
	// ─────────────────────────────────────────────────────────────
	it('6. path out-of-scope + files[] in-scope → SCOPE VIOLATION is reported', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// Single-path key is out-of-scope (primary violation), array is in-scope
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-sp-6',
				},
				{
					args: {
						path: '/workspace/src/tools/evil.ts', // out-of-scope (primary violation)
						files: ['/workspace/src/hooks/safe.ts'], // in-scope (secondary)
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});

	// ─────────────────────────────────────────────────────────────
	// Scenario 7: Non-string values for single-path keys → safely skipped
	// Type confusion must not cause crash or bypass
	// ─────────────────────────────────────────────────────────────
	describe('Scenario 7: Non-string values for single-path keys are safely skipped', () => {
		it('7a. null value for filePath → safely skipped, in-scope path passes', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// null should be skipped; valid in-scope path should pass
			await expect(async () => {
				await hook.toolBefore(
					{
						tool: 'apply_patch',
						sessionID: SESSION_ID,
						callID: 'call-ns-1',
					},
					{
						args: {
							path: '/workspace/src/hooks/safe.ts', // in-scope (valid)
							filePath: null, // should be skipped
						},
					},
				);
			}).not.toThrow();
		});

		it('7b. undefined value for file → safely skipped, in-scope path passes', async () => {
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
					{
						tool: 'apply_patch',
						sessionID: SESSION_ID,
						callID: 'call-ns-2',
					},
					{
						args: {
							path: '/workspace/src/hooks/safe.ts', // in-scope (valid)
							file: undefined, // should be skipped
						},
					},
				);
			}).not.toThrow();
		});

		it('7c. number value for filePath → safely skipped, in-scope path passes', async () => {
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
					{
						tool: 'apply_patch',
						sessionID: SESSION_ID,
						callID: 'call-ns-3',
					},
					{
						args: {
							path: '/workspace/src/hooks/safe.ts', // in-scope (valid)
							filePath: 42, // should be skipped
						},
					},
				);
			}).not.toThrow();
		});

		it('7d. object value for file → safely skipped, in-scope path passes', async () => {
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
					{
						tool: 'apply_patch',
						sessionID: SESSION_ID,
						callID: 'call-ns-4',
					},
					{
						args: {
							path: '/workspace/src/hooks/safe.ts', // in-scope (valid)
							file: { path: '/workspace/src/tools/evil.ts' }, // object — should be skipped
						},
					},
				);
			}).not.toThrow();
		});

		it('7e. null in any single-path key + out-of-scope string in another → violation triggered', async () => {
			ensureAgentSession(SESSION_ID, 'coder');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.declaredCoderScope = ['/workspace/src/hooks'];

			const hook = createScopeGuardHook(
				{ enabled: true },
				WORKSPACE_DIR,
				() => {},
			);

			// nulls are skipped; the out-of-scope string triggers the violation
			await expect(async () => {
				await hook.toolBefore(
					{
						tool: 'apply_patch',
						sessionID: SESSION_ID,
						callID: 'call-ns-5',
					},
					{
						args: {
							path: null, // should be skipped
							filePath: '/workspace/src/tools/evil.ts', // out-of-scope — should throw
							file: undefined, // should be skipped
						},
					},
				);
			}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
		});
	});

	// ─────────────────────────────────────────────────────────────
	// Additional edge: only two keys present (path + file), file out-of-scope
	// ─────────────────────────────────────────────────────────────
	it('path in-scope + file out-of-scope (no filePath key present) → SCOPE VIOLATION', async () => {
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
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-sp-edge',
				},
				{
					args: {
						path: '/workspace/src/hooks/safe.ts', // in-scope (cover)
						file: '/workspace/src/tools/evil.ts', // out-of-scope (bypass attempt)
						// filePath key is absent entirely
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});
});
