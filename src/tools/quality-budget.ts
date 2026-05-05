import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import type { QualityBudgetConfig } from '../config/schema';
import { saveEvidence } from '../evidence/manager';
import {
	computeQualityMetrics,
	type QualityMetrics,
	type QualityViolation,
} from '../quality/metrics';
import { createSwarmTool } from './create-tool';

// ============ Types ============

export interface QualityBudgetInput {
	changed_files: string[];
	config?: Partial<QualityBudgetConfig>;
}

export interface QualityBudgetResult {
	verdict: 'pass' | 'fail';
	metrics: QualityMetrics;
	violations: QualityViolation[];
	summary: {
		files_analyzed: number;
		violations_count: number;
		errors_count: number;
		warnings_count: number;
	};
}

// ============ Validation ============

/**
 * Validate the quality budget input
 */
function validateInput(input: unknown): { valid: boolean; error?: string } {
	if (!input || typeof input !== 'object') {
		return { valid: false, error: 'Input must be an object' };
	}

	const typedInput = input as QualityBudgetInput;

	if (!Array.isArray(typedInput.changed_files)) {
		return { valid: false, error: 'changed_files must be an array' };
	}

	for (const file of typedInput.changed_files) {
		if (typeof file !== 'string') {
			return { valid: false, error: 'changed_files must contain strings' };
		}
	}

	if (typedInput.config !== undefined) {
		if (!typedInput.config || typeof typedInput.config !== 'object') {
			return { valid: false, error: 'config must be an object if provided' };
		}
	}

	return { valid: true };
}

// ============ Main Function ============

/**
 * Quality budget tool - enforces maintainability budgets for changed files
 *
 * Computes quality metrics (complexity, API, duplication, test ratio)
 * and compares against configured thresholds to ensure code quality.
 */
export async function qualityBudget(
	input: QualityBudgetInput,
	directory: string,
): Promise<QualityBudgetResult> {
	// Validate input
	const validation = validateInput(input);
	if (!validation.valid) {
		throw new Error(`Invalid input: ${validation.error}`);
	}

	const { changed_files: changedFiles, config } = input;

	// Merge provided config with defaults
	const thresholds: QualityBudgetConfig = {
		enabled: config?.enabled ?? true,
		max_complexity_delta: config?.max_complexity_delta ?? 5,
		max_public_api_delta: config?.max_public_api_delta ?? 10,
		max_duplication_ratio: config?.max_duplication_ratio ?? 0.05,
		min_test_to_code_ratio: config?.min_test_to_code_ratio ?? 0.3,
		enforce_on_globs: config?.enforce_on_globs ?? ['src/**'],
		exclude_globs: config?.exclude_globs ?? [
			'docs/**',
			'tests/**',
			'**/*.test.*',
		],
	};

	// Skip if not enabled
	if (!thresholds.enabled) {
		return {
			verdict: 'pass',
			metrics: {
				complexity_delta: 0,
				public_api_delta: 0,
				duplication_ratio: 0,
				test_to_code_ratio: 0,
				files_analyzed: [],
				thresholds,
				violations: [],
			},
			violations: [],
			summary: {
				files_analyzed: 0,
				violations_count: 0,
				errors_count: 0,
				warnings_count: 0,
			},
		};
	}

	// Compute quality metrics
	const metrics = await computeQualityMetrics(
		changedFiles,
		thresholds,
		directory,
	);

	// Analyze violations
	const errorsCount = metrics.violations.filter(
		(v) => v.severity === 'error',
	).length;
	const warningsCount = metrics.violations.filter(
		(v) => v.severity === 'warning',
	).length;

	// Determine verdict: fail if any errors, pass otherwise
	const verdict: 'pass' | 'fail' = errorsCount > 0 ? 'fail' : 'pass';

	// Save evidence
	await saveEvidence(directory, 'quality_budget', {
		task_id: 'quality_budget',
		type: 'quality_budget',
		timestamp: new Date().toISOString(),
		agent: 'quality_budget',
		verdict,
		summary: `Quality budget check: ${metrics.files_analyzed.length} files analyzed, ${metrics.violations.length} violation(s) found (${errorsCount} errors, ${warningsCount} warnings)`,
		metrics: {
			complexity_delta: metrics.complexity_delta,
			public_api_delta: metrics.public_api_delta,
			duplication_ratio: metrics.duplication_ratio,
			test_to_code_ratio: metrics.test_to_code_ratio,
		},
		thresholds: {
			max_complexity_delta: thresholds.max_complexity_delta,
			max_public_api_delta: thresholds.max_public_api_delta,
			max_duplication_ratio: thresholds.max_duplication_ratio,
			min_test_to_code_ratio: thresholds.min_test_to_code_ratio,
		},
		violations: metrics.violations.map((v) => ({
			type: v.type,
			message: v.message,
			severity: v.severity,
			files: v.files,
		})),
		files_analyzed: metrics.files_analyzed,
	});

	return {
		verdict,
		metrics,
		violations: metrics.violations,
		summary: {
			files_analyzed: metrics.files_analyzed.length,
			violations_count: metrics.violations.length,
			errors_count: errorsCount,
			warnings_count: warningsCount,
		},
	};
}

export const quality_budget: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Enforce maintainability budgets for changed files. Computes quality metrics (complexity, API surface, duplication, test coverage) and compares against configured thresholds. Returns JSON with metrics, violations, and verdict.',
	args: {
		changed_files: z
			.array(z.string())
			.describe('Files to check against quality budgets'),
		config: z
			.object({
				enabled: z.boolean().optional(),
				max_complexity_delta: z.number().optional(),
				max_public_api_delta: z.number().optional(),
				max_duplication_ratio: z.number().optional(),
				min_test_to_code_ratio: z.number().optional(),
			})
			.optional()
			.describe('Quality budget thresholds'),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		const result = await _internals.qualityBudget(
			args as {
				changed_files: string[];
				config?: {
					enabled?: boolean;
					max_complexity_delta?: number;
					max_public_api_delta?: number;
					max_duplication_ratio?: number;
					min_test_to_code_ratio?: number;
				};
			},
			directory,
		);
		return JSON.stringify(result);
	},
});

/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export const _internals: {
	qualityBudget: typeof qualityBudget;
} = {
	qualityBudget,
} as const;
