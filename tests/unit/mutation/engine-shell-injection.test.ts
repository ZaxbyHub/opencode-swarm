import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
	vi,
} from 'bun:test';
import type { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as realFs from 'node:fs';

// Mock the modules BEFORE importing the module under test.
//
// `spawnSync` is intercepted via the engine's `_internals` DI seam (see
// AGENTS.md invariant 7 — DI over `mock.module`). The engine binds
// `spawnSync` into `_internals.spawnSync` at module-load time, so a
// `mock.module('node:child_process', ...)` cannot intercept those calls; the
// seam is the supported interception point (mirrors the pattern in
// src/tools/__tests__/mutation-test.adversarial.test.ts). The fs writes are
// stubbed via `mock.module` so the test never touches the filesystem.
const mockSpawnSync = vi.fn<
	[string, string[], unknown?],
	ReturnType<typeof spawnSync>
>();
const mockWriteFileSync = vi.fn<[string, string], void>();
const mockUnlinkSync = vi.fn<[string], void>();

mock.module('node:fs', () => ({
	...realFs,
	unlinkSync: (...args: unknown[]) => mockUnlinkSync(...(args as [string])),
	writeFileSync: (...args: unknown[]) =>
		mockWriteFileSync(...(args as [string, string])),
}));

// Import after mocks are set up
import {
	_internals as engineInternals,
	executeMutation,
	type MutationPatch,
} from '../../../src/mutation/engine';

// Saved real spawnSync so it can be restored after each test, keeping the
// seam injection isolated from other test files.
let originalSpawnSync: typeof engineInternals.spawnSync;

describe('executeMutation - shell injection mitigation', () => {
	const workingDir = '/fake/workdir';
	const testCommand = ['npm', 'test'];

	beforeEach(() => {
		vi.clearAllMocks();

		mockWriteFileSync.mockReturnValue(undefined as unknown as undefined);
		mockUnlinkSync.mockReturnValue(undefined as unknown as undefined);

		// Inject the spawnSync spy through the engine's DI seam, saving the
		// real binding for restoration in afterEach.
		originalSpawnSync = engineInternals.spawnSync;
		engineInternals.spawnSync =
			mockSpawnSync as unknown as typeof engineInternals.spawnSync;

		// Default: successful git apply and revert
		mockSpawnSync.mockImplementation(
			(command: string, args: string[], _options?: unknown) => {
				if (command === 'git' && args[0] === 'apply' && !args.includes('-R')) {
					return { status: 0, stdout: '', stderr: Buffer.from('') };
				}
				if (command === 'git' && args.includes('-R')) {
					return { status: 0, stdout: '', stderr: Buffer.from('') };
				}
				// Default for test command
				return {
					status: 0,
					stdout: Buffer.from('Tests passed'),
					stderr: Buffer.from(''),
					error: undefined,
				};
			},
		);
	});

	afterEach(() => {
		// Restore the real spawnSync binding so the seam injection does not
		// leak into other tests/files.
		engineInternals.spawnSync = originalSpawnSync;
		vi.restoreAllMocks();
		mock.restore();
	});

	describe('patch.id sanitization', () => {
		test('shell metacharacter: semicolon gets sanitized in filename', async () => {
			const maliciousId = 'patch; rm -rf /';
			const patch: MutationPatch = {
				id: maliciousId,
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'diff content',
			};

			await executeMutation(patch, testCommand, [], workingDir);

			// Verify writeFileSync was called with a sanitized path
			const writeCall = mockWriteFileSync.mock.calls[0];
			const patchFilePath = writeCall[0];

			// The path should NOT contain shell metacharacters
			expect(patchFilePath).not.toContain(';');
			expect(patchFilePath).not.toContain('rm -rf');
			// The path should use underscores instead of special chars
			// patch; rm -rf / -> patch__rm_-rf__ (each special char becomes _)
			expect(patchFilePath).toContain('patch__rm_-rf__');
		});

		test('shell metacharacter: command substitution $(whoami) gets sanitized', async () => {
			const maliciousId = 'patch$(whoami)';
			const patch: MutationPatch = {
				id: maliciousId,
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'diff content',
			};

			await executeMutation(patch, testCommand, [], workingDir);

			const writeCall = mockWriteFileSync.mock.calls[0];
			const patchFilePath = writeCall[0];

			// The path should NOT contain $(
			expect(patchFilePath).not.toContain('$(');
			expect(patchFilePath).not.toContain('$');
			expect(patchFilePath).not.toContain('()');
			// patch$(whoami) -> patch__whoami_ (special chars replaced with _)
			// Note: whoami is alphanumeric so it's preserved - the injection attempt is blocked
			// by replacing $ and () which are the actual shell metacharacters
			expect(patchFilePath).toContain('patch__whoami_');
		});

		test('shell metacharacter: backticks get sanitized', async () => {
			const maliciousId = 'patch`id`';
			const patch: MutationPatch = {
				id: maliciousId,
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'diff content',
			};

			await executeMutation(patch, testCommand, [], workingDir);

			const writeCall = mockWriteFileSync.mock.calls[0];
			const patchFilePath = writeCall[0];

			expect(patchFilePath).not.toContain('`');
			expect(patchFilePath).toContain('patch_id_');
		});

		test('shell metacharacter: pipe character gets sanitized', async () => {
			const maliciousId = 'patch|cat /etc/passwd';
			const patch: MutationPatch = {
				id: maliciousId,
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'diff content',
			};

			await executeMutation(patch, testCommand, [], workingDir);

			const writeCall = mockWriteFileSync.mock.calls[0];
			const patchFilePath = writeCall[0];

			expect(patchFilePath).not.toContain('|');
			expect(patchFilePath).toContain('patch_cat__etc_passwd');
		});

		test('shell metacharacter: ampersand gets sanitized', async () => {
			const maliciousId = 'patch& evil command';
			const patch: MutationPatch = {
				id: maliciousId,
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'diff content',
			};

			await executeMutation(patch, testCommand, [], workingDir);

			const writeCall = mockWriteFileSync.mock.calls[0];
			const patchFilePath = writeCall[0];

			expect(patchFilePath).not.toContain('&');
			expect(patchFilePath).toContain('patch__evil_command');
		});

		test('normal id without shell metacharacters stays unchanged', async () => {
			const safeId = 'patch_abc-123';
			const patch: MutationPatch = {
				id: safeId,
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'diff content',
			};

			await executeMutation(patch, testCommand, [], workingDir);

			const writeCall = mockWriteFileSync.mock.calls[0];
			const patchFilePath = writeCall[0];

			// Safe characters should be preserved
			expect(patchFilePath).toContain('patch_abc-123');
		});
	});

	describe('spawnSync array arguments for git apply', () => {
		test('git apply is called with array arguments (not string interpolation)', async () => {
			const patch: MutationPatch = {
				id: 'safe_patch',
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'diff content',
			};

			await executeMutation(patch, testCommand, [], workingDir);

			// Find the git apply call
			const gitApplyCalls = mockSpawnSync.mock.calls.filter(
				([cmd, args]) =>
					cmd === 'git' &&
					Array.isArray(args) &&
					args[0] === 'apply' &&
					!args.includes('-R'),
			);

			expect(gitApplyCalls.length).toBeGreaterThan(0);

			const [, applyArgs] = gitApplyCalls[0];
			// Verify it's an array
			expect(Array.isArray(applyArgs)).toBe(true);
			// Verify the patch file is passed as separate array element
			expect(applyArgs).toContain('apply');
			// The patch file path should be the last element or second element
			const patchFileArg = applyArgs[applyArgs.length - 1];
			expect(patchFileArg).toMatch(/mutation_patch.*\.diff$/);
		});

		test('git apply is NOT called with string interpolation', async () => {
			const patch: MutationPatch = {
				id: 'safe_patch',
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'diff content',
			};

			await executeMutation(patch, testCommand, [], workingDir);

			// Verify NO calls use template literals or string concatenation for args
			const allCalls = mockSpawnSync.mock.calls;
			for (const [cmd, args] of allCalls) {
				if (cmd === 'git' && Array.isArray(args)) {
					// Each arg should be a discrete string, not a combined string
					expect(args.every((a) => typeof a === 'string')).toBe(true);
				}
			}
		});
	});

	describe('spawnSync array arguments for git apply -R', () => {
		test('git apply -R is called with array arguments (not string interpolation)', async () => {
			const patch: MutationPatch = {
				id: 'safe_patch',
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'diff content',
			};

			await executeMutation(patch, testCommand, [], workingDir);

			// Find the git apply -R call
			const gitRevertCalls = mockSpawnSync.mock.calls.filter(
				([cmd, args]) =>
					cmd === 'git' && Array.isArray(args) && args.includes('-R'),
			);

			expect(gitRevertCalls.length).toBeGreaterThan(0);

			const [, revertArgs] = gitRevertCalls[0];
			// Verify it's an array
			expect(Array.isArray(revertArgs)).toBe(true);
			// Verify -R is a separate array element
			expect(revertArgs).toContain('-R');
			// The patch file path should be passed as separate element after -R (and possibly --)
			const rIndex = revertArgs.indexOf('-R');
			const patchArg = revertArgs.find((arg: string) =>
				/mutation_patch.*\.diff$/.test(arg),
			);
			expect(patchArg).toBeDefined();
		});
	});

	describe('execSync absence verification', () => {
		test('execSync is not imported or used', async () => {
			// Read the source file to verify no execSync import
			const sourceCode = fs.readFileSync(
				require.resolve('../../../src/mutation/engine'),
				'utf-8',
			);

			// Check import statement doesn't include execSync
			const execSyncImportRegex = /import\s+\{[^}]*execSync[^}]*\}\s+from/;
			expect(sourceCode).not.toMatch(execSyncImportRegex);

			// Check no execSync usage in the file
			expect(sourceCode).not.toMatch(/\bexecSync\s*\(/);
		});
	});

	describe('error handling for git apply failures', () => {
		test('non-zero spawnSync status for git apply triggers error outcome', async () => {
			const patch: MutationPatch = {
				id: 'failing_patch',
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'invalid diff',
			};

			// Make git apply fail
			mockSpawnSync.mockImplementation(
				(command: string, args: string[], _options?: unknown) => {
					if (
						command === 'git' &&
						args[0] === 'apply' &&
						!args.includes('-R')
					) {
						return {
							status: 128,
							stdout: '',
							stderr: Buffer.from("fatal: couldn't patch file"),
						};
					}
					return {
						status: 0,
						stdout: Buffer.from(''),
						stderr: Buffer.from(''),
					};
				},
			);

			const result = await executeMutation(patch, testCommand, [], workingDir);

			expect(result.outcome).toBe('error');
			expect(result.error).toContain('Git apply failed');
		});
	});

	describe('error handling for git apply -R failures', () => {
		test('non-zero spawnSync status for git apply -R captures revertError in result without throwing', async () => {
			const patch: MutationPatch = {
				id: 'revert_failing_patch',
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'diff content',
			};

			// Make git apply succeed but revert fail
			mockSpawnSync.mockImplementation(
				(command: string, args: string[], _options?: unknown) => {
					if (
						command === 'git' &&
						args[0] === 'apply' &&
						!args.includes('-R')
					) {
						return { status: 0, stdout: '', stderr: Buffer.from('') };
					}
					if (command === 'git' && args.includes('-R')) {
						return {
							status: 1,
							stdout: '',
							stderr: Buffer.from('patch does not apply'),
						};
					}
					return {
						status: 0,
						stdout: Buffer.from('Tests passed'),
						stderr: Buffer.from(''),
					};
				},
			);

			// The function should NOT throw - revertError is captured in result
			const result = await executeMutation(patch, testCommand, [], workingDir);

			expect(result.outcome).toBe('error');
			expect(result.error).toContain('Failed to revert mutation');
			expect(result.error).toContain('git apply -R failed with status 1');
		});

		test('revertError includes patch.id in error field', async () => {
			const patch: MutationPatch = {
				id: 'my_special_patch_id',
				filePath: '/fake/file.ts',
				functionName: 'testFn',
				mutationType: 'binary',
				patch: 'diff content',
			};

			mockSpawnSync.mockImplementation(
				(command: string, args: string[], _options?: unknown) => {
					if (
						command === 'git' &&
						args[0] === 'apply' &&
						!args.includes('-R')
					) {
						return { status: 0, stdout: '', stderr: Buffer.from('') };
					}
					if (command === 'git' && args.includes('-R')) {
						return {
							status: 1,
							stdout: '',
							stderr: Buffer.from('patch does not apply'),
						};
					}
					return {
						status: 0,
						stdout: Buffer.from('Tests passed'),
						stderr: Buffer.from(''),
					};
				},
			);

			const result = await executeMutation(patch, testCommand, [], workingDir);

			expect(result.outcome).toBe('error');
			expect(result.error).toContain('my_special_patch_id');
		});
	});

	describe('suite-level revert error handling', () => {
		test('executeMutationSuite returns all results without throwing when some patches have revert failures', async () => {
			const { executeMutationSuite } = await import(
				'../../../src/mutation/engine'
			);

			const patches: MutationPatch[] = [
				{
					id: 'successful_patch',
					filePath: '/fake/file.ts',
					functionName: 'testFn',
					mutationType: 'binary',
					patch: 'diff content 1',
				},
				{
					id: 'revert_failing_patch',
					filePath: '/fake/file.ts',
					functionName: 'testFn',
					mutationType: 'binary',
					patch: 'diff content 2',
				},
				{
					id: 'another_successful_patch',
					filePath: '/fake/file.ts',
					functionName: 'testFn',
					mutationType: 'binary',
					patch: 'diff content 3',
				},
			];

			// Track which patches had their revert called
			const revertFailures = new Set(['revert_failing_patch']);

			mockSpawnSync.mockImplementation(
				(command: string, args: string[], _options?: unknown) => {
					if (
						command === 'git' &&
						args[0] === 'apply' &&
						!args.includes('-R')
					) {
						return { status: 0, stdout: '', stderr: Buffer.from('') };
					}
					if (command === 'git' && args.includes('-R')) {
						// Extract patch id from the file path to determine if this revert should fail
						// Handle both old format ['apply', '-R', patchFile] and new format ['apply', '-R', '--', patchFile]
						const rIndex = args.indexOf('-R');
						const patchFile =
							args[rIndex + 1] === '--' ? args[rIndex + 2] : args[rIndex + 1];
						const shouldFail = [...revertFailures].some((id) =>
							patchFile.includes(id.replace(/[^a-zA-Z0-9_-]/g, '_')),
						);
						return {
							status: shouldFail ? 1 : 0,
							stdout: '',
							stderr: Buffer.from(shouldFail ? 'patch does not apply' : ''),
						};
					}
					return {
						status: 0,
						stdout: Buffer.from('Tests passed'),
						stderr: Buffer.from(''),
					};
				},
			);

			// executeMutationSuite should NOT throw - it should return all results
			const report = await executeMutationSuite(
				patches,
				testCommand,
				[],
				workingDir,
			);

			// Verify all patches were processed
			expect(report.results).toHaveLength(3);

			// Verify the successful patches have expected outcomes
			const successfulResults = report.results.filter(
				(r) => r.patchId !== 'revert_failing_patch',
			);
			for (const result of successfulResults) {
				expect(result.outcome).toBe('survived');
				expect(result.error).toBeUndefined();
			}

			// Verify the revert-failing patch has error captured in result
			const failedResult = report.results.find(
				(r) => r.patchId === 'revert_failing_patch',
			);
			expect(failedResult).toBeDefined();
			expect(failedResult!.outcome).toBe('error');
			expect(failedResult!.error).toContain('Failed to revert mutation');
			expect(failedResult!.error).toContain('revert_failing_patch');
		});
	});
});
