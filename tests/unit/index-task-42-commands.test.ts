import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenCodeSwarm from '../../src/index';
import { createIndexCommandsModuleGuards } from '../helpers/index-commands-shared.js';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';

// File-scoped, NOT per-test (PR #2173 F-006). `OpenCodeSwarm.server()` queues
// background work on an unref'd `setTimeout(0)` that fires AFTER the synchronous
// `afterEach` has removed this file's temp dir — and then RECREATES it, leaving
// a permanent `swarm-test-*` orphan under os.tmpdir() on every run (2-5 per run
// before this stub). No test in this file exercises the scheduling seam, so
// neutralizing it costs nothing here.
const moduleGuards = createIndexCommandsModuleGuards();

beforeAll(moduleGuards.setUpAll);
afterAll(moduleGuards.tearDownAll);

interface CommandConfig {
	template: string;
	description: string;
}

describe('Task 4.2 - Command Config Templates for acknowledge-spec-drift and doctor-tools', () => {
	let tempDir: string;
	let cleanupIsolatedEnv: () => void = () => {};

	const mockPluginInput = {
		client: {} as any,
		project: {} as any,
		directory: '' as string,
		worktree: '' as string,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as any,
	};

	beforeEach(async () => {
		// getCommands() below boots the REAL, unstubbed `OpenCodeSwarm.server()`.
		// That boot's post-resolution queue runs config-doctor, whose
		// getUserConfigDir() ignores the `directory` param entirely
		// (src/services/config-doctor.ts:582-584); with no
		// `.opencode/opencode-swarm.json` under the temp `directory`, its
		// project-absent fallback reads AND REWRITES the developer's real global
		// ~/.config/opencode/opencode-swarm.json (config-doctor.ts:1884-1896).
		// Redirecting XDG_CONFIG_HOME/XDG_CACHE_HOME first neutralizes it.
		cleanupIsolatedEnv = createIsolatedTestEnv().cleanup;
		tempDir = await mkdtemp(path.join(tmpdir(), 'swarm-test-'));
		mockPluginInput.directory = tempDir;
		mockPluginInput.worktree = tempDir;
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		cleanupIsolatedEnv();
		cleanupIsolatedEnv = () => {};
	});

	async function getCommands(): Promise<Record<string, CommandConfig>> {
		const plugin = await OpenCodeSwarm.server(mockPluginInput);
		const mockConfig: Record<string, unknown> = {};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (plugin as any).config(mockConfig);
		return (mockConfig.command ?? {}) as Record<string, CommandConfig>;
	}

	test('1. swarm-acknowledge-spec-drift command entry exists with correct template', async () => {
		const commands = await getCommands();
		const entry = commands['swarm-acknowledge-spec-drift'];
		expect(entry).toBeDefined();
		expect(entry.template).toBe('/swarm acknowledge-spec-drift');
	});

	test('2. swarm-doctor-tools command entry exists with correct template', async () => {
		const commands = await getCommands();
		const entry = commands['swarm-doctor-tools'];
		expect(entry).toBeDefined();
		expect(entry.template).toBe('/swarm doctor tools');
	});

	test('3. swarm-acknowledge-spec-drift has non-empty description', async () => {
		const commands = await getCommands();
		const entry = commands['swarm-acknowledge-spec-drift'];
		expect(entry).toBeDefined();
		expect(entry.description).toBeTruthy();
		expect(entry.description.length).toBeGreaterThan(0);
	});

	test('4. swarm-doctor-tools has non-empty description', async () => {
		const commands = await getCommands();
		const entry = commands['swarm-doctor-tools'];
		expect(entry).toBeDefined();
		expect(entry.description).toBeTruthy();
		expect(entry.description.length).toBeGreaterThan(0);
	});

	test('5. Both entries have exact expected template values', async () => {
		const commands = await getCommands();

		// Exact template match for swarm-acknowledge-spec-drift
		expect(commands['swarm-acknowledge-spec-drift']?.template).toBe(
			'/swarm acknowledge-spec-drift',
		);

		// Exact template match for swarm-doctor-tools
		expect(commands['swarm-doctor-tools']?.template).toBe(
			'/swarm doctor tools',
		);
	});

	test('6. Both entries have expected description content', async () => {
		const commands = await getCommands();

		// Description mentions acknowledge-spec-drift
		expect(commands['swarm-acknowledge-spec-drift']?.description).toContain(
			'acknowledge-spec-drift',
		);

		// Description mentions doctor tools
		expect(commands['swarm-doctor-tools']?.description).toContain(
			'doctor tools',
		);
	});
});
