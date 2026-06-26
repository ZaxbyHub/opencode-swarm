/**
 * scope-guard-mixed-args.test.ts
 *
 * Regression tests for the first-match-wins bypass fix in scope-guard hook.
 *
 * PRIOR BUG (F#): When both a single-string path key (path/filePath/file) AND
 * an array key (files/paths/targetFiles) were present in args, only the single-string
 * path was validated and the array was silently ignored. An attacker could bypass
 * scope by putting an in-scope path in `path` and out-of-scope paths in `files[]`.
 *
 * FIX: Both single-string AND array paths are now collected into candidatePaths and
 * ALL are validated. The first violation throws, blocking the tool call.
 *
 * These tests verify the fix covers ALL 6 bypass scenarios:
 * 1. Mixed args: path in-scope + files[] out-of-scope → VIOLATION
 * 2. Mixed args: filePath out-of-scope + paths[] in-scope → VIOLATION
 * 3. Multiple arrays: files[] in-scope + targetFiles[] out-of-scope → VIOLATION
 * 4. All paths in-scope across all keys → no violation
 * 5. Empty arrays alongside valid single path → no false violation
 * 6. Non-string array elements are safely skipped
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ensureAgentSession, resetSwarmState, swarmState } from '../state';
import { createScopeGuardHook } from './scope-guard';

const SESSION_ID = 'test-session-mixed-args';
const WORKSPACE_DIR = '/workspace';

describe('scope-guard mixed-args bypass — regression: first-match-wins bypass (F#)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// ─────────────────────────────────────────────────────────────
	// Verification 1: Mixed args — path IN-SCOPE + files[] OUT-OF-SCOPE
	// This is the PRIMARY bypass: attacker uses in-scope path + out-of-scope array
	// ─────────────────────────────────────────────────────────────
	it('1. Mixed args: path in-scope + files[] out-of-scope → SCOPE VIOLATION is still reported', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		// Scope is limited to src/hooks
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// path is IN-scope, but files[] contains OUT-OF-scope paths
		// This was the bypass: old code only checked `path` and ignored `files[]`
		// Fix must check BOTH and report violation for the out-of-scope entry
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-bypass-1',
				},
				{
					args: {
						path: '/workspace/src/hooks/safe.ts', // in-scope (attacker uses this as "cover")
						files: [
							'/workspace/src/tools/evil.ts', // out-of-scope (bypass attempt)
						],
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});

	// ─────────────────────────────────────────────────────────────
	// Verification 2: Mixed args — filePath OUT-OF-SCOPE + paths[] IN-SCOPE
	// Reverse bypass: single is out-of-scope, array is in-scope
	// ─────────────────────────────────────────────────────────────
	it('2. Mixed args: filePath out-of-scope + paths[] in-scope → SCOPE VIOLATION is reported', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// filePath is out-of-scope, paths[] is all in-scope
		// Old bypass: if filePath was checked first and rejected, the loop might have
		// continued without checking paths[] (first-throw behavior used as excuse to skip rest)
		// Fix: check ALL paths, first violation thrown
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-bypass-2',
				},
				{
					args: {
						filePath: '/workspace/src/tools/evil.ts', // out-of-scope
						paths: ['/workspace/src/hooks/safe.ts'], // in-scope
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});

	// ─────────────────────────────────────────────────────────────
	// Verification 3: Multiple arrays — files[] IN-SCOPE + targetFiles[] OUT-OF-SCOPE
	// Bypass via multiple array keys with different scope membership
	// ─────────────────────────────────────────────────────────────
	it('3. Multiple array keys: files[] in-scope + targetFiles[] out-of-scope → SCOPE VIOLATION is reported', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// Both array keys are processed, but targetFiles[] has out-of-scope entry
		// Old code might have stopped after checking files[] successfully
		// Fix: iterate ALL array keys and ALL elements
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-bypass-3',
				},
				{
					args: {
						files: ['/workspace/src/hooks/safe.ts'], // all in-scope
						targetFiles: ['/workspace/src/tools/evil.ts'], // out-of-scope
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});

	// ─────────────────────────────────────────────────────────────
	// Verification 4: All paths in-scope across all keys — no violation
	// Legitimate use case: ensure fix doesn't cause false positives
	// ─────────────────────────────────────────────────────────────
	it('4. All paths in-scope across all keys → no violation', async () => {
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

		// All paths are within declared scope — should NOT throw
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-legit-1',
				},
				{
					args: {
						path: '/workspace/src/hooks/safe.ts',
						files: ['/workspace/src/hooks/another.ts'],
						targetFiles: ['/workspace/src/utils/helper.ts'],
					},
				},
			);
		}).not.toThrow();
	});

	it('4b. Multiple arrays all in-scope — no violation', async () => {
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
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-legit-2',
				},
				{
					args: {
						files: ['/workspace/src/hooks/safe.ts'],
						paths: ['/workspace/src/utils/helper.ts'],
						targetFiles: ['/workspace/src/hooks/also-safe.ts'],
					},
				},
			);
		}).not.toThrow();
	});

	// ─────────────────────────────────────────────────────────────
	// Verification 5: Empty arrays alongside valid single path — no false violation
	// Edge case: ensure empty array doesn't cause candidatePaths to be empty
	// and force early return when single path is valid
	// ─────────────────────────────────────────────────────────────
	it('5. Empty arrays alongside valid single path → no false violation', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// path is valid, arrays are empty — should NOT throw
		// (candidatePaths will have the single path, validated successfully)
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-empty-1',
				},
				{
					args: {
						path: '/workspace/src/hooks/safe.ts',
						files: [],
						targetFiles: [],
					},
				},
			);
		}).not.toThrow();
	});

	it('5b. Empty files[] with in-scope path → no false violation', async () => {
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
					callID: 'call-empty-2',
				},
				{
					args: {
						files: [],
					},
				},
			);
		}).not.toThrow();
	});

	// ─────────────────────────────────────────────────────────────
	// Verification 6: Non-string array elements are safely skipped
	// Ensure type confusion (number, object, null) doesn't cause crash or bypass
	// ─────────────────────────────────────────────────────────────
	it('6. Non-string elements in array are safely skipped — number', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// Number elements should be skipped; valid string should be checked
		// All entries are in-scope → should NOT throw
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-type-1',
				},
				{
					args: {
						files: [42, '/workspace/src/hooks/safe.ts', null, { foo: 'bar' }],
					},
				},
			);
		}).not.toThrow();
	});

	it('6b. Non-string elements — out-of-scope valid string triggers violation', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// Non-string elements are skipped, but out-of-scope string should still trigger
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-type-2',
				},
				{
					args: {
						files: [null, 123, '/workspace/src/tools/evil.ts', undefined],
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});

	// ─────────────────────────────────────────────────────────────
	// Additional edge cases
	// ─────────────────────────────────────────────────────────────

	it('all three array keys present — second key has out-of-scope → violation', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// files[] and paths[] are in-scope, but targetFiles[] has out-of-scope
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-triple',
				},
				{
					args: {
						files: ['/workspace/src/hooks/a.ts'],
						paths: ['/workspace/src/hooks/b.ts'],
						targetFiles: ['/workspace/src/tools/evil.ts'],
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});

	it('single path is out-of-scope, arrays are empty → violation', async () => {
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
					callID: 'call-single-out',
				},
				{
					args: {
						path: '/workspace/src/tools/evil.ts',
						files: [],
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});

	it('both single-path key AND array key are out-of-scope → first detected violation thrown', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// Both are out-of-scope; whichever is checked first triggers the throw
		// The important thing is BOTH are checked, not just the single path
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-both-out',
				},
				{
					args: {
						path: '/workspace/src/tools/evil1.ts',
						files: ['/workspace/src/tools/evil2.ts'],
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION/);
	});

	// ─────────────────────────────────────────────────────────────
	// swarm_apply_patch — renamed tool must also be guarded
	// ─────────────────────────────────────────────────────────────

	it('swarm_apply_patch: out-of-scope files[] triggers SCOPE VIOLATION', async () => {
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
					tool: 'swarm_apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-swarm-out',
				},
				{
					args: {
						files: ['/workspace/src/tools/evil.ts'],
					},
				},
			);
		}).toThrow(/SCOPE VIOLATION.*src\/tools\/evil\.ts/);
	});

	it('swarm_apply_patch: in-scope files[] does not trigger violation', async () => {
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
					tool: 'swarm_apply_patch',
					sessionID: SESSION_ID,
					callID: 'call-swarm-in',
				},
				{
					args: {
						files: ['/workspace/src/hooks/safe.ts'],
					},
				},
			);
		}).not.toThrow();
	});
});
