/**
 * Shared evidence-quality computation (issue #2497, plan D2).
 *
 * Extracted verbatim from `src/commands/benchmark.ts` (the cumulative
 * evidence aggregation loop) so the plugin surface
 * (`/swarm benchmark --ci-gate`) and the host-decoupled advisory surface
 * (`swarm ci`) evaluate evidence-derived quality signals through ONE
 * implementation. `benchmark.ts` consumes `computeEvidenceQualitySummary`
 * directly; the advisory evaluator additionally maps "no evidence data" to
 * an honest `no_data` disposition instead of benchmark's
 * pass-on-no-evidence semantics (which are preserved here byte-for-byte for
 * the benchmark path).
 *
 * Host-decoupling contract: filesystem-only reads (evidence bundles under
 * `.swarm/evidence/`); no host client, no session state.
 */

import type { QualityBudgetEvidence } from '../config/evidence-schema.js';
import {
	isValidEvidenceType,
	listEvidenceTaskIds,
	loadEvidence,
} from '../evidence/manager.js';
import { warn } from '../utils/index.js';

/** CI threshold constants (unchanged values, moved from benchmark.ts so both
 * consumers share one definition). */
export const CI_QUALITY_THRESHOLDS = {
	review_pass_rate: 70,
	test_pass_rate: 80,
	max_agent_error_rate: 20,
	max_hard_limit_hits: 1,
	// Quality budget thresholds
	max_complexity_delta: 5,
	max_public_api_delta: 10,
	max_duplication_ratio: 5, // percentage (5%)
	min_test_to_code_ratio: 30, // percentage (30%)
} as const;

export interface EvidenceQualitySummary {
	reviewPassRate: number | null;
	testPassRate: number | null;
	totalReviews: number;
	testsPassed: number;
	testsFailed: number;
	additions: number;
	deletions: number;
	qualityMetrics: {
		complexityDelta: number;
		publicApiDelta: number;
		duplicationRatio: number;
		testToCodeRatio: number;
		thresholds: {
			maxComplexityDelta: number;
			maxPublicApiDelta: number;
			maxDuplicationRatio: number;
			minTestToCodeRatio: number;
		};
		hasEvidence: boolean;
	};
}

/**
 * Aggregate review/test/diff/quality-budget signals across every evidence
 * bundle under `.swarm/evidence/`. Behavior-identical to the loop that used
 * to live inline in `handleBenchmarkCommand` (same rounding, same warn()
 * side effects on corrupt/unknown entries) so benchmark output stays
 * byte-compatible after the extraction.
 */
export async function computeEvidenceQualitySummary(
	directory: string,
): Promise<EvidenceQualitySummary> {
	let reviewPasses = 0,
		reviewFails = 0,
		testPasses = 0,
		testFails = 0,
		additions = 0,
		deletions = 0;
	// Quality metrics accumulation
	let totalComplexityDelta = 0;
	let totalPublicApiDelta = 0;
	let totalDuplicationRatio = 0;
	let totalTestToCodeRatio = 0;
	let qualityEvidenceCount = 0;
	for (const tid of await listEvidenceTaskIds(directory)) {
		let result: Awaited<ReturnType<typeof loadEvidence>>;
		try {
			// `{ migrate: false }` keeps this a pure read: the default load
			// path would otherwise take the evidence-loader lock and rename a
			// temp file over a legacy flat-retrospective bundle in place,
			// mutating the evaluated repo during read-only advisory CI
			// evaluation (`swarm ci`). The returned bundle is identical either
			// way, so benchmark output is unchanged.
			result = await loadEvidence(directory, tid, { migrate: false });
		} catch (_evidenceErr) {
			warn('benchmark: skipping corrupt or unreadable evidence for task', tid);
			continue;
		}
		if (result.status !== 'found') continue;
		for (const e of result.bundle.entries) {
			// Skip unknown evidence types gracefully with warning
			if (!isValidEvidenceType(e.type)) {
				warn(`Unknown evidence type '${e.type}' in task ${tid}, skipping`);
				continue;
			}

			if (e.type === 'review') {
				if (e.verdict === 'approved') reviewPasses++;
				else if (e.verdict === 'rejected') reviewFails++;
			} else if (e.type === 'test') {
				testPasses += e.tests_passed;
				testFails += e.tests_failed;
			} else if (e.type === 'diff') {
				additions += e.additions;
				deletions += e.deletions;
			} else if (e.type === 'quality_budget') {
				const qe = e as QualityBudgetEvidence;
				totalComplexityDelta += qe.metrics.complexity_delta;
				totalPublicApiDelta += qe.metrics.public_api_delta;
				totalDuplicationRatio += qe.metrics.duplication_ratio * 100; // Convert to percentage
				totalTestToCodeRatio += qe.metrics.test_to_code_ratio * 100; // Convert to percentage
				qualityEvidenceCount++;
			}
		}
	}
	const totalReviews = reviewPasses + reviewFails;
	const totalTests = testPasses + testFails;
	const quality = {
		reviewPassRate: totalReviews
			? Math.round((reviewPasses / totalReviews) * 1000) / 10
			: null,
		testPassRate: totalTests
			? Math.round((testPasses / totalTests) * 1000) / 10
			: null,
		totalReviews,
		testsPassed: testPasses,
		testsFailed: testFails,
		additions,
		deletions,
	};
	// Calculate average quality metrics
	if (qualityEvidenceCount > 0) {
		return {
			...quality,
			qualityMetrics: {
				complexityDelta:
					Math.round((totalComplexityDelta / qualityEvidenceCount) * 10) / 10,
				publicApiDelta:
					Math.round((totalPublicApiDelta / qualityEvidenceCount) * 10) / 10,
				duplicationRatio:
					Math.round((totalDuplicationRatio / qualityEvidenceCount) * 10) / 10,
				testToCodeRatio:
					Math.round((totalTestToCodeRatio / qualityEvidenceCount) * 10) / 10,
				thresholds: {
					maxComplexityDelta: CI_QUALITY_THRESHOLDS.max_complexity_delta,
					maxPublicApiDelta: CI_QUALITY_THRESHOLDS.max_public_api_delta,
					maxDuplicationRatio: CI_QUALITY_THRESHOLDS.max_duplication_ratio,
					minTestToCodeRatio: CI_QUALITY_THRESHOLDS.min_test_to_code_ratio,
				},
				hasEvidence: true,
			},
		};
	}
	return {
		...quality,
		qualityMetrics: {
			complexityDelta: 0,
			publicApiDelta: 0,
			duplicationRatio: 0,
			testToCodeRatio: 0,
			thresholds: {
				maxComplexityDelta: CI_QUALITY_THRESHOLDS.max_complexity_delta,
				maxPublicApiDelta: CI_QUALITY_THRESHOLDS.max_public_api_delta,
				maxDuplicationRatio: CI_QUALITY_THRESHOLDS.max_duplication_ratio,
				minTestToCodeRatio: CI_QUALITY_THRESHOLDS.min_test_to_code_ratio,
			},
			hasEvidence: false,
		},
	};
}
