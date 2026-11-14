import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Test suite for scripts/generate-mock-allowlist.sh
 *
 * Issue #3165 (C-2): the suite NEVER writes the tracked
 * scripts/mock-allowlist.txt. Every scenario runs the generator with
 * MOCK_ALLOWLIST_OUT pointing at a sandbox copy seeded from the tracked
 * bytes; a suite-level byte-identity assertion (beforeAll/afterAll hash)
 * proves the tracked file is untouched. The default-path control runs a
 * sandboxed COPY of the script (script + lib/) with the variable unset, so
 * even the SCRIPT_DIR-relative default lands inside the sandbox.
 */

const isWindows = process.platform === 'win32';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const SCRIPT_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'generate-mock-allowlist.sh',
);
const TRACKED_ALLOWLIST = path.join(REPO_ROOT, 'scripts', 'mock-allowlist.txt');
const TRACKED_BYTES = fs.readFileSync(TRACKED_ALLOWLIST);

function trackedHash(): string {
	return crypto
		.createHash('sha256')
		.update(fs.readFileSync(TRACKED_ALLOWLIST))
		.digest('hex');
}

const HASH_BEFORE = trackedHash();

/**
 * Creates a sandbox allowlist seeded with the tracked bytes and returns its
 * path. The caller owns cleanup (each test removes its own sandbox).
 */
function seedSandboxAllowlist(prefix: string): string {
	const sandbox = canonicalMkdtemp(prefix);
	fs.writeFileSync(path.join(sandbox, 'mock-allowlist.txt'), TRACKED_BYTES);
	return path.join(sandbox, 'mock-allowlist.txt');
}

function removeSandbox(target: string): void {
	fs.rmSync(path.dirname(target), { recursive: true, force: true });
}

function runGenerateAllowlist(
	outputPath: string,
	checkMode = false,
): {
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
		timeout: 120000,
		env: { ...process.env, MOCK_ALLOWLIST_OUT: outputPath },
	});

	return {
		stdout: result.stdout || '',
		stderr: result.stderr || '',
		exitCode: result.status ?? 1,
	};
}

describe('generate-mock-allowlist.sh', () => {
	test('suite never writes the tracked allowlist (#3165 C-2)', () => {
		expect(trackedHash()).toBe(HASH_BEFORE);
	});

	test('should run without error in check mode when allowlist is up-to-date', () => {
		if (isWindows) return;
		const sandbox = seedSandboxAllowlist('mock-allowlist-check-');
		try {
			const regen = runGenerateAllowlist(sandbox, false);
			expect(regen.exitCode, regen.stdout + regen.stderr).toBe(0);

			const result = runGenerateAllowlist(sandbox, true);
			expect(result.exitCode, result.stdout + result.stderr).toBe(0);
			expect(result.stderr).toContain('up-to-date');
		} finally {
			removeSandbox(sandbox);
		}
	});

	test('should detect when allowlist is out of sync', () => {
		if (isWindows) return;
		const sandbox = seedSandboxAllowlist('mock-allowlist-drift-');
		try {
			fs.appendFileSync(
				sandbox,
				'\n# drift-detection-test-only\nsrc/does-not-exist\n',
			);

			const result = runGenerateAllowlist(sandbox, true);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain('out of sync');
		} finally {
			removeSandbox(sandbox);
		}
	});

	test('should normalize mock.module targets correctly', () => {
		if (isWindows) return;
		const sandbox = seedSandboxAllowlist('mock-allowlist-norm-');
		try {
			const result = runGenerateAllowlist(sandbox, false);
			expect(result.stderr).toContain('Scanning test files');
			expect(result.stderr).toMatch(
				// BSD wc (macOS) right-justifies the count in a field of spaces
				// ("with      111 entries"); GNU wc does not. Allow flexible
				// whitespace. Issue #1729.
				/Updated .+ with\s+\d+ entries/,
			);
			expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		} finally {
			removeSandbox(sandbox);
		}
	});

	test('should produce valid allowlist format', () => {
		if (isWindows) return;
		const sandbox = seedSandboxAllowlist('mock-allowlist-format-');
		try {
			runGenerateAllowlist(sandbox, false);

			const content = fs.readFileSync(sandbox, 'utf-8');

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
		} finally {
			removeSandbox(sandbox);
		}
	});

	test('should organize allowlist by category', () => {
		if (isWindows) return;
		const sandbox = seedSandboxAllowlist('mock-allowlist-cat-');
		try {
			runGenerateAllowlist(sandbox, false);

			const content = fs.readFileSync(sandbox, 'utf-8');

			expect(content).toContain('# --- Node builtins ---');
			expect(content).toContain('# --- src ---');
		} finally {
			removeSandbox(sandbox);
		}
	});

	test('should produce consistent output (idempotent)', () => {
		if (isWindows) return;
		const sandbox = seedSandboxAllowlist('mock-allowlist-idem-');
		try {
			runGenerateAllowlist(sandbox, false);
			const firstRun = fs.readFileSync(sandbox, 'utf-8');

			runGenerateAllowlist(sandbox, false);
			const secondRun = fs.readFileSync(sandbox, 'utf-8');

			const normalize = (content: string) =>
				content
					.split('\n')
					.filter((line) => !line.startsWith('# Last updated:'))
					.join('\n');

			expect(normalize(firstRun)).toBe(normalize(secondRun));
		} finally {
			removeSandbox(sandbox);
		}
	});

	test('issue #1666: preserves # APPROVED-NEW markers across regeneration', () => {
		if (isWindows) return;
		const sandbox = seedSandboxAllowlist('mock-allowlist-marker-');
		try {
			// Seed a synthetic marker against an entry that already exists in
			// the repo (src/agents/critic). The generator must re-emit the
			// marker immediately above the entry after regen.
			const markerLine = '# APPROVED-NEW: src/agents/critic';
			fs.appendFileSync(sandbox, `\n${markerLine}\n`);
			runGenerateAllowlist(sandbox, false);
			const content = fs.readFileSync(sandbox, 'utf-8');
			expect(content).toContain(markerLine);
			// The marker must appear immediately above the entry it approves.
			const lines = content.split('\n');
			const markerIdx = lines.indexOf(markerLine);
			expect(markerIdx).toBeGreaterThan(-1);
			expect(lines[markerIdx + 1]).toBe('src/agents/critic');
		} finally {
			removeSandbox(sandbox);
		}
	});

	test('#3165 C-2 default-path control: sandboxed script copy without MOCK_ALLOWLIST_OUT writes only its own sibling file', () => {
		if (isWindows) return;
		// Copy the script AND its lib/ dependency into a sandbox dir so the
		// SCRIPT_DIR-relative default resolves inside the sandbox.
		const sandboxDir = canonicalMkdtemp('mock-allowlist-default-');
		try {
			fs.copyFileSync(
				SCRIPT_PATH,
				path.join(sandboxDir, 'generate-mock-allowlist.sh'),
			);
			fs.mkdirSync(path.join(sandboxDir, 'lib'));
			fs.copyFileSync(
				path.join(REPO_ROOT, 'scripts', 'lib', 'normalize-mock-target.sh'),
				path.join(sandboxDir, 'lib', 'normalize-mock-target.sh'),
			);
			const envWithoutOverride = { ...process.env };
			delete envWithoutOverride.MOCK_ALLOWLIST_OUT;

			const result = spawnSync(
				'bash',
				[path.join(sandboxDir, 'generate-mock-allowlist.sh')],
				{
					cwd: REPO_ROOT,
					encoding: 'utf-8',
					stdio: ['pipe', 'pipe', 'pipe'],
					timeout: 120000,
					env: envWithoutOverride,
				},
			);
			expect(result.status, result.stdout + result.stderr).toBe(0);
			// The default write landed at the script copy's sibling path.
			const sandboxOutput = path.join(sandboxDir, 'mock-allowlist.txt');
			expect(fs.existsSync(sandboxOutput)).toBe(true);
			const content = fs.readFileSync(sandboxOutput, 'utf-8');
			expect(content).toContain('# mock.module Allowlist');
			// And the tracked file was untouched (also proven suite-level).
			expect(trackedHash()).toBe(HASH_BEFORE);
		} finally {
			fs.rmSync(sandboxDir, { recursive: true, force: true });
		}
	});

	test('#3165 C-2: empty MOCK_ALLOWLIST_OUT behaves as unset (sandbox-copy default)', () => {
		if (isWindows) return;
		const sandboxDir = canonicalMkdtemp('mock-allowlist-empty-');
		try {
			fs.copyFileSync(
				SCRIPT_PATH,
				path.join(sandboxDir, 'generate-mock-allowlist.sh'),
			);
			fs.mkdirSync(path.join(sandboxDir, 'lib'));
			fs.copyFileSync(
				path.join(REPO_ROOT, 'scripts', 'lib', 'normalize-mock-target.sh'),
				path.join(sandboxDir, 'lib', 'normalize-mock-target.sh'),
			);
			const result = spawnSync(
				'bash',
				[path.join(sandboxDir, 'generate-mock-allowlist.sh')],
				{
					cwd: REPO_ROOT,
					encoding: 'utf-8',
					stdio: ['pipe', 'pipe', 'pipe'],
					timeout: 120000,
					env: { ...process.env, MOCK_ALLOWLIST_OUT: '' },
				},
			);
			expect(result.status, result.stdout + result.stderr).toBe(0);
			// ${VAR:-default}: the empty value falls back to the SCRIPT_DIR
			// default — inside the sandbox copy, that is the sibling file.
			expect(fs.existsSync(path.join(sandboxDir, 'mock-allowlist.txt'))).toBe(
				true,
			);
			expect(trackedHash()).toBe(HASH_BEFORE);
		} finally {
			fs.rmSync(sandboxDir, { recursive: true, force: true });
		}
	});

	afterAll(() => {
		// #3165 C-2 suite-level proof: the tracked file is byte-identical.
		expect(trackedHash()).toBe(HASH_BEFORE);
	});
});
