/**
 * Tests for src/sandbox/win32/runner-client.ts
 *
 * Uses file-scoped DI seam (_internals) for mocking per AGENTS.md Invariant 7.
 * Runner binary availability is mocked — these tests verify the TypeScript
 * client logic, not the Rust binary itself.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
	_internals,
	_resetProbeCache,
	buildDefaultPolicy,
	execute,
	probe,
	RUNNER_EXIT_CODES,
} from '../../../src/sandbox/win32/runner-client';

const isWin = process.platform === 'win32';

// Save real implementations for restoration
const realFindRunnerBinary = _internals.findRunnerBinary;
const realSpawnRunner = _internals.spawnRunner;
const realSpawnAsync = _internals.spawnAsync;

afterEach(() => {
	// Restore real implementations
	_internals.findRunnerBinary = realFindRunnerBinary;
	_internals.spawnRunner = realSpawnRunner;
	_internals.spawnAsync = realSpawnAsync;
	_resetProbeCache();
});

function createMockChildProcess(
	exitCode: number,
	stdoutData: string,
	stderrData: string,
): EventEmitter & {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	kill: () => boolean;
} {
	const child = new EventEmitter() as EventEmitter & {
		stdin: Writable;
		stdout: Readable;
		stderr: Readable;
		kill: () => boolean;
	};
	child.stdin = new Writable({
		write(_chunk, _enc, cb) {
			cb();
		},
	});
	child.stdout = new Readable({ read() {} });
	child.stderr = new Readable({ read() {} });
	child.kill = () => true;

	process.nextTick(() => {
		if (stdoutData) child.stdout.push(Buffer.from(stdoutData));
		child.stdout.push(null);
		if (stderrData) child.stderr.push(Buffer.from(stderrData));
		child.stderr.push(null);
		process.nextTick(() => child.emit('close', exitCode));
	});

	return child;
}

// ---------------------------------------------------------------------------
// probe()
// ---------------------------------------------------------------------------

describe('runner-client probe()', () => {
	test('returns unavailable when binary not found', () => {
		_internals.findRunnerBinary = () => null;

		const result = probe();
		expect(result.available).toBe(false);
		expect(result.mode).toBe('none');
		expect(result.error).toContain('not found');
	});

	test('returns unavailable on non-Windows', () => {
		if (isWin) return;

		const result = probe();
		expect(result.available).toBe(false);
		expect(result.mode).toBe('none');
		expect(result.error).toContain('not Windows');
	});

	test.skipIf(!isWin)('returns probe result from binary stdout', () => {
		const mockCapabilities = {
			app_container_available: false,
			lpac_available: false,
			restricted_token_available: true,
			private_desktop_creatable: true,
			integrity_level: 'medium',
			is_admin: false,
			os_version: '10.0.22631',
			arch: 'x86_64',
		};

		_internals.findRunnerBinary = () => 'C:\\fake\\runner.exe';
		_internals.spawnRunner = ((
			_cmd: string,
			_args: string[],
			_opts: unknown,
		) => ({
			status: 0,
			stdout: JSON.stringify(mockCapabilities),
			stderr: '',
			error: null,
		})) as typeof realSpawnRunner;

		const result = probe();
		expect(result.available).toBe(true);
		expect(result.mode).toBe('restricted-token');
		expect(result.capabilities?.restricted_token_available).toBe(true);
		expect(result.capabilities?.integrity_level).toBe('medium');
	});

	test.skipIf(!isWin)('returns app-container mode when available', () => {
		const mockCapabilities = {
			app_container_available: true,
			lpac_available: true,
			restricted_token_available: true,
			private_desktop_creatable: true,
			integrity_level: 'medium',
			is_admin: false,
			os_version: '10.0.22631',
			arch: 'x86_64',
		};

		_internals.findRunnerBinary = () => 'C:\\fake\\runner.exe';
		_internals.spawnRunner = ((
			_cmd: string,
			_args: string[],
			_opts: unknown,
		) => ({
			status: 0,
			stdout: JSON.stringify(mockCapabilities),
			stderr: '',
			error: null,
		})) as typeof realSpawnRunner;

		const result = probe();
		expect(result.available).toBe(true);
		expect(result.mode).toBe('app-container');
	});

	test.skipIf(!isWin)('returns unavailable when probe exits non-zero', () => {
		_internals.findRunnerBinary = () => 'C:\\fake\\runner.exe';
		_internals.spawnRunner = ((
			_cmd: string,
			_args: string[],
			_opts: unknown,
		) => ({
			status: 69,
			stdout: '',
			stderr: 'probe failed',
			error: null,
		})) as typeof realSpawnRunner;

		const result = probe();
		expect(result.available).toBe(false);
		expect(result.mode).toBe('none');
		expect(result.error).toContain('code 69');
	});

	test.skipIf(!isWin)('returns unavailable when probe times out', () => {
		_internals.findRunnerBinary = () => 'C:\\fake\\runner.exe';
		_internals.spawnRunner = ((
			_cmd: string,
			_args: string[],
			_opts: unknown,
		) => ({
			status: null,
			stdout: '',
			stderr: '',
			error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
		})) as typeof realSpawnRunner;

		const result = probe();
		expect(result.available).toBe(false);
		expect(result.mode).toBe('none');
		expect(result.error).toContain('spawn error');
	});

	test.skipIf(!isWin)('caches probe result', () => {
		let callCount = 0;
		_internals.findRunnerBinary = () => {
			callCount++;
			return null;
		};

		probe();
		probe();
		// findRunnerBinary should only be called once (result cached)
		expect(callCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// buildDefaultPolicy()
// ---------------------------------------------------------------------------

describe('buildDefaultPolicy()', () => {
	test('produces valid policy with workspace root', () => {
		const policy = buildDefaultPolicy('C:\\Users\\test\\project');
		expect(policy.schema_version).toBe(1);
		expect(policy.workspace_roots).toEqual(['C:\\Users\\test\\project']);
		expect(policy.writable_roots).toEqual(['C:\\Users\\test\\project']);
		expect(policy.read_only_subpaths).toContain('.git');
		expect(policy.read_only_subpaths).toContain('.swarm');
		expect(policy.network_mode).toBe('off');
		expect(policy.temp_cap_bytes).toBe(524_288_000);
		expect(policy.memory_cap_bytes).toBe(2_147_483_648);
		expect(policy.child_process_cap).toBe(16);
		expect(policy.wall_clock_timeout_ms).toBe(600_000);
		expect(policy.path_stubs).toContain('ssh.exe');
		expect(policy.path_stubs).toContain('curl.exe');
		expect(policy.private_desktop).toBe(true);
		expect(policy.deny_alternate_data_streams).toBe(true);
		expect(policy.deny_unc_paths).toBe(true);
		expect(policy.deny_device_paths).toBe(true);
		expect(policy.deny_symlink_egress).toBe(true);
	});

	test('uses custom run_id when provided', () => {
		const policy = buildDefaultPolicy('C:\\test', 'custom-run-123');
		expect(policy.run_id).toBe('custom-run-123');
	});

	test('temp_root uses LOCALAPPDATA', () => {
		const policy = buildDefaultPolicy('C:\\test');
		expect(policy.temp_root).toContain('opencode-swarm');
		expect(policy.temp_root).toContain('sandbox');
	});

	test('env_overrides block proxies', () => {
		const policy = buildDefaultPolicy('C:\\test');
		expect(policy.env_overrides.HTTP_PROXY).toBe('http://127.0.0.1:1');
		expect(policy.env_overrides.HTTPS_PROXY).toBe('http://127.0.0.1:1');
	});
});

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe('RUNNER_EXIT_CODES', () => {
	test('exit codes match spec', () => {
		expect(RUNNER_EXIT_CODES.SUCCESS).toBe(0);
		expect(RUNNER_EXIT_CODES.CHILD_NON_ZERO).toBe(1);
		expect(RUNNER_EXIT_CODES.POLICY_VIOLATION).toBe(64);
		expect(RUNNER_EXIT_CODES.QUOTA_EXCEEDED).toBe(65);
		expect(RUNNER_EXIT_CODES.WALL_CLOCK_TIMEOUT).toBe(66);
		expect(RUNNER_EXIT_CODES.LAUNCHER_MISCONFIG).toBe(67);
		expect(RUNNER_EXIT_CODES.OS_API_FAILURE).toBe(68);
		expect(RUNNER_EXIT_CODES.PROBE_FAILED).toBe(69);
	});
});

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

describe('runner-client execute()', () => {
	test('throws when runner binary not found', async () => {
		_internals.findRunnerBinary = () => null;

		const policy = buildDefaultPolicy('C:\\test', 'test-run');
		await expect(execute(['echo', 'hello'], policy)).rejects.toThrow(
			'runner binary not found',
		);
	});

	test.skipIf(!isWin)('resolves with exit code and stdout', async () => {
		_internals.findRunnerBinary = () => 'C:\\fake\\runner.exe';
		const startEvent = JSON.stringify({
			type: 'start',
			run_id: 'test-run',
			mode: 'restricted-token',
			pid: 42,
			ts: '1234.567',
		});
		const exitEvent = JSON.stringify({
			type: 'exit',
			exit_code: 0,
			signal: null,
			ts: '1234.999',
		});

		_internals.spawnAsync = ((
			_cmd: string,
			_args: string[],
			_opts: unknown,
		) => {
			return createMockChildProcess(
				0,
				'hello world\n',
				`${startEvent}\n${exitEvent}\n`,
			);
		}) as typeof realSpawnAsync;

		const policy = buildDefaultPolicy('C:\\test', 'test-run');
		const result = await execute(['echo', 'hello'], policy);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('hello world');
		expect(result.mode).toBe('restricted-token');
		expect(result.events.length).toBeGreaterThanOrEqual(2);
		expect(result.events[0]?.type).toBe('start');
	});

	test.skipIf(!isWin)('captures policy violation events', async () => {
		_internals.findRunnerBinary = () => 'C:\\fake\\runner.exe';
		const denialEvent = JSON.stringify({
			type: 'denial',
			reason: 'write_outside_workspace',
			path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
			ts: '1234.567',
		});

		_internals.spawnAsync = ((
			_cmd: string,
			_args: string[],
			_opts: unknown,
		) => {
			return createMockChildProcess(64, '', `${denialEvent}\n`);
		}) as typeof realSpawnAsync;

		const policy = buildDefaultPolicy('C:\\test', 'test-run');
		const result = await execute(['cat', 'C:\\Windows\\hosts'], policy);
		expect(result.exitCode).toBe(64);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.type).toBe('denial');
		expect(result.events[0]?.reason).toBe('write_outside_workspace');
	});

	test.skipIf(!isWin)('separates NDJSON events from plain stderr', async () => {
		_internals.findRunnerBinary = () => 'C:\\fake\\runner.exe';
		const startEvent = JSON.stringify({
			type: 'start',
			run_id: 'test-run',
			mode: 'app-container',
			pid: 99,
			ts: '1234.567',
		});

		_internals.spawnAsync = ((
			_cmd: string,
			_args: string[],
			_opts: unknown,
		) => {
			return createMockChildProcess(
				1,
				'',
				`${startEvent}\nsome plain error text\n`,
			);
		}) as typeof realSpawnAsync;

		const policy = buildDefaultPolicy('C:\\test', 'test-run');
		const result = await execute(['fail'], policy);
		expect(result.exitCode).toBe(1);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.type).toBe('start');
		expect(result.stderr).toContain('some plain error text');
	});

	test.skipIf(!isWin)('handles null exit code (killed process)', async () => {
		_internals.findRunnerBinary = () => 'C:\\fake\\runner.exe';

		_internals.spawnAsync = ((
			_cmd: string,
			_args: string[],
			_opts: unknown,
		) => {
			const child = createMockChildProcess(
				null as unknown as number, // simulate null exit code
				'',
				'',
			);
			return child;
		}) as typeof realSpawnAsync;

		const policy = buildDefaultPolicy('C:\\test', 'test-run');
		const result = await execute(['killed'], policy);
		expect(result.exitCode).toBe(1); // null → 1 fallback
	});

	test.skipIf(!isWin)('rejects on spawn error', async () => {
		_internals.findRunnerBinary = () => 'C:\\fake\\runner.exe';

		_internals.spawnAsync = ((
			_cmd: string,
			_args: string[],
			_opts: unknown,
		) => {
			const child = new EventEmitter() as EventEmitter & {
				stdin: Writable;
				stdout: Readable;
				stderr: Readable;
				kill: () => boolean;
			};
			child.stdin = new Writable({
				write(_chunk, _enc, cb) {
					cb();
				},
			});
			child.stdout = new Readable({ read() {} });
			child.stderr = new Readable({ read() {} });
			child.kill = () => true;

			process.nextTick(() => {
				child.emit('error', new Error('ENOENT: runner binary missing'));
			});
			return child;
		}) as typeof realSpawnAsync;

		const policy = buildDefaultPolicy('C:\\test', 'test-run');
		await expect(execute(['missing'], policy)).rejects.toThrow('ENOENT');
	});
});
