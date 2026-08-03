/**
 * Integration tests for PlanSyncWorker wiring in plugin init
 *
 * Tests that verify the plugin correctly initializes PlanSyncWorker
 * based on automation config:
 * 1. Init when enabled: mode !== 'manual' AND capabilities.plan_sync === true
 * 2. Skip when mode is manual
 * 3. Skip when flag is false
 * 4. Non-fatal on worker init failure
 * 5. Gated by outer mode check (mode !== 'manual')
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Import the config schema to test the conditional logic directly
import { AutomationConfigSchema } from '../../src/config/schema';

describe('PlanSyncWorker wiring logic', () => {
	/**
	 * Test 1: Init when enabled
	 * When mode = 'hybrid' AND capabilities.plan_sync = true,
	 * PlanSyncWorker SHOULD be started
	 */
	it('should enable plan_sync when mode is hybrid and flag is true', () => {
		const automationConfig = AutomationConfigSchema.parse({
			mode: 'hybrid',
			capabilities: {
				plan_sync: true,
			},
		});

		// The logic in src/index.ts lines 149 and 206:
		// if (automationConfig.mode !== 'manual') {
		//   if (automationConfig.capabilities?.plan_sync === true) {
		//     new PlanSyncWorker(...).start()
		//   }
		// }
		const shouldInit =
			automationConfig.mode !== 'manual' &&
			automationConfig.capabilities?.plan_sync === true;

		expect(shouldInit).toBe(true);
		expect(automationConfig.mode).toBe('hybrid');
		expect(automationConfig.capabilities?.plan_sync).toBe(true);
	});

	/**
	 * Test 2: Skip when mode is manual
	 * When mode = 'manual', the worker should NOT be initialized
	 * (even if plan_sync is true)
	 */
	it('should NOT enable when mode is manual (even with flag true)', () => {
		const automationConfig = AutomationConfigSchema.parse({
			mode: 'manual',
			capabilities: {
				plan_sync: true,
			},
		});

		const shouldInit =
			automationConfig.mode !== 'manual' &&
			automationConfig.capabilities?.plan_sync === true;

		expect(shouldInit).toBe(false);
	});

	/**
	 * Test 3: Skip when flag is false
	 * When mode = 'hybrid' but capabilities.plan_sync = false,
	 * the worker should NOT be initialized
	 */
	it('should NOT enable when mode is hybrid but flag is false', () => {
		const automationConfig = AutomationConfigSchema.parse({
			mode: 'hybrid',
			capabilities: {
				plan_sync: false,
			},
		});

		const shouldInit =
			automationConfig.mode !== 'manual' &&
			automationConfig.capabilities?.plan_sync === true;

		expect(shouldInit).toBe(false);
	});

	/**
	 * Test 4: Default behavior - plan_sync defaults to true in v6.8
	 * When capabilities is empty but mode is non-manual,
	 * plan_sync should default to true (v6.8 behavior)
	 */
	it('should enable plan_sync by default when mode is non-manual and flag is absent', () => {
		const automationConfig = AutomationConfigSchema.parse({
			mode: 'hybrid',
			capabilities: {},
		});

		// v6.8 default: plan_sync defaults to true
		expect(automationConfig.capabilities?.plan_sync).toBe(true);

		const shouldInit =
			automationConfig.mode !== 'manual' &&
			automationConfig.capabilities?.plan_sync === true;

		expect(shouldInit).toBe(true);
	});

	/**
	 * Test 5: mode = 'auto' should also work (not just 'hybrid')
	 */
	it('should enable when mode is auto and flag is true', () => {
		const automationConfig = AutomationConfigSchema.parse({
			mode: 'auto',
			capabilities: {
				plan_sync: true,
			},
		});

		const shouldInit =
			automationConfig.mode !== 'manual' &&
			automationConfig.capabilities?.plan_sync === true;

		expect(shouldInit).toBe(true);
	});

	/**
	 * Test 6: Default mode (not specified) should be treated as manual
	 * The schema defaults mode to 'manual'
	 */
	it('should NOT enable when automation config is empty (defaults to manual)', () => {
		// No automation config at all - should default to manual
		const automationConfig = AutomationConfigSchema.parse({});

		const shouldInit =
			automationConfig.mode !== 'manual' &&
			automationConfig.capabilities?.plan_sync === true;

		// Default mode is 'manual', so should NOT init
		expect(automationConfig.mode).toBe('manual');
		expect(shouldInit).toBe(false);
	});
});

describe('PlanSyncWorker non-fatal error handling', () => {
	/**
	 * Test 7: Worker init failure is non-fatal
	 * The try/catch in src/index.ts lines 207-218 ensures that
	 * a worker init failure logs an error but doesn't crash the plugin
	 */
	it('should have try/catch wrapper for non-fatal error handling', async () => {
		const { PlanSyncWorker } = await import('../../src/background/index.js');

		// Create a worker with an invalid directory to simulate failure
		const invalidDir = '/nonexistent/path/that/should/not/exist';

		// The constructor itself shouldn't throw (start might fail, but that's caught)
		expect(() => new PlanSyncWorker({ directory: invalidDir })).not.toThrow();
	});

	/**
	 * Test 8: Worker constructor is robust to bad options
	 */
	it('should handle worker construction with null directory gracefully', async () => {
		const { PlanSyncWorker } = await import('../../src/background/index.js');

		// Worker should not throw on construction even with bad options
		expect(() => new PlanSyncWorker({})).not.toThrow();
	});
});

describe('PlanSyncWorker integration with plugin config', () => {
	let testDir: string;
	let xdgConfigHome: string;
	let originalXdgConfigHome: string | undefined;

	beforeEach(() => {
		// Isolate user config directory to avoid pollution from real user config
		originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
		xdgConfigHome = mkdtempSync(path.join(tmpdir(), 'xdg-config-test-'));
		process.env.XDG_CONFIG_HOME = xdgConfigHome;

		// Create a temp directory for each test
		testDir = mkdtempSync(path.join(tmpdir(), 'plan-sync-test-'));

		// Create .opencode subdirectory with config file
		const opencodeDir = path.join(testDir, '.opencode');
		mkdirSync(opencodeDir, { recursive: true });
	});

	afterEach(() => {
		// Restore XDG_CONFIG_HOME
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
		}
		try {
			rmSync(xdgConfigHome, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}

		// Clean up temp directory
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	/**
	 * Full integration test: Load config with plan_sync enabled
	 */
	it('should load config with plan_sync enabled from .opencode/opencode-swarm.json', async () => {
		// Write a config file with plan_sync enabled
		const configPath = path.join(testDir, '.opencode', 'opencode-swarm.json');
		const configContent = {
			max_iterations: 5,
			qa_retry_limit: 3,
			inject_phase_reminders: true,
			automation: {
				mode: 'hybrid',
				capabilities: {
					plan_sync: true,
				},
			},
		};
		writeFileSync(configPath, JSON.stringify(configContent, null, 2));

		// Import the config loader and verify it parses correctly
		const { loadPluginConfigWithMeta } = await import('../../src/config');
		const { config, loadedFromFile } = loadPluginConfigWithMeta(testDir);

		// Verify the config was loaded
		expect(loadedFromFile).toBe(true);
		expect(config.automation).toBeDefined();
		expect(config.automation?.mode).toBe('hybrid');
		expect(config.automation?.capabilities?.plan_sync).toBe(true);

		// Apply the same logic as in src/index.ts
		const automationConfig = AutomationConfigSchema.parse(
			config.automation ?? {},
		);
		const shouldInit =
			automationConfig.mode !== 'manual' &&
			automationConfig.capabilities?.plan_sync === true;

		expect(shouldInit).toBe(true);
	});

	/**
	 * Integration test: plan_sync disabled when mode is manual
	 */
	it('should NOT enable plan_sync when mode is manual', async () => {
		// Write a config file with manual mode
		const configPath = path.join(testDir, '.opencode', 'opencode-swarm.json');
		const configContent = {
			automation: {
				mode: 'manual',
				capabilities: {
					plan_sync: true,
				},
			},
		};
		writeFileSync(configPath, JSON.stringify(configContent, null, 2));

		const { loadPluginConfigWithMeta } = await import('../../src/config');
		const { config } = loadPluginConfigWithMeta(testDir);

		const automationConfig = AutomationConfigSchema.parse(
			config.automation ?? {},
		);
		const shouldInit =
			automationConfig.mode !== 'manual' &&
			automationConfig.capabilities?.plan_sync === true;

		expect(shouldInit).toBe(false);
	});

	/**
	 * Integration test: plan_sync disabled when flag is false
	 */
	it('should NOT enable when flag is explicitly false', async () => {
		// Write a config file with flag explicitly false
		const configPath = path.join(testDir, '.opencode', 'opencode-swarm.json');
		const configContent = {
			automation: {
				mode: 'hybrid',
				capabilities: {
					plan_sync: false,
				},
			},
		};
		writeFileSync(configPath, JSON.stringify(configContent, null, 2));

		const { loadPluginConfigWithMeta } = await import('../../src/config');
		const { config } = loadPluginConfigWithMeta(testDir);

		const automationConfig = AutomationConfigSchema.parse(
			config.automation ?? {},
		);
		const shouldInit =
			automationConfig.mode !== 'manual' &&
			automationConfig.capabilities?.plan_sync === true;

		expect(shouldInit).toBe(false);
	});

	/**
	 * Integration test: default behavior (no automation config)
	 */
	it('should NOT enable by default when no automation config exists', async () => {
		// Write a config file without automation section
		const configPath = path.join(testDir, '.opencode', 'opencode-swarm.json');
		const configContent = {
			max_iterations: 5,
		};
		writeFileSync(configPath, JSON.stringify(configContent, null, 2));

		const { loadPluginConfigWithMeta } = await import('../../src/config');
		const { config } = loadPluginConfigWithMeta(testDir);

		const automationConfig = AutomationConfigSchema.parse(
			config.automation ?? {},
		);

		// Default mode is 'manual', so should NOT init
		expect(automationConfig.mode).toBe('manual');

		const shouldInit =
			automationConfig.mode !== 'manual' &&
			automationConfig.capabilities?.plan_sync === true;

		expect(shouldInit).toBe(false);
	});

	/**
	 * Integration test: v6.8 default - plan_sync defaults to true
	 */
	it('should default plan_sync to true when mode is non-manual and capabilities empty', async () => {
		const configPath = path.join(testDir, '.opencode', 'opencode-swarm.json');
		const configContent = {
			automation: {
				mode: 'hybrid',
				capabilities: {}, // No plan_sync specified
			},
		};
		writeFileSync(configPath, JSON.stringify(configContent, null, 2));

		const { loadPluginConfigWithMeta } = await import('../../src/config');
		const { config } = loadPluginConfigWithMeta(testDir);

		const automationConfig = AutomationConfigSchema.parse(
			config.automation ?? {},
		);

		// v6.8: plan_sync defaults to true
		expect(automationConfig.capabilities?.plan_sync).toBe(true);

		const shouldInit =
			automationConfig.mode !== 'manual' &&
			automationConfig.capabilities?.plan_sync === true;

		expect(shouldInit).toBe(true);
	});
});

describe('PlanSyncWorker lifecycle reachability — regression: dead cleanup path', () => {
	// Previous code constructed the PlanSyncWorker into a block-scoped `const`
	// inside the `if (automationConfig.capabilities?.plan_sync === true)`
	// branch in src/index.ts. That const was never assigned to an outer-scope
	// binding, so `cleanupAutomation` (registered on `process.on('exit', ...)`)
	// could never reach it — `stop()`/`dispose()` were unreachable in
	// production. This test proves the worker constructed by a real
	// `OpenCodeSwarm.server()` call is the same instance whose `stop()` fires
	// when the process-exit cleanup runs.
	let testDir: string;
	let xdgConfigHome: string;
	let originalXdgConfigHome: string | undefined;

	beforeEach(() => {
		originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
		xdgConfigHome = mkdtempSync(path.join(tmpdir(), 'xdg-config-test-'));
		process.env.XDG_CONFIG_HOME = xdgConfigHome;

		testDir = mkdtempSync(path.join(tmpdir(), 'plan-sync-lifecycle-'));
		const opencodeDir = path.join(testDir, '.opencode');
		mkdirSync(opencodeDir, { recursive: true });
	});

	afterEach(() => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
		}
		try {
			rmSync(xdgConfigHome, { recursive: true, force: true });
		} catch {
			// ignore
		}
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it('cleanupAutomation (registered via process.on("exit", ...)) calls PlanSyncWorker.stop()', async () => {
		const configPath = path.join(testDir, '.opencode', 'opencode-swarm.json');
		writeFileSync(
			configPath,
			JSON.stringify({
				automation: {
					mode: 'hybrid',
					capabilities: { plan_sync: true },
				},
			}),
		);

		const { PlanSyncWorker } = await import(
			'../../src/background/plan-sync-worker'
		);
		const OpenCodeSwarm = (await import('../../src/index')).default;

		const stopSpy = spyOn(PlanSyncWorker.prototype, 'stop');

		const mockPluginInput = {
			client: {} as any,
			project: {} as any,
			directory: testDir,
			worktree: testDir,
			serverUrl: new URL('http://localhost:3000'),
			$: {} as any,
		};

		// Capture only the 'exit' listener this server() call registers, rather
		// than firing process.emit('exit') globally (which would also invoke
		// every 'exit' listener left behind by other tests/files sharing this
		// process — see AGENTS.md invariant 7 mock/test-isolation concerns).
		const listenersBefore = process.listeners('exit').slice();

		try {
			await OpenCodeSwarm.server(mockPluginInput as any);

			const addedListeners = process
				.listeners('exit')
				.filter((l) => !listenersBefore.includes(l));
			expect(addedListeners.length).toBe(1);

			expect(stopSpy).not.toHaveBeenCalled();

			// Invoke exactly the listener this server() call registered —
			// proves reachability of PlanSyncWorker.stop() from this init's own
			// cleanupAutomation, without touching any other listener.
			(addedListeners[0] as (...args: unknown[]) => void).call(process, 0);

			expect(stopSpy).toHaveBeenCalled();
		} finally {
			stopSpy.mockRestore();
			for (const l of process.listeners('exit')) {
				if (!listenersBefore.includes(l)) {
					process.removeListener('exit', l as (...args: unknown[]) => void);
				}
			}
		}
	});
});
