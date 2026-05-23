import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../config/schema';
import {
	applySafeAutoFixes,
	type ConfigBackup,
	type ConfigDoctorResult,
	createConfigBackup,
	getConfigPaths,
	restoreFromBackup,
	runConfigDoctor,
	runConfigDoctorWithFixes,
	shouldRunOnStartup,
	writeBackupArtifact,
	writeDoctorArtifact,
} from '../services/config-doctor';

// Test utilities
function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-doctor-test-'));
	return dir;
}

function cleanupDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function createTestConfig(dir: string, config: object): string {
	const configDir = path.join(dir, '.opencode');
	fs.mkdirSync(configDir, { recursive: true });
	const configPath = path.join(configDir, 'opencode-swarm.json');
	fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
	return configPath;
}

// Minimal config object for testing - bypass type checking for invalid configs
function createTestConfigObj(
	overrides: Record<string, unknown> = {},
): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		...overrides,
	} as PluginConfig;
}

describe('Config Doctor Service', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		cleanupDir(tempDir);
	});

	describe('runConfigDoctor', () => {
		it('should return empty findings for valid config', () => {
			const config = createTestConfigObj();

			const result = runConfigDoctor(config, tempDir);

			expect(result.findings).toHaveLength(0);
			expect(result.summary).toEqual({ info: 0, warn: 0, error: 0 });
			expect(result.hasAutoFixableIssues).toBe(false);
		});

		it('should detect deprecated agents config', () => {
			const config = createTestConfigObj({
				agents: {
					coder: { model: 'gpt-4' },
				},
			});

			const result = runConfigDoctor(config, tempDir);

			expect(result.findings).toHaveLength(1);
			expect(result.findings[0]!.id).toBe('deprecated-agents-config');
			expect(result.findings[0]!.severity).toBe('warn');
			expect(result.findings[0]!.autoFixable).toBe(false);
		});

		it('should detect guardrails disabled', () => {
			const config = createTestConfigObj({
				guardrails: {
					enabled: false,
					max_tool_calls: 200,
					max_duration_minutes: 30,
					max_repetitions: 10,
					max_consecutive_errors: 5,
					warning_threshold: 0.75,
					idle_timeout_minutes: 60,
				},
			});

			const result = runConfigDoctor(config, tempDir);

			expect(result.findings).toHaveLength(1);
			expect(result.findings[0]!.id).toBe('guardrails-disabled');
			expect(result.findings[0]!.severity).toBe('error');
		});

		it('should detect invalid automation mode', () => {
			const config = createTestConfigObj({
				automation: {
					mode: 'invalid',
				},
			});

			const result = runConfigDoctor(config, tempDir);

			expect(result.findings).toHaveLength(1);
			expect(result.findings[0]!.id).toBe('invalid-automation-mode');
			expect(result.findings[0]!.severity).toBe('error');
			expect(result.findings[0]!.autoFixable).toBe(true);
			expect(result.findings[0]!.proposedFix?.value).toBe('manual');
		});

		it('should detect invalid capability types', () => {
			const config = createTestConfigObj({
				automation: {
					mode: 'hybrid',
					capabilities: {
						config_doctor_on_startup: 'yes',
					},
				},
			});

			const result = runConfigDoctor(config, tempDir);

			expect(result.findings).toHaveLength(1);
			expect(result.findings[0]!.id).toBe('invalid-capability-type');
			expect(result.findings[0]!.severity).toBe('error');
			expect(result.findings[0]!.autoFixable).toBe(true);
		});

		it('should detect out-of-bounds max_iterations', () => {
			const config = createTestConfigObj({
				max_iterations: 100,
			});

			const result = runConfigDoctor(config, tempDir);

			expect(result.findings).toHaveLength(1);
			expect(result.findings[0]!.id).toBe('out-of-bounds-iterations');
			expect(result.findings[0]!.proposedFix?.value).toBe(10);
		});

		it('should detect unknown agent profiles', () => {
			const config = createTestConfigObj({
				guardrails: {
					enabled: true,
					max_tool_calls: 200,
					max_duration_minutes: 30,
					max_repetitions: 10,
					max_consecutive_errors: 5,
					warning_threshold: 0.75,
					idle_timeout_minutes: 60,
					profiles: {
						unknown_agent: { max_tool_calls: 100 },
					},
				},
			});

			const result = runConfigDoctor(config, tempDir);

			expect(result.findings).toHaveLength(1);
			expect(result.findings[0]!.id).toBe('unknown-agent-profile');
			expect(result.findings[0]!.severity).toBe('info');
			expect(result.findings[0]!.autoFixable).toBe(true);
		});

		it('should detect unknown hook fields', () => {
			const config = createTestConfigObj({
				hooks: {
					unknown_hook: true,
				},
			});

			const result = runConfigDoctor(config, tempDir);

			expect(result.findings).toHaveLength(1);
			expect(result.findings[0]!.id).toBe('unknown-hook-field');
			expect(result.findings[0]!.severity).toBe('info');
			expect(result.findings[0]!.autoFixable).toBe(true);
		});

		it('should detect out-of-bounds qa_retry_limit', () => {
			const config = createTestConfigObj({
				qa_retry_limit: 100,
			});

			const result = runConfigDoctor(config, tempDir);

			expect(result.findings).toHaveLength(1);
			expect(result.findings[0]!.id).toBe('out-of-bounds-retry-limit');
			expect(result.findings[0]!.proposedFix?.value).toBe(10);
		});

		it('should detect unknown swarm agents', () => {
			const config = createTestConfigObj({
				swarms: {
					local: {
						agents: {
							unknown_agent: { model: 'gpt-4' },
						},
					},
				},
			});

			const result = runConfigDoctor(config, tempDir);

			expect(result.findings.length).toBeGreaterThan(0);
			expect(result.findings.some((f) => f.id === 'unknown-swarm-agent')).toBe(
				true,
			);
		});
	});

	describe('createConfigBackup', () => {
		it('should return null when no config exists', () => {
			// Use a completely isolated temp directory with no user config
			// Set XDG_CONFIG_HOME to isolate from host machine's user config
			const originalXdgConfig = process.env.XDG_CONFIG_HOME;
			const isolatedDir = fs.mkdtempSync(
				path.join(os.tmpdir(), 'isolated-test-'),
			);
			try {
				// Override config paths to point within isolatedDir
				process.env.XDG_CONFIG_HOME = path.join(isolatedDir, '.config');

				const backup = createConfigBackup(isolatedDir);
				expect(backup).toBeNull();
			} finally {
				// Properly restore environment - delete if it was undefined originally
				if (originalXdgConfig === undefined) {
					delete process.env.XDG_CONFIG_HOME;
				} else {
					process.env.XDG_CONFIG_HOME = originalXdgConfig;
				}
				fs.rmSync(isolatedDir, { recursive: true, force: true });
			}
		});

		it('should create backup when config exists', () => {
			createTestConfig(tempDir, { max_iterations: 5 });

			const backup = createConfigBackup(tempDir);

			expect(backup).not.toBeNull();
			expect(backup!.content).toContain('max_iterations');
			expect(backup!.contentHash).toBeTruthy();
		});
	});

	describe('applySafeAutoFixes', () => {
		it('should not modify config when no fixes needed', () => {
			const configPath = createTestConfig(tempDir, { max_iterations: 5 });
			const originalContent = fs.readFileSync(configPath, 'utf-8');

			const result: ConfigDoctorResult = {
				findings: [],
				summary: { info: 0, warn: 0, error: 0 },
				hasAutoFixableIssues: false,
				timestamp: Date.now(),
				configSource: configPath,
			};

			const { appliedFixes, updatedConfigPath } = applySafeAutoFixes(
				tempDir,
				result,
			);

			expect(appliedFixes).toHaveLength(0);
			expect(updatedConfigPath).toBeNull();
			expect(fs.readFileSync(configPath, 'utf-8')).toBe(originalContent);
		});

		it('should apply safe fixes to config', () => {
			createTestConfig(tempDir, {
				max_iterations: 100,
				qa_retry_limit: 3,
			});

			const result: ConfigDoctorResult = {
				findings: [
					{
						id: 'out-of-bounds-iterations',
						title: 'max_iterations out of bounds',
						description: 'Out of bounds',
						severity: 'error',
						path: 'max_iterations',
						currentValue: 100,
						autoFixable: true,
						proposedFix: {
							type: 'update',
							path: 'max_iterations',
							value: 10,
							description: 'Clamp to valid range',
							risk: 'low',
						},
					},
				],
				summary: { info: 0, warn: 0, error: 1 },
				hasAutoFixableIssues: true,
				timestamp: Date.now(),
				configSource: 'test',
			};

			const { appliedFixes, updatedConfigPath } = applySafeAutoFixes(
				tempDir,
				result,
			);

			expect(appliedFixes).toHaveLength(1);
			expect(updatedConfigPath).not.toBeNull();

			const updatedConfig = JSON.parse(
				fs.readFileSync(updatedConfigPath!, 'utf-8'),
			);
			expect(updatedConfig.max_iterations).toBe(10);
		});

		it('should not apply high-risk fixes', () => {
			createTestConfig(tempDir, {
				agents: { coder: { model: 'gpt-4' } },
			});

			const result: ConfigDoctorResult = {
				findings: [
					{
						id: 'deprecated-agents-config',
						title: 'Deprecated agents',
						description: 'Deprecated',
						severity: 'warn',
						path: 'agents',
						autoFixable: false,
						proposedFix: {
							type: 'remove',
							path: 'agents',
							description: 'Remove deprecated',
							risk: 'high',
						},
					},
				],
				summary: { info: 0, warn: 1, error: 0 },
				hasAutoFixableIssues: false,
				timestamp: Date.now(),
				configSource: 'test',
			};

			const { appliedFixes } = applySafeAutoFixes(tempDir, result);

			expect(appliedFixes).toHaveLength(0);

			// Config should remain unchanged
			const config = JSON.parse(
				fs.readFileSync(
					path.join(tempDir, '.opencode', 'opencode-swarm.json'),
					'utf-8',
				),
			);
			expect(config.agents).toBeDefined();
		});

		it('should apply multiple fixes', () => {
			createTestConfig(tempDir, {
				max_iterations: 100,
				qa_retry_limit: 50,
			});

			const result: ConfigDoctorResult = {
				findings: [
					{
						id: 'out-of-bounds-iterations',
						title: 'max_iterations out of bounds',
						description: 'Out of bounds',
						severity: 'error',
						path: 'max_iterations',
						currentValue: 100,
						autoFixable: true,
						proposedFix: {
							type: 'update',
							path: 'max_iterations',
							value: 10,
							description: 'Clamp to valid range',
							risk: 'low',
						},
					},
					{
						id: 'out-of-bounds-retry-limit',
						title: 'qa_retry_limit out of bounds',
						description: 'Out of bounds',
						severity: 'error',
						path: 'qa_retry_limit',
						currentValue: 50,
						autoFixable: true,
						proposedFix: {
							type: 'update',
							path: 'qa_retry_limit',
							value: 10,
							description: 'Clamp to valid range',
							risk: 'low',
						},
					},
				],
				summary: { info: 0, warn: 0, error: 2 },
				hasAutoFixableIssues: true,
				timestamp: Date.now(),
				configSource: 'test',
			};

			const { appliedFixes, updatedConfigPath } = applySafeAutoFixes(
				tempDir,
				result,
			);

			expect(appliedFixes).toHaveLength(2);
			expect(updatedConfigPath).not.toBeNull();

			const updatedConfig = JSON.parse(
				fs.readFileSync(updatedConfigPath!, 'utf-8'),
			);
			expect(updatedConfig.max_iterations).toBe(10);
			expect(updatedConfig.qa_retry_limit).toBe(10);
		});

		it('should handle null intermediate parent by skipping fix gracefully', () => {
			// Config where automation is null - path to automation.capabilities should fail
			createTestConfig(tempDir, {
				automation: null,
				max_iterations: 5,
			});

			const result: ConfigDoctorResult = {
				findings: [
					{
						id: 'invalid-capability-type',
						title: 'Invalid capability type',
						description: 'Invalid type',
						severity: 'error',
						path: 'automation.capabilities.config_doctor_on_startup',
						currentValue: 'yes',
						autoFixable: true,
						proposedFix: {
							type: 'update',
							path: 'automation.capabilities.config_doctor_on_startup',
							value: false,
							description: 'Fix capability',
							risk: 'low',
						},
					},
				],
				summary: { info: 0, warn: 0, error: 1 },
				hasAutoFixableIssues: true,
				timestamp: Date.now(),
				configSource: 'test',
			};

			const { appliedFixes } = applySafeAutoFixes(tempDir, result);

			// Fix should be skipped because automation is null (can't create path)
			expect(appliedFixes).toHaveLength(0);

			// Original config should remain unchanged
			const config = JSON.parse(
				fs.readFileSync(
					path.join(tempDir, '.opencode', 'opencode-swarm.json'),
					'utf-8',
				),
			);
			expect(config.automation).toBeNull();
		});

		it('should handle undefined intermediate parent by creating path', () => {
			// Config where automation.capabilities is undefined - should create path
			createTestConfig(tempDir, {
				automation: {},
				max_iterations: 5,
			});

			const result: ConfigDoctorResult = {
				findings: [
					{
						id: 'invalid-capability-type',
						title: 'Invalid capability type',
						description: 'Invalid type',
						severity: 'error',
						path: 'automation.capabilities.config_doctor_on_startup',
						currentValue: 'yes',
						autoFixable: true,
						proposedFix: {
							type: 'update',
							path: 'automation.capabilities.config_doctor_on_startup',
							value: false,
							description: 'Fix capability',
							risk: 'low',
						},
					},
				],
				summary: { info: 0, warn: 0, error: 1 },
				hasAutoFixableIssues: true,
				timestamp: Date.now(),
				configSource: 'test',
			};

			const { appliedFixes, updatedConfigPath } = applySafeAutoFixes(
				tempDir,
				result,
			);

			// Fix should succeed because intermediate path is created
			expect(appliedFixes).toHaveLength(1);
			expect(updatedConfigPath).not.toBeNull();

			const config = JSON.parse(fs.readFileSync(updatedConfigPath!, 'utf-8'));
			// The automation object should now have capabilities with the fix applied
			expect(config.automation.capabilities).toEqual({
				config_doctor_on_startup: false,
			});
		});

		it('should handle non-object intermediate parent by skipping fix gracefully', () => {
			// Config where automation is a string - can't traverse
			createTestConfig(tempDir, {
				automation: 'not-an-object',
				max_iterations: 5,
			});

			const result: ConfigDoctorResult = {
				findings: [
					{
						id: 'invalid-capability-type',
						title: 'Invalid capability type',
						description: 'Invalid type',
						severity: 'error',
						path: 'automation.capabilities.config_doctor_on_startup',
						currentValue: 'yes',
						autoFixable: true,
						proposedFix: {
							type: 'update',
							path: 'automation.capabilities.config_doctor_on_startup',
							value: false,
							description: 'Fix capability',
							risk: 'low',
						},
					},
				],
				summary: { info: 0, warn: 0, error: 1 },
				hasAutoFixableIssues: true,
				timestamp: Date.now(),
				configSource: 'test',
			};

			const { appliedFixes } = applySafeAutoFixes(tempDir, result);

			// Fix should be skipped because automation is a string (not an object)
			expect(appliedFixes).toHaveLength(0);

			// Original config should remain unchanged
			const config = JSON.parse(
				fs.readFileSync(
					path.join(tempDir, '.opencode', 'opencode-swarm.json'),
					'utf-8',
				),
			);
			expect(config.automation).toBe('not-an-object');
		});
	});

	describe('writeDoctorArtifact', () => {
		it('should write artifact to .swarm directory', () => {
			const result: ConfigDoctorResult = {
				findings: [],
				summary: { info: 0, warn: 0, error: 0 },
				hasAutoFixableIssues: false,
				timestamp: Date.now(),
				configSource: 'test',
			};

			const artifactPath = writeDoctorArtifact(tempDir, result);

			expect(artifactPath).toContain('.swarm');
			expect(artifactPath).toContain('config-doctor.json');

			const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
			expect(artifact.timestamp).toBe(result.timestamp);
			expect(artifact.summary).toEqual(result.summary);
		});

		it('should create .swarm directory if not exists', () => {
			const swarmDir = path.join(tempDir, '.swarm');
			expect(fs.existsSync(swarmDir)).toBe(false);

			const result: ConfigDoctorResult = {
				findings: [],
				summary: { info: 0, warn: 0, error: 0 },
				hasAutoFixableIssues: false,
				timestamp: Date.now(),
				configSource: 'test',
			};

			writeDoctorArtifact(tempDir, result);

			expect(fs.existsSync(swarmDir)).toBe(true);
		});

		it('should include findings in GUI-friendly format', () => {
			const result: ConfigDoctorResult = {
				findings: [
					{
						id: 'test-finding',
						title: 'Test Finding',
						description: 'A test finding',
						severity: 'warn',
						path: 'test.path',
						autoFixable: true,
						proposedFix: {
							type: 'update',
							path: 'test.path',
							value: 'fixed',
							description: 'Fix it',
							risk: 'low',
						},
					},
				],
				summary: { info: 0, warn: 1, error: 0 },
				hasAutoFixableIssues: true,
				timestamp: Date.now(),
				configSource: 'test',
			};

			const artifactPath = writeDoctorArtifact(tempDir, result);
			const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));

			expect(artifact.findings).toHaveLength(1);
			expect(artifact.findings[0]!.id).toBe('test-finding');
			expect(artifact.findings[0]!.proposedFix).toBeDefined();
		});
	});

	describe('writeBackupArtifact', () => {
		it('should write backup metadata with full content to .swarm', () => {
			const largeContent = JSON.stringify({
				test: true,
				nested: {
					data: 'x'.repeat(1000), // Make it larger than 500 chars
				},
			});
			const backup: ConfigBackup = {
				createdAt: Date.now(),
				configPath: '/test/config.json',
				content: largeContent,
				contentHash: 'abc123',
			};

			const backupPath = writeBackupArtifact(tempDir, backup);

			expect(backupPath).toContain('.swarm');
			expect(backupPath).toContain('config-backup-');

			const artifact = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
			expect(artifact.createdAt).toBe(backup.createdAt);
			expect(artifact.contentHash).toBe(backup.contentHash);
			expect(artifact.preview).toContain('...'); // Preview is truncated
			// Full content is stored for rollback
			expect(artifact.content).toBe(backup.content);
			expect(artifact.content.length).toBeGreaterThan(500);
		});

		it('should store full content for rollback support', () => {
			const backup: ConfigBackup = {
				createdAt: Date.now(),
				configPath: '/test/config.json',
				content: '{ "test": true }',
				contentHash: 'abc123',
			};

			const backupPath = writeBackupArtifact(tempDir, backup);
			const artifact = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));

			// Full content should be stored
			expect(artifact.content).toBe('{ "test": true }');
		});
	});

	describe('restoreFromBackup', () => {
		it('should restore config from backup artifact', () => {
			// Create the target directory first
			const configDir = path.join(tempDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });

			// Create and write backup with correct SHA-256 hash
			const content = '{ "restored": true, "max_iterations": 5 }';
			const backup: ConfigBackup = {
				createdAt: Date.now(),
				configPath: path.join(configDir, 'opencode-swarm.json'),
				content,
				contentHash:
					'8e8432495dd934d84dd4dad3d6c6ea588d743fa38fe0bc3a24e0b4e9c7d99231', // SHA-256
			};

			const backupPath = writeBackupArtifact(tempDir, backup);

			// Restore from backup (requires directory parameter)
			const restoredPath = restoreFromBackup(backupPath, tempDir);

			expect(restoredPath).not.toBeNull();
			expect(restoredPath).toContain('.opencode');

			const restoredContent = fs.readFileSync(restoredPath!, 'utf-8');
			const restoredConfig = JSON.parse(restoredContent);
			expect(restoredConfig.restored).toBe(true);
			expect(restoredConfig.max_iterations).toBe(5);
		});

		it('should return null for non-existent backup', () => {
			const result = restoreFromBackup('/non/existent/path.json', tempDir);
			expect(result).toBeNull();
		});

		it('should return null for corrupted artifact', () => {
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			const badPath = path.join(swarmDir, 'config-backup-bad.json');
			// Write invalid JSON
			fs.writeFileSync(badPath, 'not valid json', 'utf-8');

			const result = restoreFromBackup(badPath, tempDir);
			expect(result).toBeNull();
		});

		it('should return null for missing content hash', () => {
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			const badPath = path.join(swarmDir, 'config-backup-bad.json');
			// Write artifact without required fields
			fs.writeFileSync(
				badPath,
				JSON.stringify({ createdAt: Date.now(), configPath: '/test.json' }),
				'utf-8',
			);

			const result = restoreFromBackup(badPath, tempDir);
			expect(result).toBeNull();
		});

		it('should return null when content hash verification fails', () => {
			// Create the target directory first
			const configDir = path.join(tempDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });

			const content = '{ "test": true }';
			const backup: ConfigBackup = {
				createdAt: Date.now(),
				configPath: path.join(configDir, 'opencode-swarm.json'),
				content,
				contentHash:
					'4c2435a5afdfb453a07b6dae61683536675a4d70d8a518a27445b13e248ff1e7', // SHA-256
			};

			const backupPath = writeBackupArtifact(tempDir, backup);

			// Corrupt the artifact by changing the content but keeping the wrong hash
			const artifact = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
			artifact.content = '{ "test": false }'; // Change content but not hash
			fs.writeFileSync(backupPath, JSON.stringify(artifact), 'utf-8');

			const result = restoreFromBackup(backupPath, tempDir);
			expect(result).toBeNull();
		});

		// SECURITY TESTS: Path traversal protection
		it('should reject restore to path with traversal attempt (../)', () => {
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			const badPath = path.join(swarmDir, 'config-backup-bad.json');

			// Write artifact with path traversal attempt
			fs.writeFileSync(
				badPath,
				JSON.stringify({
					createdAt: Date.now(),
					configPath: '../../../etc/passwd',
					content: '{ "hacked": true }',
					contentHash:
						'a1b2c3d4e5f6789012345678abcdef0123456789abcdef0123456789abcdef01',
				}),
				'utf-8',
			);

			const result = restoreFromBackup(badPath, tempDir);
			expect(result).toBeNull();
		});

		it('should reject restore to arbitrary path outside config locations', () => {
			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			const badPath = path.join(swarmDir, 'config-backup-bad.json');

			// Write artifact trying to restore to a non-config location
			fs.writeFileSync(
				badPath,
				JSON.stringify({
					createdAt: Date.now(),
					configPath: '/tmp/opencode-swarm.json',
					content: '{ "hacked": true }',
					contentHash:
						'a1b2c3d4e5f6789012345678abcdef0123456789abcdef0123456789abcdef01',
				}),
				'utf-8',
			);

			const result = restoreFromBackup(badPath, tempDir);
			expect(result).toBeNull();
		});

		it('should allow restore to valid project config path', () => {
			const configDir = path.join(tempDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });

			const content = '{ "test": true }';
			const backup: ConfigBackup = {
				createdAt: Date.now(),
				configPath: path.join(tempDir, '.opencode', 'opencode-swarm.json'),
				content,
				contentHash:
					'4c2435a5afdfb453a07b6dae61683536675a4d70d8a518a27445b13e248ff1e7', // SHA-256
			};

			const backupPath = writeBackupArtifact(tempDir, backup);

			// Should succeed - valid project config path
			const restoredPath = restoreFromBackup(backupPath, tempDir);
			expect(restoredPath).not.toBeNull();
			expect(restoredPath).toContain('.opencode');
		});

		it('should allow restore to valid user config path', () => {
			const origXdg = process.env.XDG_CONFIG_HOME;
			process.env.XDG_CONFIG_HOME = tempDir;
			try {
				// Create user config directory using the isolated XDG dir
				const userConfigDir = path.join(tempDir, 'opencode');
				fs.mkdirSync(userConfigDir, { recursive: true });

				const content = '{ "user": true }';
				const userConfigPath = path.join(userConfigDir, 'opencode-swarm.json');

				const backup: ConfigBackup = {
					createdAt: Date.now(),
					configPath: userConfigPath,
					content,
					contentHash:
						'4530062bf0eeb64169f72c350fc709175b5719f2ef11017eefea9613c3ba568d', // SHA-256
				};

				const backupPath = writeBackupArtifact(tempDir, backup);

				// Should succeed - valid user config path
				const restoredPath = restoreFromBackup(backupPath, tempDir);
				expect(restoredPath).not.toBeNull();
			} finally {
				if (origXdg === undefined) {
					delete process.env.XDG_CONFIG_HOME;
				} else {
					process.env.XDG_CONFIG_HOME = origXdg;
				}
			}
		});

		// Backward compatibility: test that old numeric hashes still work
		it('should allow restore with legacy hash format for backward compatibility', () => {
			const configDir = path.join(tempDir, '.opencode');
			fs.mkdirSync(configDir, { recursive: true });

			const swarmDir = path.join(tempDir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });

			const content = '{ "legacy": true }';
			const legacyPath = path.join(swarmDir, 'config-backup-legacy.json');

			// Write artifact with old-style numeric hash (legacy format)
			fs.writeFileSync(
				legacyPath,
				JSON.stringify({
					createdAt: Date.now(),
					configPath: path.join(configDir, 'opencode-swarm.json'),
					content,
					contentHash: '12345', // Legacy numeric hash
				}),
				'utf-8',
			);

			// Should succeed despite legacy hash format (backward compat)
			const restoredPath = restoreFromBackup(legacyPath, tempDir);
			expect(restoredPath).not.toBeNull();
		});
	});

	describe('getConfigPaths', () => {
		it('should return correct config paths', () => {
			const { userConfigPath, projectConfigPath } = getConfigPaths(tempDir);

			expect(userConfigPath).toContain('.config');
			expect(userConfigPath).toContain('opencode');
			expect(projectConfigPath).toContain('.opencode');
		});
	});

	describe('shouldRunOnStartup', () => {
		it('should return false when automation is undefined', () => {
			expect(shouldRunOnStartup(undefined)).toBe(false);
		});

		it('should return false when mode is manual', () => {
			const config = {
				mode: 'manual' as const,
				capabilities: { config_doctor_on_startup: true },
			};
			expect(shouldRunOnStartup(config)).toBe(false);
		});

		it('should return false when capability is disabled', () => {
			const config = {
				mode: 'hybrid' as const,
				capabilities: { config_doctor_on_startup: false },
			};
			expect(shouldRunOnStartup(config)).toBe(false);
		});

		it('should return true when mode is not manual and capability is enabled', () => {
			const config = {
				mode: 'hybrid' as const,
				capabilities: { config_doctor_on_startup: true },
			};
			expect(shouldRunOnStartup(config)).toBe(true);
		});

		it('should return true for auto mode with capability enabled', () => {
			const config = {
				mode: 'auto' as const,
				capabilities: { config_doctor_on_startup: true },
			};
			expect(shouldRunOnStartup(config)).toBe(true);
		});
	});

	describe('runConfigDoctorWithFixes', () => {
		it('should run doctor without fixes when autoFix is false', async () => {
			createTestConfig(tempDir, { max_iterations: 5 });

			const config = createTestConfigObj();

			const result = await runConfigDoctorWithFixes(tempDir, config, false);

			expect(result.result.findings).toHaveLength(0);
			expect(result.backupPath).toBeNull();
			expect(result.appliedFixes).toHaveLength(0);
			expect(result.artifactPath).not.toBeNull();
		});

		it('should create backup and apply fixes when autoFix is true', async () => {
			createTestConfig(tempDir, { max_iterations: 100 });

			const config = createTestConfigObj({
				max_iterations: 100,
			});

			const result = await runConfigDoctorWithFixes(tempDir, config, true);

			expect(result.result.findings.length).toBeGreaterThan(0);
			expect(result.backupPath).not.toBeNull();
			expect(result.appliedFixes.length).toBeGreaterThan(0);
			expect(result.updatedConfigPath).not.toBeNull();

			// Verify config was actually updated
			const updatedConfig = JSON.parse(
				fs.readFileSync(result.updatedConfigPath!, 'utf-8'),
			);
			expect(updatedConfig.max_iterations).toBeLessThanOrEqual(10);
		});

		it('should re-read config from file for post-fix result verification', async () => {
			// Create a config with an issue
			createTestConfig(tempDir, { max_iterations: 100 });

			// Pass a config object that has the SAME issue (simulating stale in-memory)
			const staleConfig = createTestConfigObj({
				max_iterations: 100,
			});

			const result = await runConfigDoctorWithFixes(tempDir, staleConfig, true);

			// The original result should show the finding
			const originalFinding = result.result.findings.find(
				(f) => f.id === 'out-of-bounds-iterations',
			);
			expect(originalFinding).toBeDefined();

			// But the artifact should reflect the FIXED state (re-read from file)
			const artifact = JSON.parse(
				fs.readFileSync(
					path.join(tempDir, '.swarm', 'config-doctor.json'),
					'utf-8',
				),
			) as ConfigDoctorResult;

			// After fix, there should be no out-of-bounds-iterations finding
			const postFixFinding = artifact.findings.find(
				(f) => f.id === 'out-of-bounds-iterations',
			);
			expect(postFixFinding).toBeUndefined();
		});

		it('should verify backup artifact contains full content for rollback', async () => {
			createTestConfig(tempDir, {
				max_iterations: 100,
				qa_retry_limit: 50,
			});

			const config = createTestConfigObj({
				max_iterations: 100,
				qa_retry_limit: 50,
			});

			const result = await runConfigDoctorWithFixes(tempDir, config, true);

			// Read backup artifact
			const artifact = JSON.parse(fs.readFileSync(result.backupPath!, 'utf-8'));

			// Should have full content
			expect(artifact.content).toBeDefined();
			expect(artifact.content).toContain('max_iterations');
			expect(artifact.content).toContain('100'); // Original value

			// Should also have preview for UI
			expect(artifact.preview).toBeDefined();
		});
	});

	describe('Integration: Full workflow', () => {
		it('should handle complex config with multiple issues', async () => {
			createTestConfig(tempDir, {
				max_iterations: 100,
				qa_retry_limit: 50,
				automation: {
					mode: 'invalid-mode',
					capabilities: {
						config_doctor_on_startup: 'yes',
					},
				},
				guardrails: {
					enabled: true,
					max_tool_calls: 200,
					max_duration_minutes: 30,
					max_repetitions: 10,
					max_consecutive_errors: 5,
					warning_threshold: 0.75,
					idle_timeout_minutes: 60,
					profiles: {
						unknown_agent: { max_tool_calls: 100 },
					},
				},
			});

			const config = createTestConfigObj({
				max_iterations: 100,
				qa_retry_limit: 50,
				automation: {
					mode: 'invalid-mode',
					capabilities: {
						config_doctor_on_startup: 'yes',
					},
				},
				guardrails: {
					enabled: true,
					max_tool_calls: 200,
					max_duration_minutes: 30,
					max_repetitions: 10,
					max_consecutive_errors: 5,
					warning_threshold: 0.75,
					idle_timeout_minutes: 60,
					profiles: {
						unknown_agent: { max_tool_calls: 100 },
					},
				},
			});

			const result = await runConfigDoctorWithFixes(tempDir, config, true);

			// Should have multiple findings
			expect(result.result.findings.length).toBeGreaterThan(4);
			expect(result.result.summary.error).toBeGreaterThan(0);

			// Should have applied fixes
			expect(result.appliedFixes.length).toBeGreaterThan(0);

			// Verify updated config
			const updatedConfig = JSON.parse(
				fs.readFileSync(result.updatedConfigPath!, 'utf-8'),
			);
			expect(updatedConfig.max_iterations).toBeLessThanOrEqual(10);
			expect(updatedConfig.qa_retry_limit).toBeLessThanOrEqual(10);
		});
	});
});
