import type { ASTDiffResult } from '../diff/ast-diff.js';
import type {
	ChangeCategory,
	ClassifiedChange,
} from '../diff/semantic-classifier.js';
import { resolveGitExecutableAsync } from '../utils/git-executable.js';

export type ReviewDepth = 'single' | 'double';

export interface ReviewRouting {
	reviewerCount: number;
	testEngineerCount: number;
	depth: ReviewDepth;
	reason: string;
}

export interface ComplexityMetrics {
	fileCount: number;
	functionCount: number;
	astChangeCount: number;
	maxFileComplexity: number;
}

export interface SemanticRoutingResult {
	routing: ReviewRouting;
	classifications: ClassifiedChange[];
}

const HIGH_RISK_CATEGORIES: ReadonlySet<ChangeCategory> = new Set([
	'GUARD_REMOVED',
	'SIGNATURE_CHANGE',
	'API_CHANGE',
	'DELETED_FUNCTION',
]);

const MAX_FILES_FOR_AST = 50;
const MAX_BYTES_FOR_AST = 500_000;
const AST_TIMEOUT_MS = 5000;

/**
 * Compute complexity metrics for a set of files
 */
export async function computeComplexity(
	directory: string,
	changedFiles: string[],
): Promise<ComplexityMetrics> {
	let functionCount = 0;
	let astChangeCount = 0;
	let maxFileComplexity = 0;

	for (const file of changedFiles) {
		// Skip non-source files
		if (!/\.(ts|js|tsx|jsx|py|go|rs)$/.test(file)) {
			continue;
		}

		try {
			// Get file content
			const fs = await import('node:fs');
			const path = await import('node:path');
			const filePath = path.join(directory, file);

			if (!fs.existsSync(filePath)) {
				continue;
			}

			const content = fs.readFileSync(filePath, 'utf-8');

			// Count functions (simple heuristic)
			const functionMatches = content.match(/\b(function|def|func|fn)\s+\w+/g);
			const fileFunctionCount = functionMatches?.length || 0;
			functionCount += fileFunctionCount;

			// Estimate AST changes (lines changed approximation)
			const lines = content.split('\n').length;
			const estimatedChanges = Math.min(lines / 10, 50); // Cap at 50
			astChangeCount += estimatedChanges;

			// File complexity score
			const fileComplexity = fileFunctionCount + lines / 100;
			maxFileComplexity = Math.max(maxFileComplexity, fileComplexity);
		} catch {
			// Skip files that can't be analyzed
		}
	}

	return {
		fileCount: changedFiles.length,
		functionCount,
		astChangeCount: Math.round(astChangeCount),
		maxFileComplexity: Math.round(maxFileComplexity * 10) / 10,
	};
}

/**
 * Determine review routing based on complexity
 */
export function routeReview(metrics: ComplexityMetrics): ReviewRouting {
	// High complexity triggers double review
	const isHighComplexity =
		metrics.fileCount >= 5 ||
		metrics.functionCount >= 10 ||
		metrics.astChangeCount >= 30 ||
		metrics.maxFileComplexity >= 15;

	if (isHighComplexity) {
		return {
			reviewerCount: 2,
			testEngineerCount: 2,
			depth: 'double',
			reason: `High complexity: ${metrics.fileCount} files, ${metrics.functionCount} functions, complexity score ${metrics.maxFileComplexity}`,
		};
	}

	// Standard review
	return {
		reviewerCount: 1,
		testEngineerCount: 1,
		depth: 'single',
		reason: `Standard complexity: ${metrics.fileCount} files, ${metrics.functionCount} functions`,
	};
}

/**
 * Attempt AST-based semantic classification of changes.
 * Returns null if AST analysis is unavailable, times out, or exceeds bounds.
 */
export async function computeSemanticClassifications(
	directory: string,
	changedFiles: string[],
): Promise<ClassifiedChange[] | null> {
	if (changedFiles.length > MAX_FILES_FOR_AST) return null;

	try {
		const fs = await import('node:fs');
		const path = await import('node:path');

		let totalBytes = 0;
		for (const file of changedFiles) {
			if (!/\.(ts|js|tsx|jsx|py|go|rs)$/.test(file)) continue;
			try {
				const filePath = path.join(directory, file);
				const stat = fs.statSync(filePath);
				totalBytes += stat.size;
				if (totalBytes > MAX_BYTES_FOR_AST) return null;
			} catch {
				// missing file — skip
			}
		}

		const { computeASTDiff } = await import('../diff/ast-diff.js');
		const { classifyChanges } = await import('../diff/semantic-classifier.js');
		const { execFileSync } = await import('node:child_process');
		// A resolution failure (every candidate rejected) falls through to the
		// function's own outer catch below and returns null, matching the
		// documented "AST analysis unavailable" contract — no new throw class
		// is introduced at this call site.
		const gitExecutable = await resolveGitExecutableAsync();

		const astResults: ASTDiffResult[] = [];
		const deadline = Date.now() + AST_TIMEOUT_MS;

		for (const file of changedFiles) {
			if (Date.now() > deadline) break;
			if (!/\.(ts|js|tsx|jsx|py|go|rs)$/.test(file)) continue;

			try {
				const filePath = path.join(directory, file);
				if (!fs.existsSync(filePath)) continue;
				const content = fs.readFileSync(filePath, 'utf-8');
				let oldContent = '';
				try {
					oldContent = execFileSync(gitExecutable, ['show', `HEAD:${file}`], {
						cwd: directory,
						encoding: 'utf-8',
						timeout: 2000,
					});
				} catch {
					// new file or not in git — old content stays empty
				}
				const result = await computeASTDiff(file, oldContent, content);
				astResults.push(result);
			} catch {
				// skip files that can't be parsed
			}
		}

		if (astResults.length === 0) return null;
		return classifyChanges(astResults);
	} catch {
		return null;
	}
}

/**
 * Route review based on semantic classifications.
 * High-risk categories (GUARD_REMOVED, SIGNATURE_CHANGE, API_CHANGE,
 * DELETED_FUNCTION) trigger double review regardless of heuristic metrics.
 */
export function routeReviewSemantic(
	metrics: ComplexityMetrics,
	classifications: ClassifiedChange[],
): ReviewRouting {
	const highRiskChanges = classifications.filter((c) =>
		HIGH_RISK_CATEGORIES.has(c.category),
	);

	if (highRiskChanges.length > 0) {
		const categories = [
			...new Set(highRiskChanges.map((c) => c.category)),
		].join(', ');
		return {
			reviewerCount: 2,
			testEngineerCount: 2,
			depth: 'double',
			reason: `Semantic risk: ${categories} detected in ${highRiskChanges.length} change(s)`,
		};
	}

	return routeReview(metrics);
}

/**
 * Route review with full analysis
 */
export async function routeReviewForChanges(
	directory: string,
	changedFiles: string[],
): Promise<ReviewRouting> {
	const metrics = await computeComplexity(directory, changedFiles);
	const classifications = await computeSemanticClassifications(
		directory,
		changedFiles,
	);

	if (classifications && classifications.length > 0) {
		return routeReviewSemantic(metrics, classifications);
	}

	return routeReview(metrics);
}

/**
 * Check if review should be parallelized
 */
export function shouldParallelizeReview(routing: ReviewRouting): boolean {
	return routing.depth === 'double';
}
