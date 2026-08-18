/**
 * Verification tests for review-router module
 * Covers computeComplexity, routeReview, and high complexity detection
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClassifiedChange } from '../../../src/diff/semantic-classifier';
import {
	type ComplexityMetrics,
	computeComplexity,
	type ReviewRouting,
	routeReview,
	routeReviewForChanges,
	routeReviewSemantic,
	shouldParallelizeReview,
} from '../../../src/parallel/review-router';

describe('review-router module tests', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-router-test-'));
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ========== GROUP 1: computeComplexity tests ==========
	describe('Group 1: computeComplexity', () => {
		it('calculates metrics for TypeScript files', async () => {
			// Create a TypeScript file with functions
			const testFile = path.join(tmpDir, 'test.ts');
			fs.writeFileSync(
				testFile,
				`
function firstFunc() { return 1; }
function secondFunc() { return 2; }
function thirdFunc() { return 3; }
export function main() { return firstFunc(); }
`,
			);

			const metrics = await computeComplexity(tmpDir, ['test.ts']);

			expect(metrics.fileCount).toBe(1);
			expect(metrics.functionCount).toBeGreaterThanOrEqual(3);
			expect(metrics.astChangeCount).toBeGreaterThan(0);
			expect(metrics.maxFileComplexity).toBeGreaterThan(0);
		});

		it('calculates metrics for Python files', async () => {
			const testFile = path.join(tmpDir, 'test.py');
			fs.writeFileSync(
				testFile,
				`
def first_func():
    pass

def second_func():
    pass

class MyClass:
    def method(self):
        pass
`,
			);

			const metrics = await computeComplexity(tmpDir, ['test.py']);

			expect(metrics.fileCount).toBe(1);
			expect(metrics.functionCount).toBeGreaterThanOrEqual(2);
		});

		it('skips non-source files', async () => {
			const testFile = path.join(tmpDir, 'readme.md');
			fs.writeFileSync(testFile, '# Readme\nSome content');

			const metrics = await computeComplexity(tmpDir, ['readme.md']);

			expect(metrics.fileCount).toBe(1);
			expect(metrics.functionCount).toBe(0);
		});

		it('handles non-existent files gracefully', async () => {
			const metrics = await computeComplexity(tmpDir, ['nonexistent.ts']);

			expect(metrics.fileCount).toBe(1);
			expect(metrics.functionCount).toBe(0);
		});

		it('accumulates metrics across multiple files', async () => {
			fs.writeFileSync(
				path.join(tmpDir, 'file1.ts'),
				'function a() {} function b() {}',
			);
			fs.writeFileSync(
				path.join(tmpDir, 'file2.ts'),
				'function c() {} function d() {} function e() {}',
			);

			const metrics = await computeComplexity(tmpDir, ['file1.ts', 'file2.ts']);

			expect(metrics.fileCount).toBe(2);
			expect(metrics.functionCount).toBeGreaterThanOrEqual(5);
		});
	});

	// ========== GROUP 2: routeReview tests ==========
	describe('Group 2: routeReview', () => {
		it('returns single review for low complexity', () => {
			const metrics: ComplexityMetrics = {
				fileCount: 1,
				functionCount: 2,
				astChangeCount: 5,
				maxFileComplexity: 5,
			};

			const routing = routeReview(metrics);

			expect(routing.reviewerCount).toBe(1);
			expect(routing.testEngineerCount).toBe(1);
			expect(routing.depth).toBe('single');
			expect(routing.reason).toContain('Standard complexity');
		});

		it('returns double review for high file count', () => {
			const metrics: ComplexityMetrics = {
				fileCount: 10, // >= 5 triggers high
				functionCount: 3,
				astChangeCount: 5,
				maxFileComplexity: 5,
			};

			const routing = routeReview(metrics);

			expect(routing.reviewerCount).toBe(2);
			expect(routing.testEngineerCount).toBe(2);
			expect(routing.depth).toBe('double');
			expect(routing.reason).toContain('High complexity');
		});

		it('returns double review for high function count', () => {
			const metrics: ComplexityMetrics = {
				fileCount: 1,
				functionCount: 15, // >= 10 triggers high
				astChangeCount: 5,
				maxFileComplexity: 5,
			};

			const routing = routeReview(metrics);

			expect(routing.depth).toBe('double');
		});

		it('returns double review for high AST changes', () => {
			const metrics: ComplexityMetrics = {
				fileCount: 1,
				functionCount: 3,
				astChangeCount: 50, // >= 30 triggers high
				maxFileComplexity: 5,
			};

			const routing = routeReview(metrics);

			expect(routing.depth).toBe('double');
		});

		it('returns double review for high max file complexity', () => {
			const metrics: ComplexityMetrics = {
				fileCount: 1,
				functionCount: 3,
				astChangeCount: 5,
				maxFileComplexity: 20, // >= 15 triggers high
			};

			const routing = routeReview(metrics);

			expect(routing.depth).toBe('double');
		});

		it('includes complexity score in reason', () => {
			const metrics: ComplexityMetrics = {
				fileCount: 10,
				functionCount: 20,
				astChangeCount: 100,
				maxFileComplexity: 25,
			};

			const routing = routeReview(metrics);

			expect(routing.reason).toContain('10 files');
			expect(routing.reason).toContain('20 functions');
			expect(routing.reason).toContain('complexity score 25');
		});
	});

	// ========== GROUP 3: shouldParallelizeReview tests ==========
	describe('Group 3: shouldParallelizeReview', () => {
		it('returns true for double review', () => {
			const routing: ReviewRouting = {
				reviewerCount: 2,
				testEngineerCount: 2,
				depth: 'double',
				reason: 'High complexity',
			};

			expect(shouldParallelizeReview(routing)).toBe(true);
		});

		it('returns false for single review', () => {
			const routing: ReviewRouting = {
				reviewerCount: 1,
				testEngineerCount: 1,
				depth: 'single',
				reason: 'Standard complexity',
			};

			expect(shouldParallelizeReview(routing)).toBe(false);
		});
	});

	// ========== GROUP 4: routeReviewSemantic tests ==========
	describe('Group 4: routeReviewSemantic', () => {
		const lowMetrics: ComplexityMetrics = {
			fileCount: 1,
			functionCount: 2,
			astChangeCount: 5,
			maxFileComplexity: 3,
		};

		function makeClassification(
			category: ClassifiedChange['category'],
		): ClassifiedChange {
			return {
				category,
				riskLevel: 'High',
				filePath: 'src/test.ts',
				symbolName: 'testFn',
				changeType: 'modified',
				lineStart: 1,
				lineEnd: 10,
				description: `${category} detected`,
			};
		}

		it('triggers double review for GUARD_REMOVED', () => {
			const routing = routeReviewSemantic(lowMetrics, [
				makeClassification('GUARD_REMOVED'),
			]);
			expect(routing.depth).toBe('double');
			expect(routing.reason).toContain('GUARD_REMOVED');
		});

		it('triggers double review for SIGNATURE_CHANGE', () => {
			const routing = routeReviewSemantic(lowMetrics, [
				makeClassification('SIGNATURE_CHANGE'),
			]);
			expect(routing.depth).toBe('double');
			expect(routing.reason).toContain('SIGNATURE_CHANGE');
		});

		it('triggers double review for API_CHANGE', () => {
			const routing = routeReviewSemantic(lowMetrics, [
				makeClassification('API_CHANGE'),
			]);
			expect(routing.depth).toBe('double');
			expect(routing.reason).toContain('Semantic risk');
		});

		it('triggers double review for DELETED_FUNCTION', () => {
			const routing = routeReviewSemantic(lowMetrics, [
				makeClassification('DELETED_FUNCTION'),
			]);
			expect(routing.depth).toBe('double');
		});

		it('falls back to heuristic for low-risk categories', () => {
			const routing = routeReviewSemantic(lowMetrics, [
				makeClassification('COSMETIC'),
				makeClassification('REFACTOR'),
			]);
			expect(routing.depth).toBe('single');
			expect(routing.reason).toContain('Standard complexity');
		});

		it('includes all distinct high-risk categories in reason', () => {
			const routing = routeReviewSemantic(lowMetrics, [
				makeClassification('GUARD_REMOVED'),
				makeClassification('API_CHANGE'),
			]);
			expect(routing.reason).toContain('GUARD_REMOVED');
			expect(routing.reason).toContain('API_CHANGE');
		});

		it('reports change count in reason', () => {
			const routing = routeReviewSemantic(lowMetrics, [
				makeClassification('GUARD_REMOVED'),
				makeClassification('GUARD_REMOVED'),
			]);
			expect(routing.reason).toContain('2 change(s)');
		});

		it('empty classifications fall back to heuristic', () => {
			const routing = routeReviewSemantic(lowMetrics, []);
			expect(routing.depth).toBe('single');
		});
	});

	// ========== GROUP 5: routeReviewForChanges integration test ==========
	describe('Group 4: routeReviewForChanges integration', () => {
		it('computes and routes in one call', async () => {
			fs.writeFileSync(
				path.join(tmpDir, 'test.ts'),
				'function a() {} function b() {}',
			);

			const routing = await routeReviewForChanges(tmpDir, ['test.ts']);

			expect(routing.reviewerCount).toBeGreaterThanOrEqual(1);
			expect(routing.depth).toBeDefined();
			expect(routing.reason).toBeDefined();
		});
	});
});
