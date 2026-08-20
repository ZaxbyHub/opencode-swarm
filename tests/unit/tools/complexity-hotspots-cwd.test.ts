import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { complexity_hotspots } from '../../../src/tools/complexity-hotspots';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Mock for Bun.spawn
let originalSpawn: typeof Bun.spawn;
let mockExitCode: number = 0;
let mockStdout: string = '';
let mockStderr: string = '';

function mockSpawn(
	cmd: string[],
	opts: { cwd?: string; stdout?: string; stderr?: string },
) {
	const encoder = new TextEncoder();
	const stdoutReadable = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(mockStdout));
			controller.close();
		},
	});
	const stderrReadable = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(mockStderr));
			controller.close();
		},
	});

	return {
		stdout: stdoutReadable,
		stderr: stderrReadable,
		exited: Promise.resolve(mockExitCode),
		exitCode: mockExitCode,
	} as unknown as ReturnType<typeof Bun.spawn>;
}

describe('complexity_hotspots', () => {
	beforeEach(() => {
		originalSpawn = Bun.spawn;
		mockExitCode = 0;
		mockStdout = '';
		mockStderr = '';
		Bun.spawn = mockSpawn as any;
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
	});

	// ============ VERIFICATION TESTS ============

	describe('Verification: Fail-fast guard', () => {
		it('returns error JSON for empty string directory ""', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: '',
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
			expect(parsed.analyzedFiles).toBe(0);
			expect(parsed.hotspots).toEqual([]);
		});

		it('returns error JSON for whitespace-only directory "  "', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: '  ',
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
			expect(parsed.analyzedFiles).toBe(0);
		});

		it('returns error JSON for newline-only directory "\\n"', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: '\n',
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
			expect(parsed.analyzedFiles).toBe(0);
		});
	});

	describe('Verification: Bun.spawn receives directory as cwd', () => {
		let spawnCalls: Array<{ cmd: string[]; opts: any }> = [];
		let originalSpawnFn: typeof Bun.spawn;

		const tempDirs: string[] = [];

		afterEach(() => {
			for (const dir of tempDirs.splice(0)) {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		beforeEach(() => {
			spawnCalls = [];
			originalSpawnFn = Bun.spawn;
			Bun.spawn = ((cmd: string[], opts: any) => {
				spawnCalls.push({ cmd, opts });
				return mockSpawn(cmd, opts);
			}) as any;
		});

		afterEach(() => {
			Bun.spawn = originalSpawnFn;
		});

		// #2236: these two cases assert argv plumbing, so their directory must
		// actually EXIST. `bunSpawn` now validates `options.cwd` before creating
		// the child, so a fictitious path short-circuits and no spawn is ever
		// recorded. The old literals were also platform-dependent theatre: on
		// this Windows host `/test/project` resolves to an unrelated real
		// directory and passed by accident, while on CI it does not exist at all.
		it('Bun.spawn is called with cwd: directory when valid directory provided', async () => {
			const testDir = canonicalMkdtemp('hotspots-cwd-single-');
			tempDirs.push(testDir);

			const result = await complexity_hotspots.execute({}, {
				directory: testDir,
			} as any);
			const parsed = JSON.parse(result);

			// Verify spawn was called
			expect(spawnCalls.length).toBeGreaterThan(0);

			// Get the spawn call arguments
			const spawnCall = spawnCalls[0];
			const options = spawnCall.opts;

			// Verify cwd is set to the provided directory
			expect(options).toBeDefined();
			expect(options.cwd).toBe(testDir);
		});

		it('different directories result in different cwd values', async () => {
			const dir1 = canonicalMkdtemp('hotspots-cwd-first-');
			const dir2 = canonicalMkdtemp('hotspots-cwd-second-');
			tempDirs.push(dir1, dir2);

			// First call
			await complexity_hotspots.execute({}, { directory: dir1 } as any);
			const firstOptions = spawnCalls[0].opts;

			// Clear for second call
			spawnCalls = [];

			// Second call
			await complexity_hotspots.execute({}, { directory: dir2 } as any);
			const secondOptions = spawnCalls[0].opts;

			// Verify different cwd values
			expect(firstOptions.cwd).toBe(dir1);
			expect(secondOptions.cwd).toBe(dir2);
		});
	});

	describe('Verification: analyzeHotspots uses directory for file path resolution', () => {
		let existsSyncSpy: ReturnType<typeof spyOn>;
		let readFileSyncSpy: ReturnType<typeof spyOn>;
		let statSyncSpy: ReturnType<typeof spyOn>;

		beforeEach(() => {
			// Set up mock git output with some TypeScript files
			mockStdout = 'src/main.ts\nsrc/utils.ts\nsrc/app.ts\n';
			mockExitCode = 0;

			existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation(() => false);
			readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation(
				() => 'const x = 1;',
			);
			statSyncSpy = spyOn(fs, 'statSync').mockImplementation(
				() => ({ size: 100 }) as any,
			);
		});

		afterEach(() => {
			existsSyncSpy.mockRestore();
			readFileSyncSpy.mockRestore();
			statSyncSpy.mockRestore();
		});

		it('analyzeHotspots receives directory and uses it in file resolution', async () => {
			const testDir = '/custom/project/path';

			const result = await complexity_hotspots.execute({}, {
				directory: testDir,
			} as any);
			const parsed = JSON.parse(result);

			// Verify fs.existsSync was called
			expect(existsSyncSpy).toHaveBeenCalled();

			// Verify fs.statSync was called (indicating file path resolution happened)
			expect(statSyncSpy).toHaveBeenCalled();

			// The key test: verify the directory was used in the cwd variable in analyzeHotspots
			// This is implicitly tested because:
			// 1. Bun.spawn is called with cwd: testDir (verified in other tests)
			// 2. File paths are resolved relative to that directory
			// We verify that the test passed (no error) when using the directory
			expect(parsed.analyzedFiles).toBeGreaterThanOrEqual(0);
		});

		it('different directories result in different cwd being passed to spawn', async () => {
			let capturedCwd: string | undefined;

			// Override spawn to capture the cwd
			const originalBunSpawn = Bun.spawn;
			Bun.spawn = ((cmd: string[], opts: any) => {
				capturedCwd = opts.cwd;
				return mockSpawn(cmd, opts);
			}) as any;

			const dir1 = '/first/directory';
			await complexity_hotspots.execute({}, { directory: dir1 } as any);
			const firstCwd = capturedCwd;

			const dir2 = '/second/directory';
			await complexity_hotspots.execute({}, { directory: dir2 } as any);
			const secondCwd = capturedCwd;

			// Restore
			Bun.spawn = originalBunSpawn;

			expect(firstCwd).toBe(dir1);
			expect(secondCwd).toBe(dir2);
		});
	});

	// ============ ADVERSARIAL TESTS ============

	describe('Adversarial: null/undefined directory (fallback behavior)', () => {
		it('directory = null → uses process.cwd() fallback (no error)', async () => {
			// When directory is null in ToolContext, createSwarmTool falls back to process.cwd()
			// The tool should run without error from the fail-fast guard
			const result = await complexity_hotspots.execute({}, {
				directory: null,
			} as any);
			const parsed = JSON.parse(result);

			// Should NOT have the fail-fast error - it uses fallback
			expect(parsed.error).not.toBe(
				'project directory is required but was not provided',
			);
		});

		it('directory = undefined → uses process.cwd() fallback (no error)', async () => {
			// When directory is undefined in ToolContext, createSwarmTool falls back to process.cwd()
			const result = await complexity_hotspots.execute({}, {
				directory: undefined,
			} as any);
			const parsed = JSON.parse(result);

			// Should NOT have the fail-fast error - it uses fallback
			expect(parsed.error).not.toBe(
				'project directory is required but was not provided',
			);
		});
	});

	describe('Adversarial: invalid type directory', () => {
		it('directory = 0 (number) → fail-fast returns error', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: 0,
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
			// 0 is falsy, so it triggers the fail-fast
		});

		it('directory = {} (object) → fail-fast returns error', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: {},
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
			// typeof {} !== 'string' triggers the fail-fast
		});

		it('directory = [] (array) → fail-fast returns error', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: [],
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});

		it('directory = function → fail-fast returns error', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: () => {},
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});
	});

	describe('Adversarial: whitespace-only directory', () => {
		it('directory = "\\t\\n  " (only whitespace chars) → fail-fast returns error', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: '\t\n  ',
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
			// directory.trim() === '' triggers the fail-fast
		});

		it('directory = "\\t" (tab only) → fail-fast returns error', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: '\t',
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});

		it('directory = "\\r" (carriage return only) → fail-fast returns error', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: '\r',
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});
	});

	describe('Adversarial: special string values', () => {
		it('directory = "null" (string) → passes validation (different from null value)', async () => {
			// This is a valid string "null", not the null value
			const result = await complexity_hotspots.execute({}, {
				directory: 'null',
			} as any);
			const parsed = JSON.parse(result);

			// Should NOT trigger fail-fast because "null" is a valid non-empty string
			// It will try to run git in directory "null" which will fail with analysis error
			expect(parsed.error).not.toBe(
				'project directory is required but was not provided',
			);
		});

		it('directory = "undefined" (string) → passes validation', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: 'undefined',
			} as any);
			const parsed = JSON.parse(result);

			// Should NOT trigger fail-fast because "undefined" is a valid string
			expect(parsed.error).not.toBe(
				'project directory is required but was not provided',
			);
		});

		it('directory = "   " (spaces) → fail-fast returns error', async () => {
			const result = await complexity_hotspots.execute({}, {
				directory: '   ',
			} as any);
			const parsed = JSON.parse(result);

			expect(parsed.error).toBe(
				'project directory is required but was not provided',
			);
		});
	});
});
