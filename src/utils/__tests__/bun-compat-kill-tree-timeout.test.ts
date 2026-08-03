import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunSpawn } from '../bun-compat';

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
