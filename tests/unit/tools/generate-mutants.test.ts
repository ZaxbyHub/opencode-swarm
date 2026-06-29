import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MutationPatch } from '../../../src/mutation/engine';

// ---------------------------------------------------------------------------
// Helper: build a minimal MutationPatch for the given mutationType
// ---------------------------------------------------------------------------
function makePatch(
	mutationType: string,
	overrides?: Partial<MutationPatch>,
): MutationPatch {
	return {
		id: 'mut-001',
		filePath: 'src/foo.ts',
		functionName: 'bar',
		mutationType,
		patch: `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n-old\n+new`,
		lineNumber: 1,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Off-by-one mutation patches (arithmetic operator mutations)
// ---------------------------------------------------------------------------
const OFF_BY_ONE_PATCHES: MutationPatch[] = [
	makePatch('off-by-one', {
		id: 'mut-001',
		functionName: 'add',
		patch:
			'--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n a + b\n a - b',
	}),
	makePatch('off-by-one', {
		id: 'mut-002',
		functionName: 'add',
		patch: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n i++\n i--',
	}),
];

// ---------------------------------------------------------------------------
// Null substitution mutation patches
// ---------------------------------------------------------------------------
const NULL_SUBSTITUTION_PATCHES: MutationPatch[] = [
	makePatch('null-substitution', {
		id: 'mut-003',
		functionName: 'getConfig',
		patch:
			'--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n config.value\n null',
	}),
	makePatch('null-substitution', {
		id: 'mut-004',
		functionName: 'findUser',
		patch:
			'--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n user.id\n null',
	}),
];

// ---------------------------------------------------------------------------
// Return-value-flip mutation patches
// ---------------------------------------------------------------------------
const RETURN_VALUE_FLIP_PATCHES: MutationPatch[] = [
	makePatch('return-value-flip', {
		id: 'mut-005',
		functionName: 'isEmpty',
		patch:
			'--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n return true\n return false',
	}),
	makePatch('return-value-flip', {
		id: 'mut-006',
		functionName: 'hasPermission',
		patch:
			'--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,3 +1,3 @@\n return false\n return true',
	}),
];

// ---------------------------------------------------------------------------
// Module-level mock references — reset in beforeEach
// ---------------------------------------------------------------------------
const mockGenerateMutants = mock(async (): Promise<MutationPatch[]> => []);

describe('generate_mutants tool — behavioral tests', () => {
	beforeEach(() => {
		mockGenerateMutants.mockReset();
		mockGenerateMutants.mockImplementation(async () => []);
		mock.module('../../../src/mutation/generator.js', () => ({
			generateMutants: mockGenerateMutants,
		}));
	});

	afterEach(() => {
		mock.restore();
	});

	// -------------------------------------------------------------------------
	// Outcome 1: off-by-one mutation generation
	// -------------------------------------------------------------------------
	describe('1. Off-by-one mutation patches (arithmetic operators)', () => {
		test('returns verdict=ready with off-by-one patches when LLM provides them', async () => {
			const { generate_mutants } = await import(
				'../../../src/tools/generate-mutants.js'
			);

			mockGenerateMutants.mockImplementation(
				async (): Promise<MutationPatch[]> => OFF_BY_ONE_PATCHES,
			);

			const result = JSON.parse(
				await generate_mutants.execute({ files: ['src/foo.ts'] }, '/proj', {}),
			);

			expect(result.verdict).toBe('ready');
			expect(result.count).toBe(2);
			expect(result.patches).toHaveLength(2);
			for (const p of result.patches) {
				expect(p.mutationType).toBe('off-by-one');
			}
			expect(result.patches[0].id).toBe('mut-001');
			expect(result.patches[1].id).toBe('mut-002');
		});

		test('off-by-one patches preserve functionName and lineNumber', async () => {
			const { generate_mutants } = await import(
				'../../../src/tools/generate-mutants.js'
			);

			mockGenerateMutants.mockImplementation(
				async (): Promise<MutationPatch[]> => OFF_BY_ONE_PATCHES,
			);

			const result = JSON.parse(
				await generate_mutants.execute({ files: ['src/bar.ts'] }, '/proj', {}),
			);

			expect(result.patches[0].functionName).toBe('add');
			expect(result.patches[0].lineNumber).toBe(1);
			expect(result.patches[1].functionName).toBe('add');
		});
	});

	// -------------------------------------------------------------------------
	// Outcome 2: null substitution mutation generation
	// -------------------------------------------------------------------------
	describe('2. Null substitution mutation patches (value → null)', () => {
		test('returns verdict=ready with null-substitution patches when LLM provides them', async () => {
			const { generate_mutants } = await import(
				'../../../src/tools/generate-mutants.js'
			);

			mockGenerateMutants.mockImplementation(
				async (): Promise<MutationPatch[]> => NULL_SUBSTITUTION_PATCHES,
			);

			const result = JSON.parse(
				await generate_mutants.execute(
					{ files: ['src/config.ts'] },
					'/proj',
					{},
				),
			);

			expect(result.verdict).toBe('ready');
			expect(result.count).toBe(2);
			expect(result.patches).toHaveLength(2);
			for (const p of result.patches) {
				expect(p.mutationType).toBe('null-substitution');
			}
			expect(result.patches[0].id).toBe('mut-003');
			expect(result.patches[1].id).toBe('mut-004');
		});

		test('null-substitution patches include the original patch diff content', async () => {
			const { generate_mutants } = await import(
				'../../../src/tools/generate-mutants.js'
			);

			mockGenerateMutants.mockImplementation(
				async (): Promise<MutationPatch[]> => NULL_SUBSTITUTION_PATCHES,
			);

			const result = JSON.parse(
				await generate_mutants.execute(
					{ files: ['src/config.ts'] },
					'/proj',
					{},
				),
			);

			expect(result.patches[0].patch).toContain('config.value');
			expect(result.patches[0].patch).toContain('null');
			expect(result.patches[1].patch).toContain('user.id');
		});
	});

	// -------------------------------------------------------------------------
	// Outcome 3: return-value-flip mutation generation
	// -------------------------------------------------------------------------
	describe('3. Return-value-flip mutation patches (return true → false)', () => {
		test('returns verdict=ready with return-value-flip patches when LLM provides them', async () => {
			const { generate_mutants } = await import(
				'../../../src/tools/generate-mutants.js'
			);

			mockGenerateMutants.mockImplementation(
				async (): Promise<MutationPatch[]> => RETURN_VALUE_FLIP_PATCHES,
			);

			const result = JSON.parse(
				await generate_mutants.execute({ files: ['src/auth.ts'] }, '/proj', {}),
			);

			expect(result.verdict).toBe('ready');
			expect(result.count).toBe(2);
			expect(result.patches).toHaveLength(2);
			for (const p of result.patches) {
				expect(p.mutationType).toBe('return-value-flip');
			}
			expect(result.patches[0].id).toBe('mut-005');
			expect(result.patches[1].id).toBe('mut-006');
		});

		test('return-value-flip patches flip between true and false', async () => {
			const { generate_mutants } = await import(
				'../../../src/tools/generate-mutants.js'
			);

			mockGenerateMutants.mockImplementation(
				async (): Promise<MutationPatch[]> => RETURN_VALUE_FLIP_PATCHES,
			);

			const result = JSON.parse(
				await generate_mutants.execute({ files: ['src/auth.ts'] }, '/proj', {}),
			);

			const patches = result.patches;
			const hasTrueToFalse = patches.some(
				(p: MutationPatch) =>
					p.patch.includes('return true') && p.patch.includes('return false'),
			);
			const hasFalseToTrue = patches.some(
				(p: MutationPatch) =>
					p.patch.includes('return false') && p.patch.includes('return true'),
			);
			expect(hasTrueToFalse || hasFalseToTrue).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Edge cases
	// -------------------------------------------------------------------------
	describe('edge cases', () => {
		test('returns SKIP verdict when files is not a non-empty array', async () => {
			const { generate_mutants } = await import(
				'../../../src/tools/generate-mutants.js'
			);

			const result = JSON.parse(
				await generate_mutants.execute({ files: [] }, '/proj', {}),
			);

			expect(result.verdict).toBe('SKIP');
			expect(result.count).toBe(0);
			expect(result.patches).toHaveLength(0);
			expect(result.message).toContain('files must be a non-empty array');
		});

		test('returns SKIP verdict when generateMutants returns empty array', async () => {
			const { generate_mutants } = await import(
				'../../../src/tools/generate-mutants.js'
			);

			mockGenerateMutants.mockImplementation(async () => []);

			const result = JSON.parse(
				await generate_mutants.execute({ files: ['src/foo.ts'] }, '/proj', {}),
			);

			expect(result.verdict).toBe('SKIP');
			expect(result.count).toBe(0);
			expect(result.message).toContain(
				'LLM returned no patches — skipping mutation gate',
			);
		});

		test('returns SKIP verdict when generateMutants throws', async () => {
			const { generate_mutants } = await import(
				'../../../src/tools/generate-mutants.js'
			);

			mockGenerateMutants.mockImplementation(async () => {
				throw new Error('LLM session crashed');
			});

			const result = JSON.parse(
				await generate_mutants.execute({ files: ['src/foo.ts'] }, '/proj', {}),
			);

			expect(result.verdict).toBe('SKIP');
			expect(result.count).toBe(0);
			expect(result.message).toContain('LLM session crashed');
		});

		test('passes files argument through to generateMutants', async () => {
			const { generate_mutants } = await import(
				'../../../src/tools/generate-mutants.js'
			);

			mockGenerateMutants.mockImplementation(
				async (files: string[]): Promise<MutationPatch[]> => {
					return [makePatch('off-by-one', { filePath: files[0] })];
				},
			);

			const result = JSON.parse(
				await generate_mutants.execute(
					{ files: ['src/custom/path.ts'] },
					'/proj',
					{},
				),
			);

			expect(result.patches[0].filePath).toBe('src/custom/path.ts');
		});

		test('result count reflects actual patches returned', async () => {
			const { generate_mutants } = await import(
				'../../../src/tools/generate-mutants.js'
			);

			const threePatches = [
				makePatch('off-by-one'),
				makePatch('null-substitution'),
				makePatch('return-value-flip'),
			];
			mockGenerateMutants.mockImplementation(
				async (): Promise<MutationPatch[]> => threePatches,
			);

			const result = JSON.parse(
				await generate_mutants.execute(
					{ files: ['src/mixed.ts'] },
					'/proj',
					{},
				),
			);

			expect(result.count).toBe(3);
			expect(result.patches).toHaveLength(3);
		});
	});
});
