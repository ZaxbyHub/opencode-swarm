import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../src/db/project-db.js';
import OpenCodeSwarm, { overrideIndexInternalsForTest } from '../../src/index';
import { _snapshotCoordinationInternals } from '../../src/session/snapshot-coordination-init.js';
import { resetSwarmState } from '../../src/state';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../helpers/tmpdir';

/**
 * Issue #2669 acceptance coverage for the init path: opted-in automation
 * status persistence must never prevent the plugin from returning its
 * manifest.
 *
 * Every test boots the REAL plugin entry (`OpenCodeSwarm.server`) with both
 * server-boot-isolation protections on non-comment lines:
 *  1. env isolation — `createIsolatedTestEnv()` redirects XDG_* / HOME /
 *     USERPROFILE into a temp root (the audit's sanctioned helper call);
 *  2. project config present — each scenario writes
 *     `.opencode/opencode-swarm.json` before the boot.
 *
 * `schedulePostResolutionTasks` is captured so the unref'd timer never runs
 * and the deferred automation-status task is executed deterministically.
 */

interface CapturedTask {
	name?: string;
	run: () => void | Promise<void>;
}

const OFF_CAPABILITIES = {
	plan_sync: false,
	phase_preflight: false,
	config_doctor_on_startup: false,
	config_doctor_autofix: false,
	evidence_auto_summaries: false,
	decision_drift_detection: false,
} as const;

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

function writeAutomationConfig(directory: string, automation: unknown): void {
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			quiet: true,
			version_check: false,
			automation,
		}),
	);
}

function assertMandatoryManifestShape(
	serverResult: Awaited<ReturnType<typeof OpenCodeSwarm.server>>,
): void {
	expect(serverResult).toBeDefined();
	const toolKeys = Object.keys(serverResult?.tool ?? {});
	const agentKeys = Object.keys(serverResult?.agent ?? {});
	expect(toolKeys.length).toBeGreaterThanOrEqual(50);
	expect(agentKeys.length).toBeGreaterThanOrEqual(1);
}

async function removeWithRetry(directory: string): Promise<void> {
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			fs.rmSync(directory, { recursive: true, force: true });
			return;
		} catch {
			await Bun.sleep(50);
		}
	}
	console.warn(`[init-2669] could not reclaim temp dir: ${directory}`);
}

describe('issue #2669 automation-status init containment', () => {
	let directory = '';
	let cleanupIsolatedEnv: () => void = () => {};

	beforeEach(() => {
		const isolated = createIsolatedTestEnv();
		cleanupIsolatedEnv = isolated.cleanup;
		resetSwarmState();
		directory = canonicalMkdtemp('index-status-2669-');
	});

	afterEach(async () => {
		resetSwarmState();
		_snapshotCoordinationInternals.entries.clear();
		closeAllProjectDbs();
		await removeWithRetry(directory);
		cleanupIsolatedEnv();
		cleanupIsolatedEnv = () => {};
	});

	test('opt-in with `.swarm` occupied by a regular file: server() resolves with the mandatory manifest', async () => {
		writeAutomationConfig(directory, {
			mode: 'hybrid',
			capabilities: OFF_CAPABILITIES,
		});
		fs.writeFileSync(path.join(directory, '.swarm'), 'not a directory');

		const { serverResult } = await bootWithCapturedTasks(directory);
		assertMandatoryManifestShape(serverResult);
	}, 120_000);

	test('opt-in with the artifact path occupied by a directory: server() resolves with the mandatory manifest', async () => {
		writeAutomationConfig(directory, {
			mode: 'hybrid',
			capabilities: OFF_CAPABILITIES,
		});
		fs.mkdirSync(path.join(directory, '.swarm', 'automation-status.json'), {
			recursive: true,
		});

		const { serverResult } = await bootWithCapturedTasks(directory);
		assertMandatoryManifestShape(serverResult);
	}, 120_000);

	test('opt-in healthy workspace: the status write is deferred to a named post-resolution task and still happens', async () => {
		writeAutomationConfig(directory, {
			mode: 'hybrid',
			capabilities: OFF_CAPABILITIES,
		});

		const { scheduledTasks } = await bootWithCapturedTasks(directory);
		const statusTask = scheduledTasks.find(
			(task) => task.name === 'automationStatusArtifactPostInitTask',
		);
		expect(statusTask).toBeDefined();

		const artifactPath = path.join(
			directory,
			'.swarm',
			'automation-status.json',
		);
		expect(fs.existsSync(artifactPath)).toBe(false);
		await statusTask!.run();
		expect(fs.existsSync(artifactPath)).toBe(true);
		const persisted = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as {
			mode: string;
		};
		expect(persisted.mode).toBe('hybrid');
	}, 120_000);

	test('default (manual) mode with a corrupt `.swarm` path: registration is unaffected', async () => {
		writeAutomationConfig(directory, {
			mode: 'manual',
			capabilities: OFF_CAPABILITIES,
		});
		fs.writeFileSync(path.join(directory, '.swarm'), 'not a directory');

		const { serverResult, scheduledTasks } =
			await bootWithCapturedTasks(directory);
		assertMandatoryManifestShape(serverResult);
		expect(
			scheduledTasks.find(
				(task) => task.name === 'automationStatusArtifactPostInitTask',
			),
		).toBeUndefined();
	}, 120_000);
});
