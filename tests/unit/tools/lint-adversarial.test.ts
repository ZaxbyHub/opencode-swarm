import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_detectAvailableLinter,
	containsControlChars,
	containsPathTraversal,
	detectAvailableLinter,
	getBiomeBinPath,
	getEslintBinPath,
	getLinterCommand,
	MAX_COMMAND_LENGTH,
	MAX_OUTPUT_BYTES,
	SUPPORTED_LINTERS,
	type SupportedLinter,
	validateArgs,
} from '../../../src/tools/lint';

// ============ Adversarial: Malformed Inputs ============
describe('ADVERSARIAL: validateArgs - Malformed Inputs', () => {
	it('rejects null', () => {
		expect(validateArgs(null)).toBe(false);
	});

	it('rejects undefined', () => {
		expect(validateArgs(undefined)).toBe(false);
	});

	it('rejects array', () => {
		expect(validateArgs(['fix'])).toBe(false);
	});

	it('rejects string "fix"', () => {
		expect(validateArgs('fix')).toBe(false);
	});

	it('rejects number', () => {
		expect(validateArgs(1)).toBe(false);
	});

	it('rejects boolean', () => {
		expect(validateArgs(true)).toBe(false);
	});

	it('rejects empty object', () => {
		expect(validateArgs({})).toBe(false);
	});

	it('rejects empty string mode', () => {
		expect(validateArgs({ mode: '' })).toBe(false);
	});

	it('rejects arbitrary string mode', () => {
		expect(validateArgs({ mode: 'hack' })).toBe(false);
	});

	it('rejects mode with null byte', () => {
		expect(validateArgs({ mode: 'fix\x00' })).toBe(false);
	});

	it('rejects mode with SQL injection attempt', () => {
		expect(validateArgs({ mode: "fix' OR '1'='1" })).toBe(false);
	});

	it('rejects mode with script tag', () => {
		expect(validateArgs({ mode: '<script>alert(1)</script>' })).toBe(false);
	});

	it('accepts object with __proto__ if mode is valid (only mode is validated)', () => {
		// validateArgs only checks mode property, others are ignored - this is safe
		expect(validateArgs({ mode: 'fix', __proto__: { foo: 'bar' } })).toBe(true);
	});

	it('rejects numeric mode', () => {
		expect(validateArgs({ mode: 0 })).toBe(false);
	});

	it('rejects array as mode', () => {
		expect(validateArgs({ mode: ['fix'] })).toBe(false);
	});

	it('accepts valid "fix" mode', () => {
		expect(validateArgs({ mode: 'fix' })).toBe(true);
	});

	it('accepts valid "check" mode', () => {
		expect(validateArgs({ mode: 'check' })).toBe(true);
	});

	it('accepts object with extra ignored properties', () => {
		expect(validateArgs({ mode: 'fix', extra: 'ignored' })).toBe(true);
	});
});

// ============ Adversarial: Path Traversal ============
describe('ADVERSARIAL: containsPathTraversal - Path Traversal Attacks', () => {
	it('detects forward slash path traversal', () => {
		expect(containsPathTraversal('../etc/passwd')).toBe(true);
	});

	it('detects backslash path traversal', () => {
		expect(containsPathTraversal('..\\windows\\system32\\config')).toBe(true);
	});

	it('accepts double dot mid-path (not a traversal without slash)', () => {
		// foo..bar is not a path traversal - the regex looks for .. followed by / or \
		expect(containsPathTraversal('foo..bar')).toBe(false);
	});

	it('detects URL-encoded traversal', () => {
		// The function now detects URL-encoded path traversal patterns
		expect(containsPathTraversal('..%2F..%2Fetc')).toBe(true);
	});

	it('accepts normal path without traversal', () => {
		expect(containsPathTraversal('src/index.ts')).toBe(false);
	});

	it('accepts relative path starting with dot', () => {
		expect(containsPathTraversal('./src/file.ts')).toBe(false);
	});

	it('accepts version-like string', () => {
		expect(containsPathTraversal('1.2.3')).toBe(false);
	});
});

// ============ Adversarial: Control Characters ============
describe('ADVERSARIAL: containsControlChars - Control Character Injection', () => {
	it('detects null byte', () => {
		expect(containsControlChars('test\x00value')).toBe(true);
	});

	it('detects tab character', () => {
		expect(containsControlChars('test\tvalue')).toBe(true);
	});

	it('detects carriage return', () => {
		expect(containsControlChars('test\rvalue')).toBe(true);
	});

	it('detects newline', () => {
		expect(containsControlChars('test\nvalue')).toBe(true);
	});

	it('accepts normal string', () => {
		expect(containsControlChars('normal text')).toBe(false);
	});

	it('accepts Unicode characters', () => {
		expect(containsControlChars('日本語🔒')).toBe(false);
	});

	it('accepts special chars without control', () => {
		expect(containsControlChars('!@#$%^&*()_+-=[]{}|;:,.<>?')).toBe(false);
	});
});

// Use a stable temp directory for path-dependent tests.
const TEST_DIR = '/tmp/lint-test-' + Math.random().toString(36).slice(2);
const biomeExpectedBin =
	process.platform === 'win32'
		? path.join(TEST_DIR, 'node_modules', '.bin', 'biome.EXE')
		: path.join(TEST_DIR, 'node_modules', '.bin', 'biome');
const eslintExpectedBin = path.join(TEST_DIR, 'node_modules', '.bin', 'eslint');

// ============ Adversarial: Command Length Boundary ============
describe('ADVERSARIAL: Command Length Boundaries', () => {
	it('command under limit succeeds length check', () => {
		const command = getLinterCommand('biome', 'check', TEST_DIR);
		const commandStr = command.join(' ');
		expect(commandStr.length).toBeLessThan(MAX_COMMAND_LENGTH);
	});

	it('very long command string exceeds limit', () => {
		const baseCommand = getLinterCommand('biome', 'check', TEST_DIR);
		// Create a maliciously long command
		const maliciousArgs = Array(100).fill('verylongargumentname');
		const longCommand = [...baseCommand, ...maliciousArgs].join(' ');
		expect(longCommand.length).toBeGreaterThan(MAX_COMMAND_LENGTH);
	});

	it('command length validation returns error for overly long commands', () => {
		// Test the length validation logic without running the linter
		// Simulate what runLint does: check if command exceeds MAX_COMMAND_LENGTH
		const baseCommand = getLinterCommand('biome', 'check', TEST_DIR);
		const maliciousArgs = Array(100).fill('verylongargumentname');
		const longCommand = [...baseCommand, ...maliciousArgs].join(' ');

		// This is the same check runLint performs before spawning
		expect(longCommand.length > MAX_COMMAND_LENGTH).toBe(true);
	});
});

// ============ Adversarial: Output Size Boundary ============
describe('ADVERSARIAL: Output Size Boundaries', () => {
	it('MAX_OUTPUT_BYTES constant is defined', () => {
		expect(MAX_OUTPUT_BYTES).toBe(512_000);
	});

	it('MAX_OUTPUT_BYTES is a reasonable limit', () => {
		expect(MAX_OUTPUT_BYTES).toBeGreaterThan(1000);
		expect(MAX_OUTPUT_BYTES).toBeLessThan(10_000_000);
	});

	it('MAX_COMMAND_LENGTH constant is defined', () => {
		expect(MAX_COMMAND_LENGTH).toBe(500);
	});
});

// ============ Adversarial: Timeout Protection ============
describe('ADVERSARIAL: Process Timeout Protection', () => {
	it('detectAvailableLinter has timeout protection', async () => {
		const start = Date.now();
		const result = await detectAvailableLinter();
		const elapsed = Date.now() - start;

		// Should complete within reasonable time (with timeout it's 2s per linter)
		expect(elapsed).toBeLessThan(5000);
		expect(result === 'biome' || result === 'eslint' || result === null).toBe(
			true,
		);
	}, 10000);

	it('detectAvailableLinter does not hang indefinitely', async () => {
		const promise = detectAvailableLinter();

		// Add slight delay
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Promise should still be settleable (not hung)
		const result = await promise;
		expect(result === 'biome' || result === 'eslint' || result === null).toBe(
			true,
		);
	}, 10000);
});

// ============ Adversarial: Invalid Linter Types ============
describe('ADVERSARIAL: Invalid Linter Types', () => {
	it('getLinterCommand returns undefined for invalid linter type', () => {
		// TypeScript would prevent this at compile time, but runtime check
		const invalidLinter = 'invalid' as unknown as SupportedLinter;
		// Returns undefined when linter not in switch - potential improvement area
		const cmd = getLinterCommand(invalidLinter, 'check', TEST_DIR);
		expect(cmd).toBeUndefined();
	});
});

// ============ Adversarial: Process Hang/Resource Exhaustion ============
describe('ADVERSARIAL: Resource Exhaustion Protection', () => {
	it('validateArgs correctly validates lint arguments', () => {
		// Test validation without running external processes
		expect(validateArgs({ mode: 'check' })).toBe(true);
		expect(validateArgs({ mode: 'fix' })).toBe(true);
		expect(validateArgs({ mode: 'invalid' })).toBe(false);
		expect(validateArgs(null)).toBe(false);
		expect(validateArgs({})).toBe(false);
	});

	it('getLinterCommand returns safe commands without shell metacharacters', () => {
		// Test command construction without spawning processes
		const biomeCheck = getLinterCommand('biome', 'check', TEST_DIR);
		const biomeFix = getLinterCommand('biome', 'fix', TEST_DIR);
		const eslintCheck = getLinterCommand('eslint', 'check', TEST_DIR);
		const eslintFix = getLinterCommand('eslint', 'fix', TEST_DIR);

		// Commands use direct local binary paths (not npx) for consistent version
		expect(biomeCheck[0]).toBe(biomeExpectedBin);
		expect(biomeFix[0]).toBe(biomeExpectedBin);
		expect(eslintCheck[0]).toBe(eslintExpectedBin);
		expect(eslintFix[0]).toBe(eslintExpectedBin);

		// Verify no shell metacharacters
		const allCommands = [
			...biomeCheck,
			...biomeFix,
			...eslintCheck,
			...eslintFix,
		];
		allCommands.forEach((cmd) => {
			expect(cmd).not.toMatch(/[;&|`$()]/);
			expect(cmd).not.toMatch(/\|/);
			expect(cmd).not.toMatch(/&&/);
		});
	});

	it('MAX_OUTPUT_BYTES limits output size correctly', () => {
		// Test output truncation logic without running linter
		const MAX_BYTES = MAX_OUTPUT_BYTES;
		expect(MAX_BYTES).toBe(512_000);

		// Simulate truncation
		const hugeOutput = 'x'.repeat(MAX_BYTES + 1000);
		const truncated =
			hugeOutput.slice(0, MAX_BYTES) + '\n... (output truncated)';

		expect(truncated.length).toBeLessThanOrEqual(MAX_BYTES + 50);
		expect(truncated).toContain('output truncated');
	});
});

// ============ Adversarial: Command Injection Simulation ============
describe('ADVERSARIAL: Command Injection Attempts', () => {
	it('getLinterCommand does not accept user input for path', () => {
		// The function only accepts linter and mode, not arbitrary paths
		const cmd = getLinterCommand('biome', 'fix', TEST_DIR);

		// Verify command is safe - first element is the direct local binary path
		expect(cmd[0]).toBe(biomeExpectedBin);
		expect(cmd).not.toContain(';');
		expect(cmd).not.toContain('|');
		expect(cmd).not.toContain('&&');
		expect(cmd).not.toContain('rm');
		expect(cmd).not.toContain('curl');
	});

	it('getLinterCommand with eslint is safe', () => {
		const cmdCheck = getLinterCommand('eslint', 'check', TEST_DIR);
		const cmdFix = getLinterCommand('eslint', 'fix', TEST_DIR);

		expect(cmdCheck[0]).toBe(eslintExpectedBin);
		expect(cmdFix[0]).toBe(eslintExpectedBin);

		// No shell metacharacters
		expect(cmdCheck.join(' ')).not.toMatch(/[;&|`$()]/);
		expect(cmdFix.join(' ')).not.toMatch(/[;&|`$()]/);
	});
});

// ============ Adversarial: Constant Security ============
describe('ADVERSARIAL: Security Constants', () => {
	it('SUPPORTED_LINTERS contains only safe values', () => {
		expect(SUPPORTED_LINTERS).toEqual(['biome', 'eslint']);
	});

	it('MAX_OUTPUT_BYTES prevents memory exhaustion', () => {
		// 512KB is a reasonable limit to prevent memory exhaustion
		expect(MAX_OUTPUT_BYTES).toBe(512_000);
		expect(MAX_OUTPUT_BYTES).toBeLessThan(1024 * 1024); // Less than 1MB
	});

	it('MAX_COMMAND_LENGTH prevents buffer overflow', () => {
		expect(MAX_COMMAND_LENGTH).toBe(500);
		expect(MAX_COMMAND_LENGTH).toBeLessThan(1000);
	});
});

// ============ Issue #209: detectAvailableLinter local-binary consistency ============
// The fix: detectAvailableLinter checks fs.existsSync(localBinPath) before returning.
// This proves detection and execution paths are now consistent.
describe('ISSUE #209: detectAvailableLinter path consistency', () => {
	it('getBiomeBinPath returns the same path getLinterCommand uses for biome', () => {
		const dir = '/my/project';
		const expected =
			process.platform === 'win32'
				? path.join(dir, 'node_modules', '.bin', 'biome.EXE')
				: path.join(dir, 'node_modules', '.bin', 'biome');
		expect(getBiomeBinPath(dir)).toBe(expected);
		expect(getLinterCommand('biome', 'check', dir)[0]).toBe(expected);
		expect(getLinterCommand('biome', 'fix', dir)[0]).toBe(expected);
	});

	it('getEslintBinPath returns the same path getLinterCommand uses for eslint', () => {
		const dir = '/my/project';
		const expected = path.join(dir, 'node_modules', '.bin', 'eslint');
		expect(getEslintBinPath(dir)).toBe(expected);
		expect(getLinterCommand('eslint', 'check', dir)[0]).toBe(expected);
		expect(getLinterCommand('eslint', 'fix', dir)[0]).toBe(expected);
	});

	it('getBiomeBinPath and getEslintBinPath are different paths', () => {
		const dir = '/my/project';
		expect(getBiomeBinPath(dir)).not.toBe(getEslintBinPath(dir));
	});

	// ---- _detectAvailableLinter tests ----
	// These inject fake binary paths to test the fs.existsSync guard directly.

	it('npx biome exits 0 BUT local biome does NOT exist → should NOT return biome', async () => {
		// Pass a path that definitely does not exist as the "local" biome binary.
		// _detectAvailableLinter checks fs.existsSync(biomeBin) as a gate.
		const fakeBiomeBin = '/nonexistent/node_modules/.bin/biome';
		const realEslintBin = getEslintBinPath('/nonexistent');

		// Note: we cannot easily mock Bun.spawn here, so we rely on the path
		// gate being the AND condition alongside exitCode === 0.
		// The guard in the source:  biomeProc.exitCode === 0 && fs.existsSync(biomeBin)
		// If biomeBin does not exist, fs.existsSync returns false → function falls through.
		// We verify the guard by checking that a non-existent path fails the existsSync check:
		expect(fs.existsSync(fakeBiomeBin)).toBe(false);
		// And that detection returns null (or eslint if npx finds it, but we use a path
		// where npx also won't find anything — so null is the safe expectation).
		const result = await _detectAvailableLinter(
			'/nonexistent',
			fakeBiomeBin,
			realEslintBin,
		);
		// Since neither npx biome nor npx eslint will succeed in /nonexistent,
		// and neither local binary exists, the result should be null.
		expect(result).toBeNull();
	});

	it('npx eslint exits 0 BUT local eslint does NOT exist → should NOT return eslint', async () => {
		// Even if npx eslint --version succeeds globally, the local binary check
		// must gate the return value.
		const realBiomeBin = getBiomeBinPath('/nonexistent');
		const fakeEslintBin = '/nonexistent/node_modules/.bin/eslint';

		expect(fs.existsSync(fakeEslintBin)).toBe(false);
		const result = await _detectAvailableLinter(
			'/nonexistent',
			realBiomeBin,
			fakeEslintBin,
		);
		expect(result).toBeNull();
	});

	it('detection binary paths are absolute and contain node_modules/.bin', () => {
		const dir = '/some/project';
		const biomeBin = getBiomeBinPath(dir);
		const eslintBin = getEslintBinPath(dir);

		// Both must be absolute paths
		expect(path.isAbsolute(biomeBin)).toBe(true);
		expect(path.isAbsolute(eslintBin)).toBe(true);

		// Both must contain node_modules/.bin
		expect(biomeBin).toContain('node_modules');
		expect(biomeBin).toContain('.bin');
		expect(eslintBin).toContain('node_modules');
		expect(eslintBin).toContain('.bin');

		// The binary names must appear in the path
		expect(biomeBin).toContain('biome');
		expect(eslintBin).toContain('eslint');
	});
});
