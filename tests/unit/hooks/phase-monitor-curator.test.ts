/**
 * Verification and adversarial tests for phase-monitor.ts curator integration.
 * Tests that the first-call guard correctly calls runCuratorInit when enabled,
 * and that errors from runCuratorInit do not block the hook.
 *
 * Uses ONLY real filesystem temp directories — no mock.module calls — to avoid
 * any module mock leakage when tests run in the same worker process.
 * Uses dependency injection (curatorRunner parameter) for the curator init function.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PreflightTriggerManager } from '../../../src/background/trigger';
import type {
	CuratorConfig,
	CuratorInitResult,
} from '../../../src/hooks/curator-types';
import type { CuratorDelegateFactory } from '../../../src/hooks/phase-monitor';
import { createPhaseMonitorHook } from '../../../src/hooks/phase-monitor';

// Injected curator runner mock — does NOT use mock.module to avoid leakage
const mockRunCuratorInit =
	mock<
		(_directory: string, _config: CuratorConfig) => Promise<CuratorInitResult>
	>();

// Mock the preflightManager
const mockCheckAndTrigger =
	mock<
		(
			_phase: number,
			_completedTasks: number,
			_totalTasks: number,
		) => Promise<boolean>
	>();

const mockPreflightManager = {
	checkAndTrigger: mockCheckAndTrigger,
} as unknown as PreflightTriggerManager;

/** Write a real opencode-swarm.json config file so loadPluginConfigWithMeta reads it */
function writeConfigFile(
	tempDir: string,
	config: Record<string, unknown>,
): void {
	const configDir = path.join(tempDir, '.opencode');
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, 'opencode-swarm.json'),
		JSON.stringify(config),
		'utf-8',
	);
}

/** Write a real plan.json (with valid schema) so loadPlan reads it */
function writePlanFile(
	tempDir: string,
	currentPhase: number,
	phases: Array<{
		id: number;
		tasks: Array<{ id: string; status: string }>;
	}>,
): void {
	const swarmDir = path.join(tempDir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	const plan = {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: currentPhase,
		phases: phases.map((p) => ({
			id: p.id,
			name: `Phase ${p.id}`,
			status: 'in_progress',
			tasks: p.tasks.map((t) => ({
				id: t.id,
				phase: p.id,
				status: t.status,
				size: 'small',
				description: `Task ${t.id}`,
				depends: [],
				files_touched: [],
			})),
		})),
	};
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan),
		'utf-8',
	);
	// Write plan.md so loadPlan doesn't attempt regeneration
	fs.writeFileSync(
		path.join(swarmDir, 'plan.md'),
		`# Plan\n## Phase ${currentPhase}\n`,
		'utf-8',
	);
}

describe('createPhaseMonitorHook - Curator Integration', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-monitor-curator-test-')),
		);
		mockCheckAndTrigger.mockClear();
		mockRunCuratorInit.mockReset(); // Use mockReset to clear implementation too
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe('Verification Tests', () => {
		it('1. Curator init skipped when explicitly disabled (enabled: false)', async () => {
			writeConfigFile(tempDir, { curator: { enabled: false } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);
			await hook({}, {});

			// runCuratorInit should NOT be called because enabled is explicitly false
			expect(mockRunCuratorInit).not.toHaveBeenCalled();
		});

		it('2. Curator init called on first invocation when enabled', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			mockRunCuratorInit.mockResolvedValue({
				briefing: 'Test briefing',
				contradictions: [],
				knowledge_entries_reviewed: 0,
				prior_phases_covered: 0,
			});

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);
			await hook({}, {});

			// runCuratorInit SHOULD be called because enabled && init_enabled
			// 3rd arg is llmDelegate (undefined in test — no opencodeClient set)
			expect(mockRunCuratorInit).toHaveBeenCalledWith(
				tempDir,
				expect.objectContaining({
					enabled: true,
					init_enabled: true,
				}),
				undefined,
			);
		});

		it('2b. delegateFactory is invoked with sessionID and result threaded to curatorRunner', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			const mockDelegate = mock();
			const mockFactory = mock<CuratorDelegateFactory>().mockReturnValue(
				mockDelegate as any,
			);

			mockRunCuratorInit.mockResolvedValue({
				briefing: 'Test briefing',
				contradictions: [],
				knowledge_entries_reviewed: 0,
				prior_phases_covered: 0,
			});

			// Pass factory as 4th arg; input carries sessionID
			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
				mockFactory,
			);
			await hook({ sessionID: 'sess-abc' }, {});

			// Factory was called with the sessionID from input
			expect(mockFactory).toHaveBeenCalledWith('sess-abc');

			// Delegate returned by factory was forwarded to curatorRunner as 3rd positional arg
			expect(mockRunCuratorInit).toHaveBeenCalledWith(
				tempDir,
				expect.objectContaining({ enabled: true }),
				mockDelegate,
			);
		});

		it('3. Curator init error does not block hook', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			// Make runCuratorInit throw
			mockRunCuratorInit.mockRejectedValue(new Error('Curator init failed!'));

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);

			// Should NOT throw - error should be caught internally
			const result = await hook({}, {});
			expect(result).toBeUndefined();

			// runCuratorInit was called and threw
			expect(mockRunCuratorInit).toHaveBeenCalled();
		});

		it('4. Hook still detects phase transitions after curator init', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });

			mockRunCuratorInit.mockResolvedValue({
				briefing: 'Test briefing',
				contradictions: [],
				knowledge_entries_reviewed: 0,
				prior_phases_covered: 0,
			});

			// First call: phase 1
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);

			// First invocation - curator init should be called
			await hook({}, {});
			expect(mockRunCuratorInit).toHaveBeenCalledTimes(1);

			mockCheckAndTrigger.mockClear();

			// Second call: phase changed to 2
			writePlanFile(tempDir, 2, [
				{ id: 1, tasks: [{ id: '1.1', status: 'completed' }] },
				{ id: 2, tasks: [{ id: '2.1', status: 'pending' }] },
			]);

			// Second invocation - should detect phase transition
			await hook({}, {});

			// checkAndTrigger should be called for phase transition
			expect(mockCheckAndTrigger).toHaveBeenCalledWith(2, 1, 1);
		});

		it('5. Curator init only called once (on first invocation)', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });

			mockRunCuratorInit.mockResolvedValue({
				briefing: 'Test briefing',
				contradictions: [],
				knowledge_entries_reviewed: 0,
				prior_phases_covered: 0,
			});

			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);

			// First invocation
			await hook({}, {});
			expect(mockRunCuratorInit).toHaveBeenCalledTimes(1);

			// Second invocation - different phase
			writePlanFile(tempDir, 2, [
				{ id: 1, tasks: [{ id: '1.1', status: 'completed' }] },
				{ id: 2, tasks: [{ id: '2.1', status: 'pending' }] },
			]);

			// Third invocation
			await hook({}, {});

			// runCuratorInit should NOT be called again - only on first invocation
			expect(mockRunCuratorInit).toHaveBeenCalledTimes(1);
		});
	});

	describe('Adversarial Tests', () => {
		it('6. runCuratorInit throws synchronously - hook does not throw', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			// Make runCuratorInit throw synchronously
			mockRunCuratorInit.mockImplementation(() => {
				throw new Error('Synchronous curator init failure');
			});

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);

			// Should NOT throw - error should be caught internally
			const result = await hook({}, {});
			expect(result).toBeUndefined();
		});

		it('7. runCuratorInit rejects with a non-Error - hook handles gracefully', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			// Make runCuratorInit reject with a string (non-Error)
			mockRunCuratorInit.mockRejectedValue('String rejection not an Error');

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);

			// Should NOT throw - error should be caught internally
			const result = await hook({}, {});
			expect(result).toBeUndefined();
		});

		it('8. runCuratorInit rejects with a number - hook handles gracefully', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			// Make runCuratorInit reject with a number (non-Error)
			mockRunCuratorInit.mockRejectedValue(42);

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);

			// Should NOT throw - error should be caught internally
			const result = await hook({}, {});
			expect(result).toBeUndefined();
		});

		it('9. runCuratorInit rejects with null - hook handles gracefully', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			// Make runCuratorInit reject with null
			mockRunCuratorInit.mockRejectedValue(null);

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);

			// Should NOT throw - error should be caught internally
			const result = await hook({}, {});
			expect(result).toBeUndefined();
		});

		it('10. Curator explicitly disabled - hook handles gracefully', async () => {
			// Explicitly disable curator — curator now defaults to enabled
			writeConfigFile(tempDir, { curator: { enabled: false } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);

			// Should NOT throw
			const result = await hook({}, {});
			expect(result).toBeUndefined();

			// runCuratorInit should NOT be called when curator is explicitly disabled
			expect(mockRunCuratorInit).not.toHaveBeenCalled();
		});
	});
});

/**
 * Task 5.3: Curator wiring fix - curator-briefing.md persistence
 *
 * Tests for phase-monitor.ts fix:
 * - createPhaseMonitorHook with curator enabled writes curator-briefing.md to .swarm/
 * - createPhaseMonitorHook with curator disabled does NOT write curator-briefing.md
 */
describe('Task 5.3: curator-briefing.md persistence', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-monitor-briefing-test-')),
		);
		mockCheckAndTrigger.mockClear();
		mockRunCuratorInit.mockClear();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe('curator-briefing.md is written when curator enabled', () => {
		it('writes curator-briefing.md to .swarm/ when curator init returns briefing', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			mockRunCuratorInit.mockResolvedValue({
				briefing: 'Test briefing content from curator init',
				contradictions: [],
				knowledge_entries_reviewed: 0,
				prior_phases_covered: 0,
			});

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);
			await hook({}, {});

			// Verify the briefing file was written
			const briefingPath = path.join(tempDir, '.swarm', 'curator-briefing.md');
			expect(fs.existsSync(briefingPath)).toBe(true);

			const content = fs.readFileSync(briefingPath, 'utf-8');
			expect(content).toBe('Test briefing content from curator init');
		});

		it('does NOT write curator-briefing.md when curator init returns empty briefing', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			mockRunCuratorInit.mockResolvedValue({
				briefing: '', // Empty briefing
				contradictions: [],
				knowledge_entries_reviewed: 0,
				prior_phases_covered: 0,
			});

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);
			await hook({}, {});

			// Verify the briefing file was NOT written
			const briefingPath = path.join(tempDir, '.swarm', 'curator-briefing.md');
			expect(fs.existsSync(briefingPath)).toBe(false);
		});

		it('does NOT write curator-briefing.md when curator init returns undefined briefing', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			mockRunCuratorInit.mockResolvedValue({
				briefing: undefined as any, // Undefined briefing
				contradictions: [],
				knowledge_entries_reviewed: 0,
				prior_phases_covered: 0,
			});

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);
			await hook({}, {});

			// Verify the briefing file was NOT written
			const briefingPath = path.join(tempDir, '.swarm', 'curator-briefing.md');
			expect(fs.existsSync(briefingPath)).toBe(false);
		});

		it('does NOT write curator-briefing.md when curator init does not return briefing property', async () => {
			writeConfigFile(tempDir, { curator: { enabled: true } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			mockRunCuratorInit.mockResolvedValue({
				contradictions: [],
				knowledge_entries_reviewed: 0,
				prior_phases_covered: 0,
				// No briefing property at all
			} as any);

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);
			await hook({}, {});

			// Verify the briefing file was NOT written
			const briefingPath = path.join(tempDir, '.swarm', 'curator-briefing.md');
			expect(fs.existsSync(briefingPath)).toBe(false);
		});
	});

	describe('curator-briefing.md is NOT written when curator disabled', () => {
		it('does NOT write curator-briefing.md when curator is disabled', async () => {
			writeConfigFile(tempDir, { curator: { enabled: false } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);
			await hook({}, {});

			// Verify the briefing file was NOT written
			const briefingPath = path.join(tempDir, '.swarm', 'curator-briefing.md');
			expect(fs.existsSync(briefingPath)).toBe(false);
		});

		it('does NOT write curator-briefing.md when curator explicitly disabled', async () => {
			// Explicitly disable curator via config
			writeConfigFile(tempDir, { curator: { enabled: false } });
			writePlanFile(tempDir, 1, [
				{ id: 1, tasks: [{ id: '1.1', status: 'pending' }] },
			]);

			const hook = createPhaseMonitorHook(
				tempDir,
				mockPreflightManager,
				mockRunCuratorInit,
			);
			await hook({}, {});

			// Verify the briefing file was NOT written
			const briefingPath = path.join(tempDir, '.swarm', 'curator-briefing.md');
			expect(fs.existsSync(briefingPath)).toBe(false);
		});
	});
});
