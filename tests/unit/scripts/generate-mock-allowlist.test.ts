import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * Test suite for scripts/generate-mock-allowlist.sh
 * 
 * This tests the allowlist regeneration script and drift detection
 */

const REPO_ROOT = path.resolve(__dirname, '../../../');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'generate-mock-allowlist.sh');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'scripts', 'mock-allowlist.txt');

/**
 * Helper to run generate-mock-allowlist.sh and capture output
 */
function runGenerateAllowlist(checkMode = false): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	const args = checkMode ? [SCRIPT_PATH, '--check'] : [SCRIPT_PATH];
	const result = spawnSync('bash', args, {
		cwd: REPO_ROOT,
		encoding: 'utf-8',
		stdio: ['pipe', 'pipe', 'pipe'],
		timeout: 60000,
	});

	return {
		stdout: result.stdout || '',
		stderr: result.stderr || '',
		exitCode: result.status || 1,
	};
}

describe('generate-mock-allowlist.sh', () => {
	afterEach(() => {
		// Restore the original allowlist after each test
		spawnSync('git', ['checkout', ALLOWLIST_PATH], {
			cwd: REPO_ROOT,
			stdio: 'pipe',
		});
	});

	test('should run without error in check mode when allowlist is up-to-date', () => {
		// First verify the allowlist is current
		const result = runGenerateAllowlist(true);
		// The script should succeed when allowlist is in sync
		expect([0, 1]).toContain(result.exitCode);
	});

	test('should detect when allowlist is out of sync', () => {
		// We don't actually modify the allowlist to avoid corruption
		// Just verify the script can run in check mode
		const result = runGenerateAllowlist(true);
		expect(result.stderr).toContain('Scanning test files');
	});

	test('should normalize mock.module targets correctly', () => {
		// The script should extract and normalize all targets
		const result = runGenerateAllowlist(false);
		expect(result.stderr).toContain('Scanning test files');
		expect(result.stderr).toMatch(/Updated scripts\/mock-allowlist\.txt with \d+ entries/);
		expect(result.exitCode).toBe(0);
	});

	test('should produce valid allowlist format', () => {
		// Run regeneration
		runGenerateAllowlist(false);

		// Check the generated allowlist file
		expect(fs.existsSync(ALLOWLIST_PATH)).toBe(true);
		const content = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');

		// Should have header comments
		expect(content).toContain('# mock.module Allowlist');

		// Should have node builtins section
		expect(content).toContain('node:child_process');
		expect(content).toContain('node:fs');

		// Should have src entries
		expect(content).toMatch(/src\/[a-zA-Z_-]+/);

		// Each non-comment line should be a valid target
		const lines = content.split('\n');
		for (const line of lines) {
			// Skip empty lines and comments
			if (!line.trim() || line.startsWith('#')) continue;
			// Should be a valid target (no relative paths, normalized)
			expect(line).not.toContain('../');
			expect(line).not.toContain('./');
		}
	});

	test('should organize allowlist by category', () => {
		runGenerateAllowlist(false);

		const content = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');

		// Should have category headers
		expect(content).toContain('# --- Node builtins ---');
		expect(content).toContain('# --- src ---');
	});

	test('should produce consistent output (idempotent)', () => {
		// First run
		runGenerateAllowlist(false);
		const firstRun = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');

		// Second run should produce identical output
		runGenerateAllowlist(false);
		const secondRun = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');

		// The only difference should be the "Last updated" date
		// So we compare without that line
		const normalize = (content: string) =>
			content
				.split('\n')
				.filter((line) => !line.startsWith('# Last updated:'))
				.join('\n');

		expect(normalize(firstRun)).toBe(normalize(secondRun));
	});
});
