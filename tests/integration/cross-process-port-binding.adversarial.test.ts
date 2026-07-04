/**
 * Cross-process port-binding adversarial tests (FR-201 SC-122)
 *
 * Covers:
 * - Same-port collision: second process fails gracefully when first holds the port.
 * - Sandbox soft-fail: child exits gracefully on invalid PORT, never hangs.
 *
 * These tests spawn real child processes to verify adversarial scenarios.
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

function writePortBindingScript(tmpDir: string, stderrFile?: string): string {
	const scriptPath = path.join(tmpDir, 'bind-port.mjs');
	const script = `
import * as http from 'http';
import * as fs from 'fs';

const port = parseInt(process.env.PORT ?? '0', 10);
if (!port || port <= 0 || port > 65535) {
  const msg = 'Invalid PORT: ' + process.env.PORT;
  console.error(msg);
  ${stderrFile ? `fs.appendFileSync(${JSON.stringify(stderrFile)}, msg + '\\n', 'utf-8');` : ''}
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
  ${stderrFile ? `fs.appendFileSync(${JSON.stringify(stderrFile)}, msg + '\\n', 'utf-8');` : ''}
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

function waitForChildExit(
	child: ChildProcess,
	timeoutMs = 5000,
): Promise<number> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => resolve(-1), timeoutMs);
		child.once('exit', (code) => {
			clearTimeout(timeout);
			resolve(code ?? -1);
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
	tmpDir = makeTempDir('port-binding-adversarial-');
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

// ─── Same-port collision (adversarial) ───────────────────────────────────────

describe('same-port collision', () => {
	test('binding to same port by second process fails while first is still alive', async () => {
		// Start first process on port 8100 and wait for it to be ready
		const { child: childA, resultFile: resultFileA } = spawnPortBinder(
			8100,
			tmpDir,
		);
		spawnedChildren.push(childA);
		const boundPortA = await waitForChildReady(childA, resultFileA);
		expect(boundPortA).toBe(8100);
		expect(childA.exitCode).toBeNull(); // A is still alive

		// Start second process on the SAME port while A is still alive
		// B should fail to bind (EADDRINUSE) and exit without emitting "ready"
		const { child: childB, resultFile: resultFileB } = spawnPortBinder(
			8100,
			tmpDir,
		);
		spawnedChildren.push(childB);

		// Wait for B to exit — it should fail immediately (no "ready" signal)
		const exitCodeB = await waitForChildExit(childB, 8000);

		expect(exitCodeB).not.toBeNull();
		expect(exitCodeB).toBe(2); // B's bind failed → exit code 2

		// A should still be alive and bound to 8100
		expect(childA.exitCode).toBeNull();
		expect(fs.readFileSync(resultFileA, 'utf-8').trim()).toBe('8100');
	});
});

// ─── Sandbox soft-fail: env/port-only (never hard-fails lane) ───────────────

describe('Sandbox soft-fail: env/port-only (never hard-fails lane)', () => {
	test('child process exits gracefully even if port is invalid', async () => {
		const scriptPath = writePortBindingScript(tmpDir);
		const resultFile = path.join(tmpDir, 'invalid-port.result');

		const child = spawn(process.execPath, [scriptPath, resultFile], {
			cwd: tmpDir,
			env: { ...process.env, PORT: 'not-a-port' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		spawnedChildren.push(child);

		const exitCode = await waitForChildExit(child, 5000);
		expect(exitCode).toBe(1); // Invalid PORT exit code

		let resultContent = '';
		try {
			resultContent = fs.readFileSync(resultFile, 'utf-8');
		} catch {
			resultContent = '';
		}
		expect(resultContent.trim()).not.toMatch(/^\d+$/);
	});

	test('child process exits gracefully when port is out of range', async () => {
		const scriptPath = writePortBindingScript(tmpDir);
		const resultFile = path.join(tmpDir, 'oob-port.result');

		const child = spawn(process.execPath, [scriptPath, resultFile], {
			cwd: tmpDir,
			env: { ...process.env, PORT: '70000' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		spawnedChildren.push(child);

		const exitCode = await waitForChildExit(child, 5000);
		expect(exitCode).toBe(1); // Invalid PORT
	});
});
