import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Test suite for scripts/generate-mock-allowlist.sh
 *
 * Verifies allowlist generation and drift detection.
 */

const isWindows = process.platform === 'win32';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const SCRIPT_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'generate-mock-allowlist.sh',
);
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'scripts', 'mock-allowlist.txt');
const ORIGINAL_ALLOWLIST = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');

function restoreAllowlist(): void {
	fs.writeFileSync(ALLOWLIST_PATH, ORIGINAL_ALLOWLIST);
}

function runGenerateAllowlist(checkMode = false): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	if (isWindows) {
		throw new Error('bash not available on Windows');
	}
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
		exitCode: result.status ?? 1,
	};
}

describe('generate-mock-allowlist.sh', () => {
	beforeEach(() => {
		restoreAllowlist();
	});

	afterEach(() => {
		restoreAllowlist();
	});

	test('should run without error in check mode when allowlist is up-to-date', () => {
		if (isWindows) return;
		const regen = runGenerateAllowlist(false);
		expect(regen.exitCode, regen.stdout + regen.stderr).toBe(0);

		const result = runGenerateAllowlist(true);
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(result.stderr).toContain('up-to-date');
	});

	test('should detect when allowlist is out of sync', () => {
		if (isWindows) return;
		// Wrap os.tmpdir() in realpathSync for canonical path on macOS
		// (/var → /private/var symlink). Issue #1729.
		const tempAllowlist = path.join(
			fs.realpathSync(os.tmpdir()),
			'mock-allowlist-drift-' + Date.now(),
		);
		fs.copyFileSync(ALLOWLIST_PATH, tempAllowlist);
		fs.appendFileSync(
			tempAllowlist,
			'\n# drift-detection-test-only\nsrc/does-not-exist\n',
		);

		fs.copyFileSync(tempAllowlist, ALLOWLIST_PATH);

		try {
			const result = runGenerateAllowlist(true);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain('out of sync');
		} finally {
			fs.unlinkSync(tempAllowlist);
		}
	});

	test('should normalize mock.module targets correctly', () => {
		if (isWindows) return;
		const result = runGenerateAllowlist(false);
		expect(result.stderr).toContain('Scanning test files');
		expect(result.stderr).toMatch(
			// BSD wc (macOS) right-justifies the count in a field of spaces
			// ("with      111 entries"); GNU wc does not. Allow flexible
			// whitespace. Issue #1729.
			/Updated scripts\/mock-allowlist\.txt with\s+\d+ entries/,
		);
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	});

	test('should produce valid allowlist format', () => {
		if (isWindows) return;
		runGenerateAllowlist(false);

		const content = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');

		expect(content).toContain('# mock.module Allowlist');
		expect(content).toContain('node:child_process');
		expect(content).toContain('node:fs');

		expect(content).toMatch(/src\/[a-zA-Z_-]+/);

		const lines = content.split('\n');
		for (const line of lines) {
			if (!line.trim() || line.startsWith('#')) continue;
			expect(line).not.toContain('../');
			expect(line).not.toContain('./');
		}
	});

	test('should organize allowlist by category', () => {
		if (isWindows) return;
		runGenerateAllowlist(false);

		const content = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');

		expect(content).toContain('# --- Node builtins ---');
		expect(content).toContain('# --- src ---');
	});

	test('should produce consistent output (idempotent)', () => {
		if (isWindows) return;
		runGenerateAllowlist(false);
		const firstRun = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');

		runGenerateAllowlist(false);
		const secondRun = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');

		const normalize = (content: string) =>
			content
				.split('\n')
				.filter((line) => !line.startsWith('# Last updated:'))
				.join('\n');

		expect(normalize(firstRun)).toBe(normalize(secondRun));
	});

	test('issue #1666: preserves # APPROVED-NEW markers across regeneration', () => {
		if (isWindows) return;
		// Seed a synthetic marker against an entry that already exists in the
		// repo (src/agents/critic). The generator must re-emit the marker
		// immediately above the entry after regen.
		const markerLine = '# APPROVED-NEW: src/agents/critic';
		fs.appendFileSync(ALLOWLIST_PATH, `\n${markerLine}\n`);
		runGenerateAllowlist(false);
		const content = fs.readFileSync(ALLOWLIST_PATH, 'utf-8');
		expect(content).toContain(markerLine);
		// The marker must appear immediately above the entry it approves.
		const lines = content.split('\n');
		const markerIdx = lines.indexOf(markerLine);
		expect(markerIdx).toBeGreaterThan(-1);
		expect(lines[markerIdx + 1]).toBe('src/agents/critic');
	});
});
