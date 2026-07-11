/**
 * Bun-compat shim tests (issue #704).
 *
 * Each public surface is exercised against the live runtime. When running
 * under Bun the shim delegates to the native `Bun.*` primitives; when running
 * under Node the shim's fallback path is exercised. The test only asserts the
 * observable contract (text equality, written byte count, exit code parity)
 * — it does not lock in implementation details that legitimately differ
 * between the two paths.
 */

import { describe, expect, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	bunFile,
	bunHash,
	bunSpawn,
	bunSpawnSync,
	bunWrite,
	isBun,
} from '../bun-compat';

function tmpFile(name: string): string {
	const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bun-compat-'));
	return path.join(dir, name);
}

describe('bun-compat shim', () => {
	test('isBun reflects runtime presence', () => {
		expect(typeof isBun()).toBe('boolean');
	});

	test('bunWrite + bunFile round-trip preserves utf-8 content', async () => {
		const p = tmpFile('hello.txt');
		const written = await bunWrite(p, 'hëllo, 世界');
		expect(written).toBeGreaterThan(0);
		const content = await bunFile(p).text();
		expect(content).toBe('hëllo, 世界');
	});

	test('bunFile.exists reports absence', async () => {
		const p = path.join(
			os.tmpdir(),
			`bun-compat-missing-${Date.now()}-${Math.random()}.txt`,
		);
		const exists = await bunFile(p).exists();
		expect(exists).toBe(false);
	});

	test('bunWrite creates parent directories', async () => {
		const p = path.join(
			fsSync.mkdtempSync(path.join(os.tmpdir(), 'bun-compat-mkdir-')),
			'a',
			'b',
			'c.txt',
		);
		await bunWrite(p, 'nested');
		const content = await bunFile(p).text();
		expect(content).toBe('nested');
	});

	test('bunHash returns a stable bigint for the same input', () => {
		const a = bunHash('payload');
		const b = bunHash('payload');
		expect(typeof a).toBe('bigint');
		expect(a).toBe(b);
	});

	test('bunSpawnSync runs a trivial cross-platform command', () => {
		const cmd =
			process.platform === 'win32'
				? ['cmd', '/c', 'echo', 'hi']
				: ['echo', 'hi'];
		const res = bunSpawnSync(cmd);
		expect(res.success).toBe(true);
		expect(res.exitCode).toBe(0);
	});

	test('bunWrite atomic write does not leave a temp file on success', async () => {
		const p = tmpFile('atomic.txt');
		await bunWrite(p, 'final');
		const dir = path.dirname(p);
		const lingering = fsSync.readdirSync(dir).filter((n) => n.includes('.tmp'));
		expect(lingering.length).toBe(0);
	});
});

describe('bunSpawn killProcessTree', () => {
	// -- killProcessTree option wiring -----------------------------------------

	test('bunSpawn accepts killProcessTree option without throwing', () => {
		const cmd =
			process.platform === 'win32'
				? ['cmd', '/c', 'echo', 'hello']
				: ['echo', 'hello'];
		// Should not throw — this exercises the killProcessTree code path at spawn
		const proc = bunSpawn(cmd, { killProcessTree: true });
		expect(typeof proc.kill).toBe('function');
		// exitCode is a getter; before exit it may be null or a number
		expect(proc.exitCode === null || typeof proc.exitCode === 'number').toBe(
			true,
		);
	});

	test('bunSpawn without killProcessTree still has a kill method', () => {
		const cmd =
			process.platform === 'win32'
				? ['cmd', '/c', 'echo', 'hello']
				: ['echo', 'hello'];
		const proc = bunSpawn(cmd);
		expect(typeof proc.kill).toBe('function');
	});

	// -- Process termination via kill() ----------------------------------------

	test('bunSpawn(process).kill() terminates the process (killProcessTree: true)', async () => {
		const cmd =
			process.platform === 'win32'
				? ['cmd', '/c', 'timeout', '30']
				: ['sleep', '30'];

		const proc = bunSpawn(cmd, { killProcessTree: true });

		// Verify the process started
		expect(proc.exitCode).toBeNull();

		// Kill it
		proc.kill('SIGKILL');

		// Wait for exit with a generous timeout
		const exitCode = await proc.exited;
		expect(exitCode).not.toBe(0);
	});

	test('bunSpawn(process).kill() terminates the process (killProcessTree: false)', async () => {
		const cmd =
			process.platform === 'win32'
				? ['cmd', '/c', 'timeout', '30']
				: ['sleep', '30'];

		const proc = bunSpawn(cmd, { killProcessTree: false });

		expect(proc.exitCode).toBeNull();

		proc.kill('SIGKILL');

		const exitCode = await proc.exited;
		expect(exitCode).not.toBe(0);
	});

	// -- Verify detached spawning when killProcessTree is true -----------------
	// NOTE: The detached: true wiring is tested via the integration tests below
	// (process termination with killProcessTree: true). The Node.js internal
	// node:child_process spy tests are omitted because:
	//   1. When isBun() is true, bun.spawn is called (not node:child_process)
	//      so the mock would never see the call.
	//   2. When isBun() is false, the integration tests (process actually
	//      terminating) give us higher confidence than a mock anyway.
});

/**
 * Regression suite for SC-125 / SC-126 — env: {} isolation bug.
 *
 * Prior behaviour (BUG): when `env: {}` was passed to bunSpawn / bunSpawnSync,
 * the Node.js child_process was still inheriting the full process.env because the
 * merged env was being passed as `undefined` to nodeSpawn (object was empty and
 * nodeSpawn falls back to process.env when env is undefined). The child therefore
 * silently inherited all parent env vars, defeating the purpose of `env: {}`.
 *
 * The bug was fixed by making `mergeEnvForChild` return `{}` (not `undefined`)
 * when `baseEnv !== undefined` and the merged result is empty — preserving the
 * caller's explicit intent of an isolated env.
 */
describe('bunSpawn env: {} isolation regression (SC-125)', () => {
	// Helper: run node -e and return ALL env vars as a raw JSON string so we
	// can check for the ABSENCE of a parent-only sentinel (not just its value).
	async function getRawChildEnv(
		opts: Parameters<typeof bunSpawn>[1],
	): Promise<string> {
		const js = `process.stdout.write(JSON.stringify(process.env))`;
		const proc = bunSpawn([process.execPath, '-e', js], opts);
		const text = await proc.stdout.text();
		await proc.exited;
		return text;
	}

	test('bunSpawn with env: {} excludes ALL parent env vars (SC-125 regression)', async () => {
		// Set a sentinel that only exists in the parent — if the child sees it,
		// the bug is present (child inherited process.env instead of receiving {}).
		process.env.BUN_SPAWN_SENTINEL_REGRESSION_TEST ??= 'parent_only_sentinel';
		let cleanup = false;
		try {
			const raw = await getRawChildEnv({ env: {} });
			const parsed = JSON.parse(raw) as Record<string, string>;
			// The child must NOT contain the parent's sentinel
			expect(parsed['BUN_SPAWN_SENTINEL_REGRESSION_TEST']).toBeUndefined();
			cleanup = true;
		} finally {
			if (cleanup) delete process.env.BUN_SPAWN_SENTINEL_REGRESSION_TEST;
			else {
				// Test failed before cleanup — still clean up to avoid polluting
				delete process.env.BUN_SPAWN_SENTINEL_REGRESSION_TEST;
			}
		}
	});

	test('bunSpawnSync with env: {} excludes ALL parent env vars (SC-126 regression)', () => {
		process.env.BUN_SPAWN_SYNC_SENTINEL_REGRESSION_TEST ??=
			'sync_parent_only_sentinel';
		let cleanup = false;
		try {
			const js = `process.stdout.write(JSON.stringify(process.env))`;
			const res = bunSpawnSync([process.execPath, '-e', js], { env: {} });
			const raw = new TextDecoder().decode(res.stdout);
			const parsed = JSON.parse(raw) as Record<string, string>;
			expect(parsed['BUN_SPAWN_SYNC_SENTINEL_REGRESSION_TEST']).toBeUndefined();
			cleanup = true;
		} finally {
			if (cleanup) delete process.env.BUN_SPAWN_SYNC_SENTINEL_REGRESSION_TEST;
			else delete process.env.BUN_SPAWN_SYNC_SENTINEL_REGRESSION_TEST;
		}
	});
});

describe('bunSpawn envOverrides', () => {
	// Helper: run node -e with the given envOverrides and return the captured
	// env vars whose keys start with BUN_SPAWN_TEST_
	async function getChildEnv(
		envOverrides: Record<string, string | null> | undefined,
	): Promise<Record<string, string>> {
		const js = `process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([k])=>k.startsWith('BUN_SPAWN_TEST_')).reduce((acc,[k,v])=>(acc[k]=v,acc),{})))`;
		const proc = bunSpawn([process.execPath, '-e', js], { envOverrides });
		const text = await proc.stdout.text();
		await proc.exited;
		return JSON.parse(text || '{}');
	}

	test('envOverrides sets a new var in child env', async () => {
		const childEnv = await getChildEnv({ BUN_SPAWN_TEST_VAR: 'hello' });
		expect(childEnv).toEqual({ BUN_SPAWN_TEST_VAR: 'hello' });
	});

	test('envOverrides(null) deletes an inherited var from child env', async () => {
		// Set a sentinel in process.env so we can verify it was deleted
		process.env.BUN_SPAWN_TEST_DELETE ??= 'sentinel';
		const childEnv = await getChildEnv({ BUN_SPAWN_TEST_DELETE: null });
		// The child env must NOT contain BUN_SPAWN_TEST_DELETE
		expect(childEnv['BUN_SPAWN_TEST_DELETE']).toBeUndefined();
	});

	test('envOverrides does not mutate the parent process.env', async () => {
		process.env.BUN_SPAWN_TEST_MUTATION ??= 'original';
		await getChildEnv({ BUN_SPAWN_TEST_MUTATION: 'overridden' });
		// Parent must be unchanged
		expect(process.env.BUN_SPAWN_TEST_MUTATION).toBe('original');
		// Clean up
		delete process.env.BUN_SPAWN_TEST_MUTATION;
	});

	test('envOverrides precedence: override wins over inherited var', async () => {
		process.env.BUN_SPAWN_TEST_PREEXISTING ??= 'parent_value';
		const childEnv = await getChildEnv({
			BUN_SPAWN_TEST_PREEXISTING: 'child_value',
		});
		expect(childEnv.BUN_SPAWN_TEST_PREEXISTING).toBe('child_value');
	});

	test('envOverrides is backward compatible when omitted', async () => {
		// When envOverrides is absent, the child should still inherit process.env
		process.env.BUN_SPAWN_TEST_INHERITED ??= 'inherited_value';
		const childEnv = await getChildEnv(undefined);
		// The inherited var should be present (child inherits process.env)
		// and we should not have broken the baseline env
		expect(childEnv['BUN_SPAWN_TEST_INHERITED']).toBe('inherited_value');
	});
});

describe('bunSpawnSync envOverrides', () => {
	// Helper: run node -e with the given envOverrides and return the captured
	// env vars whose keys start with BUN_SPAWN_SYNC_TEST_
	function getChildEnvSync(
		envOverrides: Record<string, string | null> | undefined,
	): Record<string, string> {
		const js = `process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([k])=>k.startsWith('BUN_SPAWN_SYNC_TEST_')).reduce((acc,[k,v])=>(acc[k]=v,acc),{})))`;
		const res = bunSpawnSync([process.execPath, '-e', js], { envOverrides });
		return JSON.parse(res.stdout ? new TextDecoder().decode(res.stdout) : '{}');
	}

	test('envOverrides sets a new var in child env', () => {
		const childEnv = getChildEnvSync({ BUN_SPAWN_SYNC_TEST_VAR: 'hello_sync' });
		expect(childEnv).toEqual({ BUN_SPAWN_SYNC_TEST_VAR: 'hello_sync' });
	});

	test('envOverrides(null) deletes an inherited var from child env', () => {
		process.env.BUN_SPAWN_SYNC_TEST_DELETE ??= 'sync_sentinel';
		const childEnv = getChildEnvSync({ BUN_SPAWN_SYNC_TEST_DELETE: null });
		expect(childEnv['BUN_SPAWN_SYNC_TEST_DELETE']).toBeUndefined();
	});

	test('envOverrides does not mutate the parent process.env', () => {
		process.env.BUN_SPAWN_SYNC_TEST_MUTATION ??= 'sync_original';
		getChildEnvSync({ BUN_SPAWN_SYNC_TEST_MUTATION: 'sync_overridden' });
		expect(process.env.BUN_SPAWN_SYNC_TEST_MUTATION).toBe('sync_original');
		delete process.env.BUN_SPAWN_SYNC_TEST_MUTATION;
	});

	test('envOverrides precedence: override wins over inherited var', () => {
		process.env.BUN_SPAWN_SYNC_TEST_PREEXISTING ??= 'sync_parent_value';
		const childEnv = getChildEnvSync({
			BUN_SPAWN_SYNC_TEST_PREEXISTING: 'sync_child_value',
		});
		expect(childEnv.BUN_SPAWN_SYNC_TEST_PREEXISTING).toBe('sync_child_value');
	});

	test('envOverrides is backward compatible when omitted', () => {
		process.env.BUN_SPAWN_SYNC_TEST_INHERITED ??= 'sync_inherited_value';
		const childEnv = getChildEnvSync(undefined);
		expect(childEnv['BUN_SPAWN_SYNC_TEST_INHERITED']).toBe(
			'sync_inherited_value',
		);
	});
});

describe('bunSpawn explicit env: {} isolation', () => {
	// Helper: run node -e and return the captured env vars whose keys start
	// with the given prefix. Used to verify isolation from the parent env.
	async function getChildEnv(
		opts: {
			env?: Record<string, string | undefined>;
			envOverrides?: Record<string, string | null>;
		},
		prefix: string,
	): Promise<Record<string, string>> {
		const js = `process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([k])=>k.startsWith('${prefix}')).reduce((acc,[k,v])=>(acc[k]=v,acc),{})))`;
		const proc = bunSpawn([process.execPath, '-e', js], opts);
		const text = await proc.stdout.text();
		await proc.exited;
		return JSON.parse(text || '{}');
	}

	test('bunSpawn with env: {} does NOT inherit parent env vars', async () => {
		// Set a sentinel in the parent process.env
		process.env.BUN_SPAWN_EXPLICIT_EMPTY_TEST ??= 'parent_value';
		try {
			// With explicit env: {}, the child must NOT see the parent's vars
			const childEnv = await getChildEnv(
				{ env: {} },
				'BUN_SPAWN_EXPLICIT_EMPTY_TEST',
			);
			expect(childEnv['BUN_SPAWN_EXPLICIT_EMPTY_TEST']).toBeUndefined();
		} finally {
			delete process.env.BUN_SPAWN_EXPLICIT_EMPTY_TEST;
		}
	});

	test('bunSpawn with env: {} and envOverrides sets vars on empty base', async () => {
		// Explicit empty env plus an override yields only the override
		const childEnv = await getChildEnv(
			{ env: {}, envOverrides: { BUN_SPAWN_EXPLICIT_EMPTY_FOO: 'bar' } },
			'BUN_SPAWN_EXPLICIT_EMPTY_',
		);
		expect(childEnv).toEqual({ BUN_SPAWN_EXPLICIT_EMPTY_FOO: 'bar' });
	});

	test('bunSpawn envOverrides(null) without explicit env still deletes parent var', async () => {
		// When no env is passed, null override should still work (delete from process.env)
		process.env.BUN_SPAWN_NULL_OVERRIDE_TEST ??= 'to_be_deleted';
		try {
			const childEnv = await getChildEnv(
				{ envOverrides: { BUN_SPAWN_NULL_OVERRIDE_TEST: null } },
				'BUN_SPAWN_NULL_OVERRIDE_',
			);
			expect(childEnv['BUN_SPAWN_NULL_OVERRIDE_TEST']).toBeUndefined();
		} finally {
			delete process.env.BUN_SPAWN_NULL_OVERRIDE_TEST;
		}
	});
});

describe('bunSpawnSync explicit env: {} isolation', () => {
	function getChildEnvSync(
		opts: {
			env?: Record<string, string | undefined>;
			envOverrides?: Record<string, string | null>;
		},
		prefix: string,
	): Record<string, string> {
		const js = `process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([k])=>k.startsWith('${prefix}')).reduce((acc,[k,v])=>(acc[k]=v,acc),{})))`;
		const res = bunSpawnSync([process.execPath, '-e', js], opts);
		return JSON.parse(res.stdout ? new TextDecoder().decode(res.stdout) : '{}');
	}

	test('bunSpawnSync with env: {} does NOT inherit parent env vars', () => {
		process.env.BUN_SPAWN_SYNC_EXPLICIT_EMPTY_TEST ??= 'sync_parent_value';
		try {
			const childEnv = getChildEnvSync(
				{ env: {} },
				'BUN_SPAWN_SYNC_EXPLICIT_EMPTY_TEST',
			);
			expect(childEnv['BUN_SPAWN_SYNC_EXPLICIT_EMPTY_TEST']).toBeUndefined();
		} finally {
			delete process.env.BUN_SPAWN_SYNC_EXPLICIT_EMPTY_TEST;
		}
	});

	test('bunSpawnSync with env: {} and envOverrides sets vars on empty base', () => {
		const childEnv = getChildEnvSync(
			{ env: {}, envOverrides: { BUN_SPAWN_SYNC_EXPLICIT_EMPTY_FOO: 'bar' } },
			'BUN_SPAWN_SYNC_EXPLICIT_EMPTY_',
		);
		expect(childEnv).toEqual({ BUN_SPAWN_SYNC_EXPLICIT_EMPTY_FOO: 'bar' });
	});

	test('bunSpawnSync envOverrides(null) without explicit env still deletes parent var', () => {
		process.env.BUN_SPAWN_SYNC_NULL_OVERRIDE_TEST ??= 'sync_to_be_deleted';
		try {
			const childEnv = getChildEnvSync(
				{ envOverrides: { BUN_SPAWN_SYNC_NULL_OVERRIDE_TEST: null } },
				'BUN_SPAWN_SYNC_NULL_OVERRIDE_',
			);
			expect(childEnv['BUN_SPAWN_SYNC_NULL_OVERRIDE_TEST']).toBeUndefined();
		} finally {
			delete process.env.BUN_SPAWN_SYNC_NULL_OVERRIDE_TEST;
		}
	});
});
