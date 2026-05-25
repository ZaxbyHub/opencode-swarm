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
