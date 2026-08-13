import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _internals, bunSpawn } from '../bun-compat';

const originalPlatform = _internals.platform;
const originalSpawnTaskkill = _internals.spawnTaskkill;

afterEach(() => {
	_internals.platform = originalPlatform;
	_internals.spawnTaskkill = originalSpawnTaskkill;
});

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForFile(path: string, attempts = 20): Promise<void> {
	for (let index = 0; index < attempts; index += 1) {
		if (existsSync(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`child pid file was not created: ${path}`);
}

async function waitForProcessExit(pid: number, attempts = 20): Promise<void> {
	for (let index = 0; index < attempts; index += 1) {
		if (!processIsAlive(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe('bunSpawn tree-aware timeout', () => {
	test('retries Windows tree termination so SIGKILL survives a failed SIGTERM fallback', async () => {
		let taskkillCalls = 0;
		const directSignals: Array<NodeJS.Signals | number | undefined> = [];
		_internals.platform = () => 'win32';
		_internals.spawnTaskkill = (() => {
			taskkillCalls++;
			const child = new EventEmitter() as ReturnType<
				typeof originalSpawnTaskkill
			>;
			child.kill = () => true;
			queueMicrotask(() => child.emit('exit', 1));
			return child;
		}) as typeof originalSpawnTaskkill;

		const killTree = _internals.createProcessTreeKiller(
			123,
			(signal) => directSignals.push(signal),
			true,
		);
		await expect(killTree('SIGTERM')).rejects.toThrow(
			'process-tree termination could not be confirmed',
		);
		await expect(killTree('SIGKILL')).rejects.toThrow(
			'process-tree termination could not be confirmed',
		);

		// Previous code memoized the first failed taskkill promise, so the force
		// request never reached either taskkill or the direct child fallback.
		expect(taskkillCalls).toBe(2);
		expect(directSignals).toEqual(['SIGTERM', 'SIGKILL']);
	});

	test('kills a real parent and descendant on the native platform', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'bun-kill-tree-'));
		const pidFile = join(directory, 'descendant.pid');
		let descendantPid = 0;
		try {
			const parentScript = `
					const { spawn } = require('node:child_process');
					const { writeFileSync } = require('node:fs');
					const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
						cwd: ${JSON.stringify(directory)}, stdio: ['ignore', 'ignore', 'ignore']
					});
					writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
					setInterval(() => {}, 1000);
				`;
			const proc = bunSpawn([process.execPath, '-e', parentScript], {
				cwd: directory,
				stdin: 'ignore',
				stdout: 'ignore',
				stderr: 'pipe',
				timeout: 1_500,
				killProcessTree: true,
			});
			await waitForFile(pidFile);
			descendantPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
			expect(descendantPid).toBeGreaterThan(0);
			expect(processIsAlive(descendantPid)).toBe(true);
			await proc.exited;
			await waitForProcessExit(descendantPid);
			expect(processIsAlive(descendantPid)).toBe(false);
		} finally {
			if (descendantPid > 0 && processIsAlive(descendantPid)) {
				try {
					process.kill(descendantPid, 'SIGKILL');
				} catch {
					// Best-effort cleanup after a failing assertion.
				}
			}
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
