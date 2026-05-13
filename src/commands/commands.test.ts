import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleDoctorCommand, loadModelAvailability } from '../commands/doctor';
import { handlePreflightCommand } from '../commands/preflight';
import { handleSyncPlanCommand } from '../commands/sync-plan';

// Test utilities
function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-test-'));
	return dir;
}

function cleanupDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function createSwarmDir(dir: string): string {
	const swarmDir = path.join(dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	return swarmDir;
}

function createTestConfig(dir: string, config: object): string {
	const configDir = path.join(dir, '.opencode');
	fs.mkdirSync(configDir, { recursive: true });
	const configPath = path.join(configDir, 'opencode-swarm.json');
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
	return configPath;
}

describe('Command Adapters', () => {
	let tempDir: string;
	let originalXdgConfigHome: string | undefined;

	beforeEach(() => {
		tempDir = createTempDir();
		originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = path.join(tempDir, '.isolated-config');
	});

	afterEach(() => {
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
		}
		cleanupDir(tempDir);
	});

	describe('/swarm preflight', () => {
		it('should run preflight checks and return formatted report', async () => {
			// Create minimal package.json for version check
			fs.writeFileSync(
				path.join(tempDir, 'package.json'),
				JSON.stringify({ name: 'test', version: '1.0.0' }),
			);

			const result = await handlePreflightCommand(tempDir, []);

			expect(result).toContain('## Preflight Report');
			expect(result).toContain('Overall');
			expect(result).toContain('Checks');
		});

		it('should handle missing directory gracefully', async () => {
			const result = await handlePreflightCommand('/nonexistent/path', []);

			expect(result).toContain('## Preflight Report');
			// Preflight service has error handling - should still return report structure
		});
	});

	describe('/swarm config doctor', () => {
		it('should run config doctor and return formatted report for valid config', async () => {
			createTestConfig(tempDir, {
				max_iterations: 5,
				qa_retry_limit: 3,
			});

			const result = await handleDoctorCommand(tempDir, []);

			expect(result).toContain('## Config Doctor Report');
			expect(result).toContain('Summary');
		});

		it('should validate configured models against the active OpenCode provider registry', async () => {
			createTestConfig(tempDir, {
				agents: {
					coder: { model: 'opencode/minimax-m2.5-free' },
					critic: { model: 'opencode/removed-model' },
				},
			});

			const client = {
				config: {
					providers: async () => ({
						data: {
							providers: [
								{
									id: 'opencode',
									models: {
										'minimax-m2.5-free': { id: 'minimax-m2.5-free' },
									},
								},
							],
						},
					}),
				},
			};

			const result = await handleDoctorCommand(tempDir, [], { client });

			expect(result).toContain('Configured model "opencode/removed-model"');
			expect(result).toContain('Run `/models`');
			expect(result).toContain('**Errors**: 1');
		});

		it('should report when OpenCode provider models cannot be loaded', async () => {
			createTestConfig(tempDir, {
				agents: {
					coder: { model: 'opencode/minimax-m2.5-free' },
				},
			});

			const client = {
				config: {
					providers: async () => ({
						error: { name: 'ProviderRegistryError', message: 'unavailable' },
					}),
				},
			};

			const result = await handleDoctorCommand(tempDir, [], { client });

			expect(result).toContain('Could not load OpenCode provider models');
			expect(result).toContain('ProviderRegistryError');
			expect(result).toContain('**Info**: 1');
		});

		it('should load available provider/model IDs from OpenCode config providers', async () => {
			const availability = await loadModelAvailability(tempDir, {
				config: {
					providers: async () => ({
						data: {
							providers: [
								{
									id: 'opencode',
									models: {
										'big-pickle': { id: 'big-pickle' },
										alias: { id: 'canonical-model' },
									},
								},
							],
						},
					}),
				},
			});

			expect(availability?.availableModelIds.has('opencode/big-pickle')).toBe(
				true,
			);
			expect(availability?.availableModelIds.has('opencode/alias')).toBe(true);
			expect(
				availability?.availableModelIds.has('opencode/canonical-model'),
			).toBe(true);
		});

		it('should report a provider lookup timeout as best-effort skipped validation', async () => {
			const availability = await loadModelAvailability(
				tempDir,
				{
					config: {
						providers: async () => new Promise(() => {}),
					},
				},
				{ timeoutMs: 5 },
			);

			expect(availability?.availableModelIds.size).toBe(0);
			expect(availability?.error).toContain(
				'OpenCode provider model registry lookup exceeded 5ms',
			);
		});

		it('should report malformed provider registry data without throwing', async () => {
			const availability = await loadModelAvailability(tempDir, {
				config: {
					providers: async () => ({
						data: {
							providers: { opencode: { models: {} } },
						},
					}),
				},
			});

			expect(availability?.availableModelIds.size).toBe(0);
			expect(availability?.error).toContain('malformed provider list');
		});

		it('should run config doctor with auto-fix flag', async () => {
			// Create config with deprecated setting that can be auto-fixed
			createTestConfig(tempDir, {
				max_iterations: 5,
				agents: {
					coder: { model: 'gpt-4' },
				},
			});

			const result = await handleDoctorCommand(tempDir, ['--fix']);

			// Should return formatted result (may or may not have fixes applied depending on config)
			expect(result).toContain('## Config Doctor Report');
		});

		it('should handle missing config gracefully', async () => {
			// No config file - should still return report
			const result = await handleDoctorCommand(tempDir, []);

			expect(result).toContain('## Config Doctor Report');
		});
	});

	describe('/swarm sync-plan', () => {
		it('should return no plan message when no plan exists', async () => {
			const result = await handleSyncPlanCommand(tempDir, []);

			expect(result).toContain('## Plan Sync Report');
			expect(result).toContain('No active swarm plan found');
		});

		it('should sync plan when plan.json exists', async () => {
			const swarmDir = createSwarmDir(tempDir);

			// Create a valid plan.json matching PlanSchema
			const plan = {
				schema_version: '1.0.0' as const,
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Test Phase',
						objectives: [
							{
								id: 'obj1',
								description: 'Test objective',
								status: 'pending',
								agent: 'coder',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(plan, null, 2),
			);

			const result = await handleSyncPlanCommand(tempDir, []);

			expect(result).toContain('## Plan Sync Report');
			expect(result).toContain('Synced');
			expect(result).toContain('Test Phase');
		});

		it('should regenerate stale plan.md from plan.json', async () => {
			const swarmDir = createSwarmDir(tempDir);

			// Create a valid plan.json
			const plan = {
				schema_version: '1.0.0' as const,
				title: 'Updated Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Updated Phase',
						objectives: [
							{
								id: 'obj1',
								description: 'Updated objective',
								status: 'pending',
								agent: 'coder',
							},
						],
					},
				],
			};
			fs.writeFileSync(
				path.join(swarmDir, 'plan.json'),
				JSON.stringify(plan, null, 2),
			);

			// Create stale plan.md
			fs.writeFileSync(
				path.join(swarmDir, 'plan.md'),
				'# Old Plan\n\n## Phase 1\n\nOld content',
			);

			const result = await handleSyncPlanCommand(tempDir, []);

			// Should show synced status and new content
			expect(result).toContain('## Plan Sync Report');
			expect(result).toContain('Synced');
		});
	});

	describe('Error handling', () => {
		it('preflight should handle invalid directory', async () => {
			const result = await handlePreflightCommand('', []);

			// Should still return report structure with error info
			expect(result).toContain('## Preflight Report');
		});

		it('doctor should handle invalid directory', async () => {
			const result = await handleDoctorCommand('', []);

			// Should handle gracefully
			expect(result).toContain('## Config Doctor Report');
		});

		it('sync-plan should handle invalid directory', async () => {
			const result = await handleSyncPlanCommand('', []);

			// Should handle gracefully
			expect(result).toContain('## Plan Sync Report');
		});
	});
});
