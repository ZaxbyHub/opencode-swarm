/**
 * Guardrails safety tests for worktree isolation.
 *
 * Verifies three safety properties:
 * 1. git worktree remove --force is blocked by the destructive-command guardrails.
 * 2. removeWorktree never passes --force to its git subprocess.
 * 3. removeWorktree uses bounded retry on Windows EBUSY/EPERM (DD-10) and
 *    abandons (never falls back to --force).
 *
 * Uses the _internals DI seam pattern — no mock.module() calls.
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuardrailsConfig } from '../../../../src/config/schema';
import { createGuardrailsHooks } from '../../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../../src/state';
import {
	_internals,
	removeWorktree,
} from '../../../../src/turbo/lean/worktree';
import type { BunCompatSubprocess } from '../../../../src/utils/bun-compat';

// ---------------------------------------------------------------------------
// Test directory
// ---------------------------------------------------------------------------

const TEST_DIR = realpathSync(
	mkdtempSync(join(tmpdir(), 'guardrails-safety-')),
);

afterAll(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Guardrails test helpers
// ---------------------------------------------------------------------------

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
		block_destructive_commands: true,
		...overrides,
	};
}

function makeBashInput(sessionID = 'test-session', _command: string) {
	return { tool: 'bash', sessionID, callID: 'call-1' };
}

function makeBashOutput(command: string) {
	return { args: { command } };
}

// ---------------------------------------------------------------------------
// Worktree test helpers
// ---------------------------------------------------------------------------

/** Saves the real internals so tests can restore them in afterEach. */
const realBunSpawn = _internals.bunSpawn;
const realPlatform = _internals.platform;
const realSleep = _internals.sleep;

/**
 * Constructs a minimal BunCompatSubprocess mock.
 * exitCode, stdout, and stderr are configurable per test.
 */
function mockProc(
	exitCode: number,
	stdout = '',
	stderr = '',
): BunCompatSubprocess {
	return {
		exited: Promise.resolve(exitCode),
		exitCode,
		stdout: {
			text: () => Promise.resolve(stdout),
		} as unknown as BunCompatSubprocess['stdout'],
		stderr: {
			text: () => Promise.resolve(stderr),
		} as unknown as BunCompatSubprocess['stderr'],
		kill: () => {},
	} as BunCompatSubprocess;
}

// ---------------------------------------------------------------------------
// afterEach — restore all seams
// ---------------------------------------------------------------------------

afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
	_internals.platform = realPlatform;
	_internals.sleep = realSleep;
});

// ===========================================================================
// Test 1: git worktree remove --force is blocked by guardrails
// ===========================================================================

describe('guardrails: git worktree remove --force blocked', () => {
	beforeEach(() => {
		resetSwarmState();
		startAgentSession('test-session', 'coder');
	});

	test('git worktree remove --force <path> is blocked', async () => {
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = makeBashInput(
			'test-session',
			'git worktree remove --force /some/path',
		);
		const output = makeBashOutput('git worktree remove --force /some/path');
		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			/git worktree remove --force.*detected/,
		);
	});

	test('git worktree remove --force is blocked on Windows paths', async () => {
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = makeBashInput(
			'test-session',
			'git worktree remove --force C:\\worktrees\\lane-1',
		);
		const output = makeBashOutput(
			'git worktree remove --force C:\\worktrees\\lane-1',
		);
		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			/git worktree remove --force.*detected/,
		);
	});

	test('git worktree remove --FORCE (uppercase) is also blocked', async () => {
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = makeBashInput(
			'test-session',
			'git worktree remove --FORCE /some/path',
		);
		const output = makeBashOutput('git worktree remove --FORCE /some/path');
		await expect(hooks.toolBefore(input, output)).rejects.toThrow(
			/git worktree remove --force.*detected/i,
		);
	});

	test('git worktree remove without --force is NOT blocked', async () => {
		const config = defaultConfig();
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config);
		const input = makeBashInput(
			'test-session',
			'git worktree remove /some/path',
		);
		const output = makeBashOutput('git worktree remove /some/path');
		// Should NOT throw — no --force flag present
		await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
	});
});

// ===========================================================================
// Test 2: removeWorktree never uses --force
// ===========================================================================

describe('removeWorktree: never uses --force flag', () => {
	const fakeWorktreePath = join('C:', 'worktrees', 'session-abc', 'lane-1');
	const fakeProjectRoot = join('C:', 'project-root');

	test('removeWorktree spawn args never contain --force', async () => {
		const spawnCalls: string[][] = [];
		_internals.bunSpawn = (args: string[]) => {
			spawnCalls.push(args);
			return mockProc(0, '', '');
		};

		await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		// Find the git worktree remove call
		const worktreeCall = spawnCalls.find(
			(args) => args[0] === 'git' && args[1] === 'worktree',
		);
		expect(worktreeCall).toBeDefined();
		expect(worktreeCall).not.toContain('--force');
		expect(worktreeCall![2]).toBe('remove');
	});

	test('removeWorktree never emits --force across retry attempts', async () => {
		_internals.platform = 'win32';
		_internals.sleep = async () => {};

		const allSpawnArgs: string[][] = [];
		_internals.bunSpawn = (args: string[]) => {
			allSpawnArgs.push([...args]);
			return mockProc(1, '', 'EBUSY: resource busy');
		};

		await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		// Every git worktree remove call must lack --force
		for (const args of allSpawnArgs) {
			if (args[1] === 'worktree') {
				expect(args).not.toContain('--force');
			}
		}
		// Verify retry attempts actually happened
		const worktreeCalls = allSpawnArgs.filter((a) => a[1] === 'worktree');
		expect(worktreeCalls.length).toBe(4); // initial + 3 retries
	});
});

// ===========================================================================
// Test 3: removeWorktree bounded retry on Windows EBUSY/EPERM (DD-10)
// ===========================================================================

describe('removeWorktree: bounded retry on Windows (DD-10)', () => {
	const fakeWorktreePath = join('C:', 'worktrees', 'session-abc', 'lane-1');
	const fakeProjectRoot = join('C:', 'project-root');

	test('retries up to 3 times (4 total calls) on EBUSY then returns error', async () => {
		_internals.platform = 'win32';
		_internals.sleep = async () => {}; // no-op — skip real delays

		const sleepCalls: number[] = [];
		_internals.sleep = mock(async (ms: number) => {
			sleepCalls.push(ms);
		});

		let attempts = 0;
		_internals.bunSpawn = () => {
			attempts++;
			return mockProc(1, '', 'EBUSY: resource busy');
		};

		const result = await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		// Should fail after exhausting retries — never use --force
		expect(result).toEqual({ error: 'EBUSY: resource busy' });
		expect(attempts).toBe(4); // initial + 3 retries
		// Sleep should have been called 3 times (delays between retries)
		expect(sleepCalls.length).toBe(3);
	});

	test('retries on EPERM and succeeds on third attempt', async () => {
		_internals.platform = 'win32';
		_internals.sleep = async () => {}; // no-op

		let attempts = 0;
		_internals.bunSpawn = () => {
			attempts++;
			if (attempts < 3) return mockProc(1, '', 'EPERM: access denied');
			return mockProc(0, '', '');
		};

		const result = await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		expect(result).toEqual({ success: true });
		expect(attempts).toBe(3);
	});

	test('non-Windows platform does NOT retry on EBUSY', async () => {
		_internals.platform = 'linux';
		_internals.sleep = async () => {};

		let attempts = 0;
		_internals.bunSpawn = () => {
			attempts++;
			return mockProc(1, '', 'EBUSY: resource busy');
		};

		const result = await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		// On non-Windows, no retry — should fail immediately
		expect(result).toEqual({ error: 'EBUSY: resource busy' });
		expect(attempts).toBe(1);
	});

	test('non-retryable error does not trigger retry on Windows', async () => {
		_internals.platform = 'win32';
		_internals.sleep = async () => {};

		let attempts = 0;
		_internals.bunSpawn = () => {
			attempts++;
			return mockProc(1, '', 'fatal: not a git repository');
		};

		const result = await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		expect(result).toEqual({ error: 'fatal: not a git repository' });
		expect(attempts).toBe(1); // no retry for non-EBUSY/EPERM
	});

	test('retry delay uses 2000ms interval', async () => {
		_internals.platform = 'win32';

		const sleepCalls: number[] = [];
		_internals.sleep = mock(async (ms: number) => {
			sleepCalls.push(ms);
		});

		_internals.bunSpawn = () => mockProc(1, '', 'EBUSY');

		await removeWorktree(fakeWorktreePath, fakeProjectRoot);

		// All retry delays should be 2000ms
		expect(sleepCalls.length).toBe(3);
		for (const delay of sleepCalls) {
			expect(delay).toBe(2000);
		}
	});
});
