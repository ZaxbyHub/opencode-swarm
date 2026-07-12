import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// Spread the real engine exports so named imports the tool relies on
// (validateTestCommand, etc.) survive the mock — only executeMutationSuite
// is overridden. See AGENTS.md invariant 7 (spread-real-exports).
import * as realEngine from '../../mutation/engine.js';

// Mock functions defined at module level - will be used in mock.module calls
const mockExecuteMutationSuiteFn = mock(async () => ({
	totalMutants: 10,
	killed: 8,
	survived: 2,
	timeout: 0,
	equivalent: 0,
	skipped: 0,
	errors: 0,
	killRate: 0.8,
	adjustedKillRate: 0.8,
	perFunction: new Map(),
	results: [],
	durationMs: 100,
	budgetMs: 300000,
	budgetExceeded: false,
	timestamp: '2024-01-01T00:00:00.000Z',
}));

const mockEvaluateMutationGateFn = mock(() => ({
	verdict: 'pass' as const,
	killRate: 0.8,
	adjustedKillRate: 0.8,
	totalMutants: 10,
	killed: 8,
	survived: 2,
	threshold: 0.8,
	warnThreshold: 0.6,
	message: 'Mutation gate PASSED: 80% kill rate (8/10 mutants killed)',
	survivedMutants: [],
	testImprovementPrompt: '',
}));

describe('mutation_test tool', () => {
	beforeEach(() => {
		// Mock engine and gate modules - these are the actual dependencies we need to control
		mock.module('../../mutation/engine.js', () => ({
			...realEngine,
			executeMutationSuite: mockExecuteMutationSuiteFn,
		}));

		mock.module('../../mutation/gate.js', () => ({
			evaluateMutationGate: mockEvaluateMutationGateFn,
			MutationGateResult: {},
		}));
	});

	afterEach(() => {
		mock.restore();
	});

	describe('tool export and structure', () => {
		test('1. Tool is exported correctly with createSwarmTool return type', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			expect(mutation_test).toBeDefined();
			expect(typeof mutation_test).toBe('object');
			expect(mutation_test).toHaveProperty('description');
			expect(mutation_test).toHaveProperty('args');
			expect(mutation_test).toHaveProperty('execute');
		});

		test('2. Tool has correct description mentioning "pre-generated patches"', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			expect(mutation_test.description).toContain('pre-generated patches');
			expect(mutation_test.description).toContain('mutation testing');
		});

		test('3. Tool schema includes patches, files, test_command, pass_threshold, warn_threshold, working_directory args', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const args = mutation_test.args as Record<string, unknown>;
			expect(args).toHaveProperty('patches');
			expect(args).toHaveProperty('files');
			expect(args).toHaveProperty('test_command');
			expect(args).toHaveProperty('pass_threshold');
			expect(args).toHaveProperty('warn_threshold');
			expect(args).toHaveProperty('working_directory');
		});
	});

	describe('validation errors', () => {
		const defaultArgs = {
			patches: [
				{
					id: '1',
					filePath: 'test.ts',
					functionName: 'fn',
					mutationType: 'type',
					patch: 'diff',
				},
			],
			files: ['test.test.ts'],
			test_command: ['npx', 'vitest'],
		};

		test('4. empty patches array returns error', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
			const result = await execute({ ...defaultArgs, patches: [] }, '/test');
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('patches must be a non-empty array');
		});

		test('5. empty files array returns error', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
			const result = await execute({ ...defaultArgs, files: [] }, '/test');
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('files must be a non-empty array');
		});

		test('6. empty test_command array returns error', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
			const result = await execute(
				{ ...defaultArgs, test_command: [] },
				'/test',
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('test_command must be a non-empty array');
		});

		test('7. missing patches returns error', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
			const result = await execute(
				{ files: ['test.test.ts'], test_command: ['npx', 'vitest'] } as unknown,
				'/test',
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('patches must be a non-empty array');
		});

		test('8. missing files returns error', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
			const result = await execute(
				{
					patches: defaultArgs.patches,
					test_command: ['npx', 'vitest'],
				} as unknown,
				'/test',
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('files must be a non-empty array');
		});

		test('9. missing test_command returns error', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
			const result = await execute(
				{ patches: defaultArgs.patches, files: ['test.test.ts'] } as unknown,
				'/test',
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('test_command must be a non-empty array');
		});
	});

	describe('successful execution', () => {
		const validArgs = {
			patches: [
				{
					id: '1',
					filePath: 'test.ts',
					functionName: 'fn',
					mutationType: 'type',
					patch: 'diff',
				},
			],
			files: ['test.test.ts'],
			test_command: ['npx', 'vitest'],
		};

		test('10. Successful execution returns JSON with verdict/killRate/adjustedKillRate', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
			const result = await execute(validArgs, '/test');
			const parsed = JSON.parse(result);
			expect(parsed).toHaveProperty('verdict');
			expect(parsed).toHaveProperty('killRate');
			expect(parsed).toHaveProperty('adjustedKillRate');
			expect(parsed.verdict).toBe('pass');
			expect(parsed.killRate).toBe(0.8);
			expect(parsed.adjustedKillRate).toBe(0.8);
		});

		test('11. Default thresholds are 0.8 (pass) and 0.6 (warn)', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
			await execute(validArgs, '/test');

			expect(mockEvaluateMutationGateFn).toHaveBeenCalledWith(
				expect.any(Object),
				0.8,
				0.6,
			);
		});

		test('12. Custom thresholds are passed through correctly', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
			await execute(
				{ ...validArgs, pass_threshold: 0.7, warn_threshold: 0.5 },
				'/test',
			);

			expect(mockEvaluateMutationGateFn).toHaveBeenCalledWith(
				expect.any(Object),
				0.7,
				0.5,
			);
		});

		test('13. working_directory overrides directory', async () => {
			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;

			// working_directory is existence-validated by resolveWorkingDirectory
			// (invariant 4). Use a real directory so the override is exercised;
			// the tool resolves it via path.resolve(path.normalize(...)).
			const overrideDir = fs.mkdtempSync(
				path.join(os.tmpdir(), 'mutation-wd-'),
			);
			try {
				await execute(
					{ ...validArgs, working_directory: overrideDir },
					'/test',
				);

				// Resolved override dir is passed as the 4th arg (cwd), taking
				// precedence over the injected directory '/test'. No source files
				// exist under it, so sourceFiles is undefined (7th arg).
				expect(mockExecuteMutationSuiteFn).toHaveBeenCalledWith(
					validArgs.patches,
					validArgs.test_command,
					validArgs.files,
					path.resolve(overrideDir),
					undefined,
					undefined,
					undefined,
				);
			} finally {
				fs.rmSync(overrideDir, { recursive: true, force: true });
			}
		});
	});

	describe('error handling', () => {
		const validArgs = {
			patches: [
				{
					id: '1',
					filePath: 'test.ts',
					functionName: 'fn',
					mutationType: 'type',
					patch: 'diff',
				},
			],
			files: ['test.test.ts'],
			test_command: ['npx', 'vitest'],
		};

		test('14. Error handling: executeMutationSuite throws → returns error JSON', async () => {
			// Override the mock implementation for this test
			mockExecuteMutationSuiteFn.mockImplementation(() => {
				throw new Error('git apply failed');
			});

			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
			const result = await execute(validArgs, '/test');
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('mutation_test failed');
			expect(parsed.error).toContain('git apply failed');

			// Restore original implementation
			mockExecuteMutationSuiteFn.mockImplementation(async () => ({
				totalMutants: 10,
				killed: 8,
				survived: 2,
				timeout: 0,
				equivalent: 0,
				skipped: 0,
				errors: 0,
				killRate: 0.8,
				adjustedKillRate: 0.8,
				perFunction: new Map(),
				results: [],
				durationMs: 100,
				budgetMs: 300000,
				budgetExceeded: false,
				timestamp: '2024-01-01T00:00:00.000Z',
			}));
		});

		test('15. Error handling: evaluateMutationGate throws → returns error JSON', async () => {
			// Override the mock implementation for this test
			mockEvaluateMutationGateFn.mockImplementation(() => {
				throw new Error('invalid threshold');
			});

			const { mutation_test } = await import('../mutation-test.js');
			const execute = mutation_test.execute as unknown as (
				args: unknown,
				directory: string,
			) => Promise<string>;
			const result = await execute(validArgs, '/test');
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('mutation_test failed');
			expect(parsed.error).toContain('invalid threshold');

			// Restore original implementation
			mockEvaluateMutationGateFn.mockImplementation(() => ({
				verdict: 'pass' as const,
				killRate: 0.8,
				adjustedKillRate: 0.8,
				totalMutants: 10,
				killed: 8,
				survived: 2,
				threshold: 0.8,
				warnThreshold: 0.6,
				message: 'Mutation gate PASSED: 80% kill rate (8/10 mutants killed)',
				survivedMutants: [],
				testImprovementPrompt: '',
			}));
		});
	});
});
