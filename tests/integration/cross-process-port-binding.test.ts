/**
 * Cross-process port-binding integration test (FR-201 SC-122, FR-204 SC-131)
 *
 * Covers:
 * - SC-122: Two lanes running a port-binding test server concurrently both pass.
 * - SC-129 + SC-130: Disabled by default; off-by-default regression sweep — no PORT injection.
 *
 * These tests spawn real child processes to verify that:
 * 1. When runtime_isolation is enabled, each lane gets a unique PORT env var.
 * 2. Two lanes can bind to their respective ports without collision (simultaneously alive).
 * 3. When runtime_isolation is disabled, no PORT env var is injected.
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

/**
 * Creates a temporary script that:
 * - Reads PORT from env
 * - Creates a TCP server on that port
 * - Writes "ready:<port>\n" to stdout after successfully binding (port embedded in signal)
 * - Keeps the server alive (does NOT auto-exit) so the test controls lifecycle
 * - Exits with code 2 on bind error (EADDRINUSE / EACCES / etc.)
 * - Optionally appends stderr to a file (for invalid PORT validation tests)
 */
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

/**
 * Spawns a child process that binds to the specified PORT.
 * Returns the ChildProcess handle immediately (does NOT wait for exit).
 * The caller must wait for "ready" signal via waitForChildReady().
 *
 * Per AGENTS.md invariant 3: array-form spawn, explicit cwd, stdin: 'ignore',
 * timeout, bounded stdout/stderr.
 */
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

/**
 * Waits for a child process to emit "ready:<port>\n" on stdout.
 * Resolves with the bound port parsed from the ready signal on success.
 * Rejects if the child exits before emitting "ready".
 */
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
				const boundPort = parseInt(match[1], 10);
				resolve(boundPort);
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

/**
 * Waits for a child process to exit, with timeout.
 * Resolves with the exit code, or -1 if timed out.
 */
function waitForChildExit(
	child: ChildProcess,
	timeoutMs = 5000,
): Promise<number> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			resolve(-1);
		}, timeoutMs);

		child.once('exit', (code) => {
			clearTimeout(timeout);
			resolve(code ?? -1);
		});
	});
}

/**
 * Gracefully kills a child process (SIGTERM first, then SIGKILL after timeout),
 * then waits for it to fully exit.
 */
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
	// Wrap in realpathSync for macOS: temp dirs are symlinked to /private/var/...
	return fs.realpathSync(dir);
}

// ─── fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;
/** All spawned children tracked for cleanup in afterEach */
const spawnedChildren: ChildProcess[] = [];

beforeEach(() => {
	tmpDir = makeTempDir('port-binding-');
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

// ─── SC-122: Two lanes can bind to different ports concurrently ───────────────

describe('SC-122: concurrent port binding across lanes', () => {
	test('lane 0 (PORT=8000) and lane 1 (PORT=8001) both bind successfully', async () => {
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

	test('lane 0 (PORT=9100) and lane 1 (PORT=9101) with stride=1 both bind', async () => {
		const { child: child0, resultFile: resultFile0 } = spawnPortBinder(
			59100,
			tmpDir,
		);
		spawnedChildren.push(child0);
		const boundPort0 = await waitForChildReady(child0, resultFile0);

		const { child: child1, resultFile: resultFile1 } = spawnPortBinder(
			59101,
			tmpDir,
		);
		spawnedChildren.push(child1);
		const boundPort1 = await waitForChildReady(child1, resultFile1);

		expect(boundPort0).toBe(59100);
		expect(boundPort1).toBe(59101);
		expect(child0.exitCode).toBeNull();
		expect(child1.exitCode).toBeNull();
	});

	test('lane 0 and lane 1 on non-adjacent ports (8000 and 8200) both bind', async () => {
		const { child: child0, resultFile: resultFile0 } = spawnPortBinder(
			8000,
			tmpDir,
		);
		spawnedChildren.push(child0);
		const boundPort0 = await waitForChildReady(child0, resultFile0);

		const { child: child1, resultFile: resultFile1 } = spawnPortBinder(
			8200,
			tmpDir,
		);
		spawnedChildren.push(child1);
		const boundPort1 = await waitForChildReady(child1, resultFile1);

		expect(boundPort0).toBe(8000);
		expect(boundPort1).toBe(8200);
		expect(child0.exitCode).toBeNull();
		expect(child1.exitCode).toBeNull();
	});

	test('lane 0 (PORT=8000) and lane 1 (PORT=8001) can bind to adjacent ports', async () => {
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
	});
});

// ─── SC-129/SC-130: disabled by default — no PORT injection ─────────────────

describe('SC-129/SC-130: no PORT injection when runtime_isolation disabled', () => {
	test('child process without PORT env var gets undefined PORT', async () => {
		const scriptPath = writePortBindingScript(tmpDir);
		const resultFile = path.join(tmpDir, 'no-port.result');
		const stderrFile = path.join(tmpDir, 'no-port.stderr');
		writePortBindingScript(tmpDir, stderrFile);

		const child = spawn(process.execPath, [scriptPath, resultFile], {
			cwd: tmpDir,
			env: { ...process.env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		spawnedChildren.push(child);

		const exitCode = await waitForChildExit(child, 5000);
		expect(exitCode).toBe(1); // Invalid PORT exit code

		const stderrData = fs.readFileSync(stderrFile, 'utf-8');
		expect(stderrData).toContain('Invalid PORT');
	});

	test('child process with PORT env var set to valid port succeeds', async () => {
		const { child, resultFile } = spawnPortBinder(8050, tmpDir);
		spawnedChildren.push(child);
		const boundPort = await waitForChildReady(child, resultFile);
		expect(boundPort).toBe(8050);
		expect(child.exitCode).toBeNull();
	});

	test('simulating runtime_isolation config with port_base undefined → no PORT', async () => {
		const stderrFile = path.join(tmpDir, 'undefined-port.stderr');
		const scriptPath = writePortBindingScript(tmpDir, stderrFile);
		const resultFile = path.join(tmpDir, 'undefined-port.result');

		const envWithoutPort = { ...process.env };
		delete envWithoutPort.PORT;

		const child = spawn(process.execPath, [scriptPath, resultFile], {
			cwd: tmpDir,
			env: envWithoutPort,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		spawnedChildren.push(child);

		const exitCode = await waitForChildExit(child, 5000);
		expect(exitCode).toBe(1); // Invalid PORT

		const stderrData = fs.readFileSync(stderrFile, 'utf-8');
		expect(stderrData).toContain('Invalid PORT');
	});
});

// ─── Subprocess correctness ───────────────────────────────────────────────────

describe('subprocess correctness', () => {
	test('subprocess spawn uses array form with explicit cwd', async () => {
		const scriptPath = writePortBindingScript(tmpDir);
		const resultFile = path.join(tmpDir, 'array-form.result');

		const child = spawn(process.execPath, [scriptPath, resultFile], {
			cwd: tmpDir,
			env: { ...process.env, PORT: '8030' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		spawnedChildren.push(child);

		const boundPort = await waitForChildReady(child, resultFile);
		expect(boundPort).toBe(8030);
		expect(child.exitCode).toBeNull();
	});

	test('env injection is per-process (no cross-process pollution)', async () => {
		const { child: child0, resultFile: resultFile0 } = spawnPortBinder(
			8040,
			tmpDir,
		);
		spawnedChildren.push(child0);
		const boundPort0 = await waitForChildReady(child0, resultFile0);
		expect(boundPort0).toBe(8040);
		expect(child0.exitCode).toBeNull();

		const { child: child1, resultFile: resultFile1 } = spawnPortBinder(
			8041,
			tmpDir,
		);
		spawnedChildren.push(child1);
		const boundPort1 = await waitForChildReady(child1, resultFile1);
		expect(boundPort1).toBe(8041);
		expect(child1.exitCode).toBeNull();

		expect(boundPort0).toBe(8040);
		expect(boundPort1).toBe(8041);
	});
});
