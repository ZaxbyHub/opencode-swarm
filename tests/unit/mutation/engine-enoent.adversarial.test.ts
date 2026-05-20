import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the entire child_process module to track spawnSync calls
const mockSpawnSync = mock(() => ({
	status: 0,
	stderr: Buffer.from(''),
	stdout: Buffer.from(''),
}));
const realChildProcess = await import('node:child_process');
const realSpawnSync = realChildProcess.spawnSync;

mock.module('node:child_process', () => ({
	...realChildProcess,
	spawnSync: mockSpawnSync,
}));

// Import after mocking
const { executeMutation, MutationPatch } = await import(
	'../../../src/mutation/engine.ts'
);

const mockPatch: MutationPatch = {
	id: 'test-patch-001',
	filePath: '/fake/test.ts',
	functionName: 'testFn',
	mutationType: 'logical',
	patch:
		'--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-exports.foo = bar;\n+exports.foo = baz;\n',
	lineNumber: 1,
};

describe('executeMutation — ENOENT adversarial tests', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-enoent-'));
		mockSpawnSync.mockImplementation(
			(cmd: string, args: string[], opts: Record<string, unknown>) => {
				if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
					return {
						status: 0,
						error: undefined,
						stderr: Buffer.from(''),
						stdout: Buffer.from(''),
					};
				}
				if (cmd === 'git' && args[0] === 'apply' && args.includes('-R')) {
					return {
						status: 0,
						error: undefined,
						stderr: Buffer.from(''),
						stdout: Buffer.from(''),
					};
				}
				return {
					status: 0,
					error: undefined,
					stderr: Buffer.from(''),
					stdout: Buffer.from('all tests passed'),
				};
			},
		);
	});

	afterEach(() => {
		mock.restore();
		mockSpawnSync.mockClear();
		try {
			const entries = fs.readdirSync(tempDir);
			for (const entry of entries) {
				fs.unlinkSync(path.join(tempDir, entry));
			}
			fs.rmdirSync(tempDir);
		} catch {
			// best effort
		}
	});

	// -------------------------------------------------------------------------
	// Attack Vector 1: spawnSync returns BOTH .error AND non-zero .status
	// -------------------------------------------------------------------------
	describe('both error AND non-zero status simultaneously', () => {
		test('apply path — error with non-zero status: only error path taken (not status)', async () => {
			mockSpawnSync.mockImplementationOnce((cmd: string, args: string[]) => {
				if (cmd === 'git' && args[0] === 'apply') {
					const err = new Error('git not found') as NodeJS.ErrnoException;
					err.code = 'ENOENT';
					return {
						status: 127,
						error: err,
						stdout: Buffer.from(''),
						stderr: Buffer.from(''),
					} as ReturnType<typeof realSpawnSync>;
				}
				return {
					status: 0,
					error: undefined,
					stdout: Buffer.from('all tests passed'),
					stderr: Buffer.from(''),
				};
			});

			const result = await executeMutation(
				mockPatch,
				['echo', 'test'],
				[],
				tempDir,
			);

			// Error path is checked first — ENOENT is detected, status is never examined
			expect(result.outcome).toBe('error');
			expect(result.error).toMatch(/git is not installed or not found in PATH/);
		});

		test('revert path — error with non-zero status: only error path taken', async () => {
			mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
				if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
					return {
						status: 0,
						error: undefined,
						stdout: Buffer.from(''),
						stderr: Buffer.from(''),
					};
				}
				if (cmd === 'git' && args[0] === 'apply' && args.includes('-R')) {
					const err = new Error('Permission denied') as NodeJS.ErrnoException;
					err.code = 'EACCES';
					return {
						status: 128,
						error: err,
						stdout: Buffer.from(''),
						stderr: Buffer.from(''),
					} as ReturnType<typeof realSpawnSync>;
				}
				return {
					status: 1,
					error: undefined,
					stdout: Buffer.from('Assertion failed'),
					stderr: Buffer.from(''),
				};
			});

			const result = await executeMutation(
				mockPatch,
				['echo', 'test'],
				[],
				tempDir,
			);

			expect(result.outcome).toBe('error');
			expect(result.error).toMatch(/git command failed/);
		});
	});

	// -------------------------------------------------------------------------
	// Attack Vector 2: revert ENOENT + killed test outcome
	// -------------------------------------------------------------------------
	test('revert ENOENT combined with killed outcome — error message preserves both', async () => {
		mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
				return {
					status: 0,
					error: undefined,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				};
			}
			if (cmd === 'git' && args[0] === 'apply' && args.includes('-R')) {
				const err = new Error(
					'git is not installed or not found in PATH',
				) as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			return {
				status: 1,
				error: undefined,
				stdout: Buffer.from('FAIL'),
				stderr: Buffer.from(''),
			};
		});

		const result = await executeMutation(
			mockPatch,
			['echo', 'test'],
			[],
			tempDir,
		);

		// outcome becomes 'error' because revertError exists and outcome was 'killed'
		expect(result.outcome).toBe('error');
		expect(result.error).toMatch(/FAIL|git is not installed/);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 3: revert ENOENT + apply error — which takes precedence
	//
	// BUG FOUND: When apply fails (lines 97-103), it throws. The catch at 109
	// returns early at line 111 with `error = "Git apply failed: ${applyErr}"`.
	// The finally block (155-189) RUNS and sets revertError, but the return
	// value was already committed before finally executed.
	// Lines 199-203 (which combine error + revertError) are on the NORMAL path
	// (line 192 return) and NEVER execute when apply fails.
	// RESULT: revertError is silently discarded when apply fails.
	// -------------------------------------------------------------------------
	test('apply error + revert ENOENT: revertError DISCARED due to early return', async () => {
		let revertCalled = false;
		mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
				const err = new Error('apply failed') as NodeJS.ErrnoException;
				err.code = 'EBADF';
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			if (cmd === 'git' && args[0] === 'apply' && args.includes('-R')) {
				revertCalled = true;
				const err = new Error(
					'git is not installed or not found in PATH',
				) as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			return {
				status: 0,
				error: undefined,
				stdout: Buffer.from('all tests passed'),
				stderr: Buffer.from(''),
			};
		});

		const result = await executeMutation(
			mockPatch,
			['echo', 'test'],
			[],
			tempDir,
		);

		expect(result.outcome).toBe('error');
		expect(revertCalled).toBe(true); // finally DID run
		// Bug: revertError is NOT included because line 111 returned before finally completed
		expect(result.error).toMatch(/Git apply failed/);
		expect(result.error).not.toMatch(/git is not installed/);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 4: other spawnSync error codes (EACCES, EMFILE, etc.)
	// -------------------------------------------------------------------------
	test.each([
		['EACCES'],
		['EMFILE'],
		['ENOTDIR'],
		['EBADF'],
	])('apply path — spawnSync error code %s is handled', async (code: string) => {
		mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
				const err = new Error('simulated failure') as NodeJS.ErrnoException;
				err.code = code;
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			return {
				status: 0,
				error: undefined,
				stdout: Buffer.from('all tests passed'),
				stderr: Buffer.from(''),
			};
		});

		const result = await executeMutation(
			mockPatch,
			['echo', 'test'],
			[],
			tempDir,
		);

		expect(result.outcome).toBe('error');
		expect(result.error).toMatch(/git command failed/);
	});

	test.each([
		['EACCES'],
		['EMFILE'],
		['ENOTDIR'],
	])('revert path — spawnSync error code %s is handled', async (code: string) => {
		mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
				return {
					status: 0,
					error: undefined,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				};
			}
			if (cmd === 'git' && args[0] === 'apply' && args.includes('-R')) {
				const err = new Error('simulated failure') as NodeJS.ErrnoException;
				err.code = code;
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			return {
				status: 1,
				error: undefined,
				stdout: Buffer.from('killed'),
				stderr: Buffer.from(''),
			};
		});

		const result = await executeMutation(
			mockPatch,
			['echo', 'test'],
			[],
			tempDir,
		);

		expect(result.outcome).toBe('error');
		expect(result.error).toMatch(/git command failed/);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 5: undefined error.code (not ENOENT)
	// -------------------------------------------------------------------------
	test('apply path — undefined error.code falls through to generic error message', async () => {
		mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
				const err = new Error(
					'custom error without code',
				) as NodeJS.ErrnoException;
				err.code = undefined;
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			return {
				status: 0,
				error: undefined,
				stdout: Buffer.from('all tests passed'),
				stderr: Buffer.from(''),
			};
		});

		const result = await executeMutation(
			mockPatch,
			['echo', 'test'],
			[],
			tempDir,
		);

		expect(result.outcome).toBe('error');
		expect(result.error).toMatch(/Git apply failed/);
		expect(result.error).toMatch(/custom error without code/);
	});

	test('revert path — undefined error.code falls through to generic error message', async () => {
		mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
				return {
					status: 0,
					error: undefined,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				};
			}
			if (cmd === 'git' && args[0] === 'apply' && args.includes('-R')) {
				const err = new Error(
					'custom revert error without code',
				) as NodeJS.ErrnoException;
				err.code = undefined;
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			return {
				status: 1,
				error: undefined,
				stdout: Buffer.from('killed'),
				stderr: Buffer.from(''),
			};
		});

		const result = await executeMutation(
			mockPatch,
			['echo', 'test'],
			[],
			tempDir,
		);

		expect(result.outcome).toBe('error');
		expect(result.error).toMatch(/git command failed/);
		expect(result.error).toMatch(/custom revert error without code/);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 6: concurrent ENOENT in both apply AND revert
	// -------------------------------------------------------------------------
	test('apply ENOENT causes early return — revert still called in finally block', async () => {
		let applyCalled = false;
		let revertCalled = false;

		mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
				applyCalled = true;
				const err = new Error(
					'git is not installed or not found in PATH',
				) as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			if (cmd === 'git' && args[0] === 'apply' && args.includes('-R')) {
				revertCalled = true;
				const err = new Error(
					'git is not installed or not found in PATH',
				) as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			return {
				status: 0,
				error: undefined,
				stdout: Buffer.from('all tests passed'),
				stderr: Buffer.from(''),
			};
		});

		const result = await executeMutation(
			mockPatch,
			['echo', 'test'],
			[],
			tempDir,
		);

		expect(result.outcome).toBe('error');
		expect(result.error).toMatch(/git is not installed/);
		expect(applyCalled).toBe(true);
		// revert IS called because patchFile is set BEFORE apply is attempted
		expect(revertCalled).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Edge case: error.code is null (not undefined, not a string)
	// -------------------------------------------------------------------------
	test('error.code is null (not undefined) — treated as non-ENOENT', async () => {
		mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
				const err = new Error('null code error') as NodeJS.ErrnoException;
				(err as unknown as { code: null }).code = null;
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			return {
				status: 0,
				error: undefined,
				stdout: Buffer.from('all tests passed'),
				stderr: Buffer.from(''),
			};
		});

		const result = await executeMutation(
			mockPatch,
			['echo', 'test'],
			[],
			tempDir,
		);

		expect(result.outcome).toBe('error');
		// null !== 'ENOENT', so falls to else branch
		expect(result.error).toMatch(/git command failed/);
	});

	// -------------------------------------------------------------------------
	// Edge case: revert ENOENT + outcome already 'error' from apply
	//
	// BUG: Same issue as Attack Vector 3. When apply fails, catch returns early
	// at line 111. finally runs and sets revertError, but return was committed.
	// -------------------------------------------------------------------------
	test('revert ENOENT when outcome already error — revertError DISCARED', async () => {
		let revertCalled = false;
		mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
				const err = new Error('apply failed') as NodeJS.ErrnoException;
				err.code = 'EBADF';
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			if (cmd === 'git' && args[0] === 'apply' && args.includes('-R')) {
				revertCalled = true;
				const err = new Error(
					'git is not installed or not found in PATH',
				) as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				return {
					status: null,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			return {
				status: 0,
				error: undefined,
				stdout: Buffer.from('all tests passed'),
				stderr: Buffer.from(''),
			};
		});

		const result = await executeMutation(
			mockPatch,
			['echo', 'test'],
			[],
			tempDir,
		);

		expect(result.outcome).toBe('error');
		expect(revertCalled).toBe(true); // finally DID run
		expect(result.error).toMatch(/Git apply failed/);
		expect(result.error).not.toMatch(/git is not installed/); // BUG: silently discarded
	});

	// -------------------------------------------------------------------------
	// Edge case: spawnSync returns status=0 but with an error object
	// -------------------------------------------------------------------------
	test('status=0 but error object present — error takes precedence over status', async () => {
		mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
			if (cmd === 'git' && args[0] === 'apply' && !args.includes('-R')) {
				const err = new Error('phantom error') as NodeJS.ErrnoException;
				err.code = 'ENOENT';
				return {
					status: 0,
					error: err,
					stdout: Buffer.from(''),
					stderr: Buffer.from(''),
				} as ReturnType<typeof realSpawnSync>;
			}
			return {
				status: 0,
				error: undefined,
				stdout: Buffer.from('all tests passed'),
				stderr: Buffer.from(''),
			};
		});

		const result = await executeMutation(
			mockPatch,
			['echo', 'test'],
			[],
			tempDir,
		);

		// Error path is checked FIRST (line 97), so ENOENT is thrown even though status=0
		expect(result.outcome).toBe('error');
		expect(result.error).toMatch(/git is not installed or not found in PATH/);
	});
});
