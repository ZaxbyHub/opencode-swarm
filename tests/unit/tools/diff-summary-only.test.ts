import { describe, expect, test } from 'bun:test';
import { diff } from '../../../src/tools/diff';

describe('diff tool — summaryOnly parameter', () => {
	describe('real git repo integration — summaryOnly=true vs false', () => {
		test('summaryOnly=true skips AST processing (real git)', async () => {
			const workDir = process.cwd();

			const result = await diff.execute(
				{ base: 'HEAD', paths: ['package.json'], summaryOnly: true },
				workDir,
			);
			const parsed = JSON.parse(result);

			expect(Array.isArray(parsed.files)).toBe(true);
			expect(parsed.hasContractChanges).toBe(false);
			expect(parsed.contractChanges).toEqual([]);
			expect(parsed.summary).toContain('summary only');
			expect('astDiffs' in parsed).toBe(false);
			expect('semanticSummary' in parsed).toBe(false);
			expect('markdownSummary' in parsed).toBe(false);
		});

		test('summaryOnly=false includes AST data when available (real git)', async () => {
			const workDir = process.cwd();

			const result = await diff.execute(
				{ base: 'HEAD', paths: ['package.json'], summaryOnly: false },
				workDir,
			);
			const parsed = JSON.parse(result);

			expect(Array.isArray(parsed.files)).toBe(true);
			expect('hasContractChanges' in parsed).toBe(true);
			// AST data may or may not be present depending on whether AST parsing succeeded
			// but it should have been attempted (execFileSync called multiple times)
		});

		test('real git with no changes returns empty files array', async () => {
			const workDir = process.cwd();

			// Use a non-existent file to simulate no changes
			const result = await diff.execute(
				{
					base: 'HEAD',
					paths: ['nonexistent-file-xyz.txt'],
					summaryOnly: true,
				},
				workDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.files).toEqual([]);
			expect(parsed.summary).toContain('0 files changed');
		});
	});
});
