/**
 * Dashboard registration tests (issue #2509 AC1/AC2/AC9): the opt-in
 * post-resolution task, the disabled-by-default zero footprint, and the
 * `/swarm dashboard` command registration.
 *
 * Boots the REAL plugin via overrideIndexInternalsForTest (the #2670 capture
 * pattern) with an isolated temp project; no mock.module.
 */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import {
	COMMAND_REGISTRY,
	VALID_COMMANDS,
} from '../../../src/commands/registry.js';
import { closeDashboardServerForRoot } from '../../../src/dashboard/index.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Static import of the plugin would race other suites' module-state; load it
// lazily inside each boot like the index-commands suite does.
type IndexModule = typeof import('../../../src/index.js');

const tempDirs: string[] = [];
let restoreEnv: (() => void) | null = null;

afterEach(() => {
	restoreEnv?.();
	restoreEnv = null;
	try {
		closeAllProjectDbs();
	} catch {
		// best-effort
	}
	for (const dir of tempDirs.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Windows EBUSY — best-effort
		}
	}
});

afterAll(() => {
	try {
		closeAllProjectDbs();
	} catch {
		// best-effort
	}
});

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.listen(0, '127.0.0.1', () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});
}

function makeProject(withDashboard: boolean, port?: number): string {
	const dir = canonicalMkdtemp(withDashboard ? 'dash-reg-on' : 'dash-reg-off');
	tempDirs.push(dir);
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	const config: Record<string, unknown> = {
		quiet: true,
		version_check: false,
	};
	if (withDashboard) config.dashboard = { port };
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config),
	);
	return dir;
}

type CapturedTask = { name: string; run: () => void | Promise<void> };

async function bootAndCapture(
	dir: string,
): Promise<{ manifest: unknown; tasks: CapturedTask[] }> {
	const indexMod = (await import('../../../src/index.js')) as IndexModule & {
		overrideIndexInternalsForTest?: (o: unknown) => () => void;
	};
	const isolated = createIsolatedTestEnv();
	const tasks: CapturedTask[] = [];
	const restore =
		indexMod.overrideIndexInternalsForTest?.({
			schedulePostResolutionTasks: (scheduled: unknown[]) => {
				for (const task of scheduled) {
					tasks.push({
						name: String((task as { name?: string }).name ?? ''),
						run: task as () => void | Promise<void>,
					});
				}
			},
		}) ?? (() => {});
	try {
		const manifest = await (
			indexMod.default as unknown as {
				server: (ctx: unknown) => Promise<unknown>;
			}
		).server({
			client: {},
			project: {},
			directory: dir,
			worktree: dir,
			serverUrl: new URL('http://localhost:3000'),
			$: {},
		});
		return { manifest, tasks };
	} finally {
		restore();
		isolated.cleanup();
	}
}

function listSwarmFiles(dir: string): string[] {
	const swarmDir = path.join(dir, '.swarm');
	if (!fs.existsSync(swarmDir)) return [];
	return fs.readdirSync(swarmDir);
}

describe('dashboard registration and zero footprint', () => {
	it('schedules a NAMED dashboard post-resolution task when enabled', async () => {
		const dir = makeProject(true, await freePort());
		const { manifest, tasks } = await bootAndCapture(dir);
		expect(manifest).toBeDefined();
		const dashTask = tasks.find((t) => /dashboard|mission/i.test(t.name));
		expect(dashTask).toBeDefined();
		// Never awaited before server() resolved — by construction the capture
		// happens during boot; the task must not have run yet.
		expect(listSwarmFiles(dir).some((f) => /dashboard/i.test(f))).toBe(false);
		// Run the captured task: the server must come up and register itself.
		await dashTask?.run();
		try {
			const statusFile = path.join(dir, '.swarm', 'dashboard-status.json');
			expect(fs.existsSync(statusFile)).toBe(true);
			const record = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as {
				status: string;
			};
			expect(record.status).toBe('listening');
		} finally {
			closeDashboardServerForRoot(dir);
		}
	});

	it('a failing dashboard start degrades without rejecting the queue', async () => {
		// Occupy a port first so the dashboard bind deterministically fails
		// (privileged-port tricks are not portable to Windows).
		const blocker = net.createServer(() => {
			/* occupy */
		});
		const occupied = await new Promise<number>((resolve) => {
			blocker.listen(0, '127.0.0.1', () =>
				resolve((blocker.address() as { port: number }).port),
			);
		});
		const dir = makeProject(true, occupied);
		try {
			const { tasks } = await bootAndCapture(dir);
			const dashTask = tasks.find((t) => /dashboard|mission/i.test(t.name));
			expect(dashTask).toBeDefined();
			// The task body contains its own failure handling; a rejection here
			// would reject the queue — it must settle cleanly.
			await dashTask?.run();
			const statusFile = path.join(dir, '.swarm', 'dashboard-status.json');
			expect(fs.existsSync(statusFile)).toBe(true);
			const record = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as {
				status: string;
			};
			expect(record.status).toBe('disabled_port_conflict');
		} finally {
			blocker.close();
		}
	});

	it('disabled by default: no dashboard task, no dashboard file under .swarm', async () => {
		const dir = makeProject(false);
		const { manifest, tasks } = await bootAndCapture(dir);
		expect(manifest).toBeDefined();
		const dashTask = tasks.find((t) => /dashboard|mission/i.test(t.name));
		expect(dashTask).toBeUndefined();
		// Run every captured task to prove none writes a dashboard artifact.
		for (const task of tasks) {
			try {
				await task.run();
			} catch {
				// other tasks may fail in this hermetic env; irrelevant here
			}
		}
		expect(listSwarmFiles(dir).some((f) => /dashboard|mission/i.test(f))).toBe(
			false,
		);
	});

	it('registers the /swarm dashboard command', async () => {
		expect(COMMAND_REGISTRY.dashboard).toBeDefined();
		expect(typeof COMMAND_REGISTRY.dashboard?.handler).toBe('function');
		expect(COMMAND_REGISTRY.dashboard?.category).toBe('diagnostics');
		expect(VALID_COMMANDS).toContain('dashboard');
	});
});
