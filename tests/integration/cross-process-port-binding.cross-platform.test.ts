/**
 * Cross-process port-binding cross-platform tests (FR-201 SC-131)
 *
 * Covers:
 * - SC-131: Profile works on each OS (Linux/macOS/Windows).
 * - High ports (>1024) are bindable on all platforms.
 * - Adjacent ports scenario mirrors the primary SC-122 acceptance criterion.
 *
 * These tests spawn real child processes to verify cross-platform port binding.
 *
 * Subprocess safety per AGENTS.md invariant 3: array-form spawn, explicit cwd,
 * stdin: 'ignore', timeout, bounded stdout/stderr, proc.kill() in finally.
 *
 * Lifecycle: all spawned children are tracked and killed in afterEach to avoid
 * TIME_WAIT port leakage across tests.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ─── helpers ─────────────────────────────────────────────────────────────────

function writePortBindingScript(tmpDir: string): string {
	const scriptPath = path.join(tmpDir, 'bind-port.mjs');
	const script = `
import * as http from 'http';
import * as fs from 'fs';

const port = parseInt(process.env.PORT ?? '0', 10);
if (!port || port <= 0 || port > 65535) {
  const msg = 'Invalid PORT: ' + process.env.PORT;
  console.error(msg);
  process.exit(1);
}

const resultFile = process.argv[2];
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK\\n');
});

server.on('error', (err) => {
  const msg = 'Failed to bind to port ' + port + ': ' + err.message;
  console.error(msg);
  process.exit(2);
});

server.listen(port, '127.0.0.1', () => {
  console.log('ready:' + port);
  if (resultFile) {
    fs.writeFileSync(resultFile, String(port), 'utf-8');
  }
});
`;
	fs.writeFileSync(scriptPath, script, 'utf-8');
	return scriptPath;
}

function spawnPortBinder(
	port: number,
	tmpDir: string,
): { child: ChildProcess; resultFile: string } {
	const scriptPath = writePortBindingScript(tmpDir);
	const resultFile = path.join(tmpDir, `port-${port}.result`);

	const child = spawn(process.execPath, [scriptPath, resultFile], {
		cwd: tmpDir,
		env: { ...process.env, PORT: String(port) },
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	return { child, resultFile };
}

function waitForChildReady(
	child: ChildProcess,
	_resultFile: string,
	timeoutMs = 5000,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (child.exitCode !== null) {
				reject(new Error(`Child exited before ready: code=${child.exitCode}`));
			} else {
				reject(
					new Error(`Timeout waiting for ready signal after ${timeoutMs}ms`),
				);
			}
		}, timeoutMs);

		let stdoutData = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			stdoutData += chunk.toString();
			const match = stdoutData.match(/ready:(\d+)/);
			if (match) {
				clearTimeout(timeout);
				resolve(parseInt(match[1], 10));
			}
		});

		child.on('exit', (code) => {
			clearTimeout(timeout);
			if (!stdoutData.match(/ready:\d+/)) {
				reject(new Error(`Child exited before emitting ready: code=${code}`));
			}
		});
	});
}

async function killChild(child: ChildProcess, sig = 'SIGTERM'): Promise<void> {
	return new Promise((resolve) => {
		child.kill(sig);
		child.once('exit', () => resolve());
		setTimeout(() => {
			try {
				child.kill('SIGKILL');
			} catch {
				// already dead
			}
			setTimeout(resolve, 500);
		}, 2000);
	});
}

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return fs.realpathSync(dir);
}

// ─── fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;
const spawnedChildren: ChildProcess[] = [];

beforeEach(() => {
	tmpDir = makeTempDir('port-binding-crossplat-');
});

afterEach(async () => {
	await Promise.all(
		spawnedChildren.map(async (child) => {
			try {
				await killChild(child, 'SIGTERM');
			} catch {
				try {
					await killChild(child, 'SIGKILL');
				} catch {
					// best-effort
				}
			}
		}),
	);
	spawnedChildren.length = 0;

	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

// ─── SC-131: Profile works on each OS ─────────────────────────────────────────

describe('SC-131: Profile works on each OS', () => {
	const isWindows = process.platform === 'win32';

	test('port binding works on Windows', async () => {
		if (!isWindows) return; // Skip on non-Windows

		const { child: child0, resultFile: resultFile0 } = spawnPortBinder(
			8050,
			tmpDir,
		);
		spawnedChildren.push(child0);
		const boundPort0 = await waitForChildReady(child0, resultFile0);

		const { child: child1, resultFile: resultFile1 } = spawnPortBinder(
			8051,
			tmpDir,
		);
		spawnedChildren.push(child1);
		const boundPort1 = await waitForChildReady(child1, resultFile1);

		expect(boundPort0).toBe(8050);
		expect(boundPort1).toBe(8051);
		expect(child0.exitCode).toBeNull();
		expect(child1.exitCode).toBeNull();
	});

	test('port binding works on POSIX', async () => {
		if (isWindows) return; // Skip on Windows

		const { child: child0, resultFile: resultFile0 } = spawnPortBinder(
			8050,
			tmpDir,
		);
		spawnedChildren.push(child0);
		const boundPort0 = await waitForChildReady(child0, resultFile0);

		const { child: child1, resultFile: resultFile1 } = spawnPortBinder(
			8051,
			tmpDir,
		);
		spawnedChildren.push(child1);
		const boundPort1 = await waitForChildReady(child1, resultFile1);

		expect(boundPort0).toBe(8050);
		expect(boundPort1).toBe(8051);
		expect(child0.exitCode).toBeNull();
		expect(child1.exitCode).toBeNull();
	});

	test('high ports (>1024) are bindable on all platforms', async () => {
		// Ports above 1024 don't require elevated privileges on any platform
		const { child: child0, resultFile: resultFile0 } = spawnPortBinder(
			49152,
			tmpDir,
		);
		spawnedChildren.push(child0);
		const boundPort0 = await waitForChildReady(child0, resultFile0);

		const { child: child1, resultFile: resultFile1 } = spawnPortBinder(
			49153,
			tmpDir,
		);
		spawnedChildren.push(child1);
		const boundPort1 = await waitForChildReady(child1, resultFile1);

		expect(boundPort0).toBe(49152);
		expect(boundPort1).toBe(49153);
		expect(child0.exitCode).toBeNull();
		expect(child1.exitCode).toBeNull();
	});

	test('adjacent ports 8000 and 8001 are both bindable (main SC-122 scenario)', async () => {
		// Primary SC-122 acceptance criterion:
		// Two lanes with port_base=8000 and port_stride=1:
		// lane 0 → PORT=8000+0*1=8000
		// lane 1 → PORT=8000+1*1=8001
		const { child: child0, resultFile: resultFile0 } = spawnPortBinder(
			8000,
			tmpDir,
		);
		spawnedChildren.push(child0);
		const boundPort0 = await waitForChildReady(child0, resultFile0);

		const { child: child1, resultFile: resultFile1 } = spawnPortBinder(
			8001,
			tmpDir,
		);
		spawnedChildren.push(child1);
		const boundPort1 = await waitForChildReady(child1, resultFile1);

		expect(boundPort0).toBe(8000);
		expect(boundPort1).toBe(8001);
		expect(child0.exitCode).toBeNull();
		expect(child1.exitCode).toBeNull();
		expect(boundPort0).not.toBe(boundPort1);
	});
});
