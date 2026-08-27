import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenCodeSwarm, { overrideIndexInternalsForTest } from '../../src/index';
import { resetSwarmState } from '../../src/state';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../helpers/tmpdir';

/**
 * Issue #2104 acceptance coverage for the plugin-init maintenance wiring:
 *
 * - the deferred post-init maintenance pass (P5) is registered ONLY when
 *   `hooks.background_subagents` is enabled, and runs strictly after
 *   server() resolution on the wrapper-owned post-resolution queue;
 * - it fails open when maintenance storage is corrupt — the failure is
 *   recorded durably in the health artifact's maintenance ring instead of
 *   surfacing at init;
 * - the session-close maintenance point (P3) fires from the real plugin
 *   event hook on a terminal session event.
 *
 * Every test captures `schedulePostResolutionTasks` so the unref'd timer
 * never runs: a scheduled task executes only when the test invokes it, which
 * is what makes the before/after artifact assertions deterministic and keeps
 * P5 writes distinguishable from P3 writes.
 */

interface CapturedTask {
	name?: string;
	run: () => void | Promise<void>;
}

const HEALTH_ARTIFACT = 'background-delegations-health.json';
const RESERVATION_STORE = 'background-coder-reservations.json';

function makeProject(): string {
	return canonicalMkdtemp('index-bg-maintenance-');
}

function writeProjectConfig(directory: string, hooks: unknown): void {
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			quiet: true,
			version_check: false,
			hooks,
		}),
	);
}

/** Write a GLOBAL (XDG) config with no project config present. */
function writeGlobalConfigOnly(configDir: string, hooks: unknown): void {
	fs.mkdirSync(path.join(configDir, 'opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(configDir, 'opencode', 'opencode-swarm.json'),
		JSON.stringify({
			quiet: true,
			version_check: false,
			hooks,
		}),
	);
}

function healthArtifactPath(directory: string): string {
	return path.join(directory, '.swarm', HEALTH_ARTIFACT);
}

function readMaintenanceSection(directory: string): {
	lastRunAt: number;
	lastOkAt: number | null;
	lastFailure: { reason: string; at: number } | null;
} | null {
	const raw = fs.readFileSync(healthArtifactPath(directory), 'utf-8');
	const parsed = JSON.parse(raw) as {
		maintenance?: {
			lastRunAt: number;
			lastOkAt: number | null;
			lastFailure: { reason: string; at: number } | null;
		};
	};
	return parsed.maintenance ?? null;
}

async function bootWithCapturedTasks(directory: string): Promise<{
	serverResult: Awaited<ReturnType<typeof OpenCodeSwarm.server>>;
	scheduledTasks: CapturedTask[];
}> {
	const scheduledTasks: CapturedTask[] = [];
	const restore = overrideIndexInternalsForTest({
		schedulePostResolutionTasks: (tasks) => {
			for (const task of tasks) {
				scheduledTasks.push({
					name: (task as { name?: string }).name,
					run: task,
				});
			}
		},
	});
	try {
		const serverResult = await OpenCodeSwarm.server({
			client: {} as never,
			project: {} as never,
			directory,
			worktree: directory,
			serverUrl: new URL('http://localhost:3000'),
			$: {} as never,
		});
		return { serverResult, scheduledTasks };
	} finally {
		restore();
	}
}

describe('issue #2104 background maintenance init wiring', () => {
	let directory = '';
	let configDir = '';
	let cleanupIsolatedEnv: () => void = () => {};

	beforeEach(() => {
		const isolated = createIsolatedTestEnv();
		configDir = isolated.configDir;
		cleanupIsolatedEnv = isolated.cleanup;
		resetSwarmState();
		directory = makeProject();
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true });
		cleanupIsolatedEnv();
		cleanupIsolatedEnv = () => {};
	});

	test('P5 is deferred, opt-in, and fails open on a corrupt reservation store', async () => {
		writeProjectConfig(directory, { background_subagents: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', RESERVATION_STORE),
			'{ not valid json',
		);

		const { scheduledTasks } = await bootWithCapturedTasks(directory);

		// Deferred: the queue received work, but nothing has run yet — plugin
		// registration already resolved and no maintenance artifact exists.
		expect(scheduledTasks.length).toBeGreaterThan(0);
		expect(fs.existsSync(healthArtifactPath(directory))).toBe(false);

		const maintenanceTask = scheduledTasks.find(
			(task) => task.name === 'backgroundMaintenancePostInitTask',
		);
		expect(maintenanceTask).toBeDefined();

		// Fail-open: a corrupt store must not throw out of the deferred task.
		await maintenanceTask!.run();

		// The failure is durably recorded instead of surfacing at init.
		expect(fs.existsSync(healthArtifactPath(directory))).toBe(true);
		const maintenance = readMaintenanceSection(directory);
		expect(maintenance).not.toBeNull();
		expect(maintenance!.lastRunAt).toBeGreaterThan(0);
		expect(maintenance!.lastFailure).not.toBeNull();
		// A failure observation must not record a success stamp.
		expect(maintenance!.lastOkAt).toBeNull();
	});

	test('P5 is not scheduled when hooks.background_subagents is disabled', async () => {
		writeProjectConfig(directory, { background_subagents: false });
		const { scheduledTasks } = await bootWithCapturedTasks(directory);
		expect(
			scheduledTasks.find(
				(task) => task.name === 'backgroundMaintenancePostInitTask',
			),
		).toBeUndefined();
	});

	test('P5 is not scheduled when hooks.background_subagents is omitted', async () => {
		writeProjectConfig(directory, {});
		const { scheduledTasks } = await bootWithCapturedTasks(directory);
		expect(
			scheduledTasks.find(
				(task) => task.name === 'backgroundMaintenancePostInitTask',
			),
		).toBeUndefined();
	});

	test('P5 is scheduled when only the XDG global config enables it', async () => {
		// No project config: the loader deep-merges the XDG global config, so a
		// global hooks.background_subagents:true must enable the deferred pass.
		writeGlobalConfigOnly(configDir, { background_subagents: true });
		const { scheduledTasks } = await bootWithCapturedTasks(directory);
		expect(
			scheduledTasks.find(
				(task) => task.name === 'backgroundMaintenancePostInitTask',
			),
		).toBeDefined();
	});

	test('P3 fires maintenance from the event hook on session.deleted', async () => {
		writeProjectConfig(directory, { background_subagents: true });
		const { serverResult, scheduledTasks } =
			await bootWithCapturedTasks(directory);

		// The scheduler is captured, so only the session-close maintenance
		// point can write the artifact from here.
		expect(fs.existsSync(healthArtifactPath(directory))).toBe(false);
		expect(
			scheduledTasks.find(
				(task) => task.name === 'backgroundMaintenancePostInitTask',
			),
		).toBeDefined();

		await serverResult.event?.({
			event: {
				type: 'session.deleted',
				properties: { sessionID: 'closing-parent' },
			},
		});

		expect(fs.existsSync(healthArtifactPath(directory))).toBe(true);
		const maintenance = readMaintenanceSection(directory);
		expect(maintenance).not.toBeNull();
		expect(maintenance!.lastRunAt).toBeGreaterThan(0);
		// Empty stores ⇒ the P3 pass completes ok and stamps lastOkAt.
		expect(maintenance!.lastOkAt).not.toBeNull();
	});
});
