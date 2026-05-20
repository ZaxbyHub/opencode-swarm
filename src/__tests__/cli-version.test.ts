/**
 * Tests for CLI version flag parsing
 * Tests FR-001, FR-002: CLI version and -v/--version flag handling
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import pkg from '../../package.json';

describe('CLI version flag parsing', () => {
	async function runCli(
		args: string[],
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolve) => {
			const proc = spawn(
				'bun',
				[path.join(import.meta.dir, '../cli/index.ts'), ...args],
				{
					stdio: ['ignore', 'pipe', 'pipe'],
				},
			);
			let stdout = '';
			let stderr = '';
			proc.stdout?.on('data', (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on('data', (data) => {
				stderr += data.toString();
			});
			proc.on('close', (code) => {
				resolve({ stdout, stderr, exitCode: code ?? 0 });
			});
		});
	}

	it('should recognize --version flag and exit with code 0', async () => {
		const result = await runCli(['--version']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('opencode-swarm');
		expect(result.stdout).toContain(pkg.version);
	});

	it('should recognize -v flag and exit with code 0', async () => {
		const result = await runCli(['-v']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('opencode-swarm');
		expect(result.stdout).toContain(pkg.version);
	});

	it('should not interfere with --help flag behavior', async () => {
		const result = await runCli(['--help']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('opencode-swarm');
		expect(result.stdout).toContain('Usage:');
	});

	it('should not interfere with -h flag behavior', async () => {
		const result = await runCli(['-h']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('opencode-swarm');
		expect(result.stdout).toContain('Usage:');
	});

	it('should handle --version --help (version takes precedence)', async () => {
		const result = await runCli(['--version', '--help']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(pkg.version);
	});

	it('should handle --help --version (version takes precedence via includes)', async () => {
		const result = await runCli(['--help', '--version']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(pkg.version);
	});

	it('should handle -v --help (short version takes precedence)', async () => {
		const result = await runCli(['-v', '--help']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(pkg.version);
	});

	it('should handle --help -v (short version takes precedence after help)', async () => {
		const result = await runCli(['--help', '-v']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(pkg.version);
	});

	it('should handle --version -h (long version with short help)', async () => {
		const result = await runCli(['--version', '-h']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(pkg.version);
	});

	it('should handle -h --version (short help with long version)', async () => {
		const result = await runCli(['-h', '--version']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(pkg.version);
	});
});

describe('Diagnose service version check', () => {
	it('should include version in diagnose data', async () => {
		const { getDiagnoseData } = await import('../services/diagnose-service');

		// Use the project root for testing
		const diagnoseData = await getDiagnoseData(process.cwd());

		const versionCheck = diagnoseData.checks.find((c) => c.name === 'Version');
		expect(versionCheck).toBeDefined();
		expect(versionCheck?.detail).toContain(pkg.version);
	});

	it('should include version in markdown output', async () => {
		const { getDiagnoseData, formatDiagnoseMarkdown } = await import(
			'../services/diagnose-service'
		);

		const diagnoseData = await getDiagnoseData(process.cwd());
		const markdown = formatDiagnoseMarkdown(diagnoseData);

		expect(markdown).toContain(`**Version**: ${pkg.version}`);
		expect(markdown).toContain('✅');
	});
});
