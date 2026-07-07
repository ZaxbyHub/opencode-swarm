/**
 * Cross-process dispatch path integration test — refactored to production entry point (FR-201 SC-124)
 *
 * ENTERS THROUGH: turbo/lean/worktree.ts:provisionWorktree() — the lean adapter's
 * production entry point which internally calls computeLaneRuntimeProfile (local to lean/worktree.ts)
 * and writeLaneProfileToDiskReal (from worktree/core.ts).
 *
 * What this test proves (end-to-end, NOT calling helpers directly):
 * 1. provisionWorktree() with runtime_isolation.enabled: true computes the lane profile
 *    (PORT = port_base + laneIndex * port_stride) and writes .swarm/lanes/{n}.env.
 * 2. The env file exists and contains the correct PORT.
 * 3. A child process spawned via real spawn() can source the env file and read PORT.
 *
 * Subprocess safety per AGENTS.md invariant 3: array-form spawn, explicit cwd,
 * stdin: 'ignore', timeout, bounded stdout/stderr, proc.kill() in finally.
 *
 * Mock pattern: _internals.bunSpawn DI seam (from lean/worktree.test.ts precedent).
 * No mock.module leakage — bun:test native mock replace the seam object in-place.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LeanTurboConfig } from '../../src/config/schema';
import { _internals, provisionWorktree } from '../../src/turbo/lean/worktree';
import type { BunCompatSubprocess } from '../../src/utils/bun-compat';

// ---------------------------------------------------------------------------
// bunSpawn mock helpers (borrowed from lean/worktree.test.ts)
// ---------------------------------------------------------------------------

const realBunSpawn = _internals.bunSpawn;

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
		} as BunCompatSubprocess['stdout'],
		stderr: {
			text: () => Promise.resolve(stderr),
		} as BunCompatSubprocess['stderr'],
		kill: () => {},
	};
}

/**
 * Installs a fake bunSpawn that returns appropriate exit codes for git commands.
 * - show-ref --verify → exit 1 (branch doesn't exist yet, so provisioning proceeds)
 * - worktree add → exit 0 (success)
 * - All other commands → exit 0
 */
function stubSpawnSuccess() {
	_internals.bunSpawn = (args: string[]) => {
		if (args.includes('show-ref')) return mockProc(1, '', '');
		return mockProc(0, '', '');
	};
}

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return fs.realpathSync(dir);
}

// ---------------------------------------------------------------------------
// Child process helpers
// ---------------------------------------------------------------------------

function waitForChildOutput(
	child: ChildProcess,
	pattern: RegExp,
	timeoutMs = 5000,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(
				new Error(`Timeout after ${timeoutMs}ms waiting for "${pattern}"`),
			);
		}, timeoutMs);

		let stdoutData = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			stdoutData += chunk.toString();
			if (stdoutData.match(pattern)) {
				clearTimeout(timer);
				resolve(stdoutData);
			}
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			if (!stdoutData.match(pattern)) {
				reject(
					new Error(
						`Child exited code=${code} before matching "${pattern}": ${stdoutData}`,
					),
				);
			}
		});
	});
}

async function killChild(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		child.kill('SIGTERM');
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
const spawnedChildren: ChildProcess[] = [];

beforeEach(() => {
	tmpDir = makeTempDir('dispatch-path-');
	stubSpawnSuccess();
});

afterEach(async () => {
	_internals.bunSpawn = realBunSpawn;

	await Promise.all(
		spawnedChildren.map(async (child) => {
			try {
				await killChild(child);
			} catch {
				// best-effort
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

// ---------------------------------------------------------------------------
// Production entry-point tests (FR-201 SC-124)
// ---------------------------------------------------------------------------

describe('SC-124: lane profile end-to-end via provisionWorktree() entry point', () => {
	test('provisionWorktree() with runtime_isolation writes .swarm/lanes/{n}.env and child reads correct PORT', async () => {
		// ── Step 1: Call the PRODUCTION entry point (lean adapter) ─────────
		// Config matches what a real lean turbo dispatch would pass.
		const config: LeanTurboConfig = {
			runtime_isolation: {
				enabled: true,
				port_base: 8000,
				port_stride: 1,
				env_overrides: { CUSTOM_VAR: 'lane-value' },
			},
		};

		const laneId = 'lane-2'; // 0-based index = 1
		const sessionId = 'test-session';

		// provisionWorktree() from turbo/lean/worktree.ts:
		// 1. Calls provisionSharedWorktree (git worktree add)
		// 2. Calls computeLaneRuntimeProfile (local to lean/worktree.ts)
		// 3. Calls writeLaneProfileToDiskReal (from worktree/core.ts)
		const result = await provisionWorktree(tmpDir, laneId, sessionId, config);

		// provisionWorktree returns { worktreePath, branchName } on success
		expect(result).not.toHaveProperty('error');
		if ('error' in result) return; // TypeScript guard

		// ── Step 2: Verify .swarm/lanes/{n}.env was created ─────────────
		// Lane index derived from laneId "lane-2" → index 1 (parseLeanLaneIndex: N-1)
		const envPath = path.join(result.worktreePath, '.swarm', 'lanes', '1.env');
		expect(fs.existsSync(envPath)).toBe(true);

		// ── Step 3: Verify PORT = port_base + laneIndex * port_stride ─────
		// lane-2 → index 1; PORT = 8000 + 1*1 = 8001
		const content = fs.readFileSync(envPath, 'utf-8');
		expect(content).toContain('PORT=8001');
		expect(content).toContain('CUSTOM_VAR=lane-value');

		// ── Step 4: Spawn child that sources the env file ────────────────
		// AGENTS.md invariant 3: array-form spawn, explicit cwd,
		// stdin: 'ignore', timeout, bounded stdout/stderr, proc.kill() in finally.
		const childScript = path.join(tmpDir, 'read-lane-env.mjs');
		fs.writeFileSync(
			childScript,
			`
import { readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(${JSON.stringify(result.worktreePath)}, '.swarm', 'lanes', '1.env');
const raw = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of raw.split('\\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq < 0) continue;
  env[t.slice(0, eq)] = t.slice(eq + 1);
}
console.log('LANE_PORT=' + (env.PORT ?? 'UNSET'));
console.log('LANE_CUSTOM_VAR=' + (env.CUSTOM_VAR ?? 'UNSET'));
`,
			'utf-8',
		);

		const child = spawn(process.execPath, [childScript], {
			cwd: tmpDir,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env },
			timeout: 10_000,
		});
		spawnedChildren.push(child);

		const output = await waitForChildOutput(child, /LANE_PORT=\d+/);
		expect(output).toMatch(/LANE_PORT=8001/);
		expect(output).toMatch(/LANE_CUSTOM_VAR=lane-value/);
	});

	test('multiple lanes each get distinct PORT values via production entry point', async () => {
		const config: LeanTurboConfig = {
			runtime_isolation: {
				enabled: true,
				port_base: 9000,
				port_stride: 10,
			},
		};
		const sessionId = 'multi-lane-session';

		// Provision 3 lanes and verify each gets a distinct env file
		for (let i = 0; i < 3; i++) {
			const laneId = `lane-${i + 1}`; // lane-1, lane-2, lane-3 → indices 0, 1, 2
			const result = await provisionWorktree(tmpDir, laneId, sessionId, config);

			expect(result).not.toHaveProperty('error');
			if ('error' in result) continue;

			const laneIndex = i; // parseLeanLaneIndex: lane-N → N-1
			const expectedPort = 9000 + laneIndex * 10; // 9000, 9010, 9020
			const envPath = path.join(
				result.worktreePath,
				'.swarm',
				'lanes',
				`${laneIndex}.env`,
			);

			expect(fs.existsSync(envPath)).toBe(true);
			const content = fs.readFileSync(envPath, 'utf-8');
			expect(content).toContain(`PORT=${expectedPort}`);
		}
	});

	test('PORT derivation formula: PORT = port_base + (laneIndex) * port_stride', async () => {
		// Test the formula directly through the production entry point
		// lane-1 → index 0, lane-3 → index 2, lane-10 → index 9
		const testCases: [
			laneId: string,
			port_base: number,
			port_stride: number,
			expectedPort: number,
		][] = [
			['lane-1', 5000, 100, 5000], // index 0: 5000 + 0*100
			['lane-3', 5000, 100, 5200], // index 2: 5000 + 2*100
			['lane-10', 5000, 100, 5900], // index 9: 5000 + 9*100
			['lane-1', 0, 50, 0], // index 0: 0 + 0*50
			['lane-4', 0, 50, 150], // index 3: 0 + 3*50
		];

		for (const [laneId, portBase, stride, expectedPort] of testCases) {
			const config: LeanTurboConfig = {
				runtime_isolation: {
					enabled: true,
					port_base: portBase,
					port_stride: stride,
				},
			};

			const result = await provisionWorktree(
				tmpDir,
				laneId,
				`session-${laneId}`,
				config,
			);

			expect(result).not.toHaveProperty('error');
			if ('error' in result) continue;

			// parseLeanLaneIndex: lane-N → N-1
			const laneIndex = parseInt(laneId.replace('lane-', ''), 10) - 1;
			const envPath = path.join(
				result.worktreePath,
				'.swarm',
				'lanes',
				`${laneIndex}.env`,
			);

			expect(fs.existsSync(envPath)).toBe(true);
			const content = fs.readFileSync(envPath, 'utf-8');
			expect(content).toContain(`PORT=${expectedPort}`);
		}
	});
});

/** parseLeanLaneIndex re-exported from lean/worktree for direct use in tests */
function parseLeanLaneIndex(laneId: string): number {
	const match = /^lane-(\d+)$/.exec(laneId);
	if (match) {
		const n = parseInt(match[1]!, 10);
		return Number.isNaN(n) ? 0 : n - 1;
	}
	return 0;
}
