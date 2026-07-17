/**
 * scope-guard.test.ts
 *
 * Tests for scope-guard hook (Task 3.1):
 * 1. Returns early (no throw) when guard is disabled (config.enabled = false)
 * 2. Returns early when tool is not in WRITE_TOOLS set (e.g., 'read')
 * 3. Returns early when session is the architect (agentName = 'Architect')
 * 4. Returns early when declaredCoderScope is null (no scope declared)
 * 5. Throws 'SCOPE VIOLATION' when non-architect writes file outside declared scope
 * 6. Does NOT throw when non-architect writes file INSIDE declared scope
 * 7. Sanitizes path with \r\n to prevent log injection (SEC-1 fix)
 * 8. isFileInScope correctly handles exact match and directory containment
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { installScopeGuardBindingSeam } from '../../tests/helpers/scope-guard-binding-seam';
import { ensureAgentSession, resetSwarmState, swarmState } from '../state';
import { pendingCoderScopeByTaskId } from './delegation-gate';
import {
	createScopeGuardHook,
	isFileInScope,
	_internals as scopeGuardInternals,
} from './scope-guard';

const SESSION_ID = 'test-session-scope-guard';
const ARCHITECT_SESSION_ID = 'architect-session';
const WORKSPACE_DIR = '/workspace';

describe('scope-guard hook (Task 3.1)', () => {
	let restoreScopeBindingSeam: (() => void) | undefined;
	beforeEach(() => {
		resetSwarmState();
		restoreScopeBindingSeam = installScopeGuardBindingSeam(
			scopeGuardInternals,
			(taskId) => pendingCoderScopeByTaskId.get(taskId) ?? null,
		);
	});

	afterEach(() => {
		restoreScopeBindingSeam?.();
		resetSwarmState();
	});

	// ─────────────────────────────────────────────────────────────
	// Test 1: Returns early when guard is disabled
	// ─────────────────────────────────────────────────────────────
	it('1. Returns early (no throw) when guard is disabled (config.enabled = false)', async () => {
		const hook = createScopeGuardHook(
			{ enabled: false },
			WORKSPACE_DIR,
			() => {},
		);

		// Should NOT throw even with out-of-scope write
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'edit',
					sessionID: SESSION_ID,
					callID: 'call-1',
				},
				{ args: { path: '/workspace/outside.ts' } },
			);
		}).not.toThrow();
	});

	// ─────────────────────────────────────────────────────────────
	// Test 2: Returns early when tool is not in WRITE_TOOLS
	// ─────────────────────────────────────────────────────────────
	it('2. Returns early when tool is not in WRITE_TOOLS set (e.g., read)', async () => {
		ensureAgentSession(SESSION_ID, 'coder');

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// 'read' is not a write tool — should return early
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'read',
					sessionID: SESSION_ID,
					callID: 'call-1',
				},
				{ args: { path: '/workspace/any-file.ts' } },
			);
		}).not.toThrow();
	});

	// ─────────────────────────────────────────────────────────────
	// Test 3: Returns early when session is the architect
	// ─────────────────────────────────────────────────────────────
	it('3. Returns early when session is the architect (agentName = Architect)', async () => {
		// Create a session with architect identity
		ensureAgentSession(ARCHITECT_SESSION_ID, 'Architect');

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// Architect editing should be allowed (no throw)
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'edit',
					sessionID: ARCHITECT_SESSION_ID,
					callID: 'call-1',
				},
				{ args: { path: '/workspace/any-file.ts' } },
			);
		}).not.toThrow();
	});

	// ─────────────────────────────────────────────────────────────
	// Test 4: Returns early when declaredCoderScope is null
	// ─────────────────────────────────────────────────────────────
	it('4. Blocks when no identity-bound scope is declared', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		// Ensure declaredCoderScope is null (default)
		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.declaredCoderScope).toBeNull();

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// No scope declared — should allow
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'edit',
					sessionID: SESSION_ID,
					callID: 'call-1',
				},
				{ args: { path: '/workspace/any-file.ts' } },
			);
		}).toThrow(/SCOPE_NOT_DECLARED/);
	});

	// ─────────────────────────────────────────────────────────────
	// Test 5: Throws SCOPE VIOLATION for out-of-scope write
	// ─────────────────────────────────────────────────────────────
	it('5. Throws SCOPE VIOLATION when non-architect writes file outside declared scope', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		// Set declared scope to a specific directory
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// Writing outside scope should throw
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'edit',
					sessionID: SESSION_ID,
					callID: 'call-1',
				},
				{ args: { path: '/workspace/src/tools/some-file.ts' } },
			);
		}).toThrow(/SCOPE VIOLATION/);
	});

	// ─────────────────────────────────────────────────────────────
	// Test 6: Does NOT throw when writing inside declared scope
	// ─────────────────────────────────────────────────────────────
	it('6. Does NOT throw when non-architect writes file INSIDE declared scope', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		// Set declared scope to a specific directory
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

		// Writing inside scope should NOT throw
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'edit',
					sessionID: SESSION_ID,
					callID: 'call-1',
				},
				{ args: { path: '/workspace/src/hooks/scope-guard.ts' } },
			);
		}).not.toThrow();
	});

	// ─────────────────────────────────────────────────────────────
	// Test 7 (CRIT-1): Fallback to pendingCoderScopeByTaskId when declaredCoderScope is null
	// ─────────────────────────────────────────────────────────────
	it('7 (CRIT-1). Falls back to pendingCoderScopeByTaskId when declaredCoderScope is null', async () => {
		// This test verifies the CRIT-1 fix: when a coder session exists but its
		// declaredCoderScope is null (cross-session scenario), scope-guard should
		// fall back to the pendingCoderScopeByTaskId Map using the currentTaskId.

		const CODERSESSION_ID = 'coder-session-fallback-test';
		const TASK_ID = '1.3';

		// Ensure the coder session exists with null declaredCoderScope
		ensureAgentSession(CODERSESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(CODERSESSION_ID)!;
		expect(session.declaredCoderScope).toBeNull();

		// Set currentTaskId to match the Map key
		session.currentTaskId = TASK_ID;

		// Seed the fallback Map with scope for task 1.3
		pendingCoderScopeByTaskId.set(TASK_ID, [
			'/workspace/src/hooks/scope-guard.ts',
		]);

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// Test 7a: File INSIDE fallback scope — should NOT throw
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'edit',
					sessionID: CODERSESSION_ID,
					callID: 'call-fallback-1',
				},
				{ args: { path: '/workspace/src/hooks/scope-guard.ts' } },
			);
		}).not.toThrow();

		// Test 7b: File OUTSIDE fallback scope — should throw SCOPE VIOLATION
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'edit',
					sessionID: CODERSESSION_ID,
					callID: 'call-fallback-2',
				},
				{ args: { path: '/workspace/src/tools/other.ts' } },
			);
		}).toThrow(/SCOPE VIOLATION/);

		// Cleanup: remove the Map entry
		pendingCoderScopeByTaskId.delete(TASK_ID);
	});

	// ─────────────────────────────────────────────────────────────
	// Test 7b (CRIT-1): No fallback when currentTaskId does not match Map key
	// ─────────────────────────────────────────────────────────────
	it('7b (CRIT-1). No fallback entry fails closed', async () => {
		// When currentTaskId is set but has no entry in pendingCoderScopeByTaskId,
		// the guard should return early (allow) since scope resolves to null.

		const CODERSESSION_ID = 'coder-session-no-map-entry';
		const TASK_ID = '9.9'; // Task ID with no Map entry

		ensureAgentSession(CODERSESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(CODERSESSION_ID)!;
		expect(session.declaredCoderScope).toBeNull();
		session.currentTaskId = TASK_ID;

		// Ensure the Map does NOT have an entry for this task
		expect(pendingCoderScopeByTaskId.has(TASK_ID)).toBe(false);

		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			() => {},
		);

		// No scope in Map — should return early (allow any file)
		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'edit',
					sessionID: CODERSESSION_ID,
					callID: 'call-no-map-entry',
				},
				{ args: { path: '/workspace/any/file.ts' } },
			);
		}).toThrow(/SCOPE_NOT_DECLARED/);
	});

	// ─────────────────────────────────────────────────────────────
	// Test 8: Sanitizes path with \r\n to prevent log injection (SEC-1 fix)
	// ─────────────────────────────────────────────────────────────
	it('8. Sanitizes path with \\r\\n to prevent log injection (SEC-1 fix)', async () => {
		ensureAgentSession(SESSION_ID, 'coder');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.declaredCoderScope = ['/workspace/src/hooks'];

		// Track what advisory would be injected
		let advisoryMessage = '';
		const hook = createScopeGuardHook(
			{ enabled: true },
			WORKSPACE_DIR,
			(_sessionId, message) => {
				advisoryMessage = message;
			},
		);

		// Inject CR/LF characters to test sanitization
		const maliciousPath = '/workspace/src/tools/file.ts\r\nMalicious content';

		await expect(async () => {
			await hook.toolBefore(
				{
					tool: 'edit',
					sessionID: SESSION_ID,
					callID: 'call-1',
				},
				{ args: { path: maliciousPath } },
			);
		}).toThrow(/WRITE TARGET UNVERIFIABLE/);

		// The violation message should have \r\n replaced with underscore
		// to prevent log injection attacks
		expect(advisoryMessage).toBe('');
	});

	// ─────────────────────────────────────────────────────────────
	// Test 9: isFileInScope handles exact match and directory containment
	// ─────────────────────────────────────────────────────────────
	describe('isFileInScope', () => {
		it('9a. Returns true for exact file match', () => {
			const scope = ['/workspace/src/hooks/scope-guard.ts'];
			expect(isFileInScope('/workspace/src/hooks/scope-guard.ts', scope)).toBe(
				true,
			);
		});

		it('9b. Returns true for file inside directory scope', () => {
			const scope = ['/workspace/src/hooks'];
			expect(isFileInScope('/workspace/src/hooks/scope-guard.ts', scope)).toBe(
				true,
			);
		});

		it('9c. Returns false for file outside directory scope', () => {
			const scope = ['/workspace/src/hooks'];
			expect(isFileInScope('/workspace/src/tools/scope-guard.ts', scope)).toBe(
				false,
			);
		});

		it('9d. Handles path.normalize for nested directories', () => {
			const scope = ['/workspace/src'];
			expect(isFileInScope('/workspace/src/hooks/scope-guard.ts', scope)).toBe(
				true,
			);
			expect(isFileInScope('/workspace/src/deep/nested/file.ts', scope)).toBe(
				true,
			);
		});

		it('9e. Returns false for parent directory traversal', () => {
			const scope = ['/workspace/src/hooks'];
			// File is outside scope via ..
			expect(isFileInScope('/workspace/src/../other/file.ts', scope)).toBe(
				false,
			);
		});

		it('9f. Resolves relative file path against directory parameter', () => {
			// When directory is '/workspace', 'src/foo.ts' resolves to '/workspace/src/foo.ts'
			// which is inside scope ['/workspace/src']
			const scope = ['/workspace/src'];
			expect(isFileInScope('src/foo.ts', scope, '/workspace')).toBe(true);
		});

		it('9g. Resolves relative file path against different directory returns false', () => {
			// When directory is '/other', 'src/foo.ts' resolves to '/other/src/foo.ts'
			// which is NOT inside scope ['/workspace/src']
			const scope = ['/workspace/src'];
			expect(isFileInScope('src/foo.ts', scope, '/other')).toBe(false);
		});

		it('9h. Falls back to process.cwd() when directory not provided', () => {
			// Without directory, resolves relative to process.cwd()
			const cwd = process.cwd();
			const scope = [cwd];
			// A file equal to scope entry should match
			expect(isFileInScope('.', scope)).toBe(true);
		});
	});
});
