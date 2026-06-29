import type { QualityBudgetEvidence } from '../config/evidence-schema';
import {
	isValidEvidenceType,
	listEvidenceTaskIds,
	loadEvidence,
} from '../evidence/manager';
import { summarizeTelemetryCosts } from '../services/cost-accounting.js';
import { swarmState } from '../state';
import { warn } from '../utils';

const CI = {
	review_pass_rate: 70,
	test_pass_rate: 80,
	max_agent_error_rate: 20,
	max_hard_limit_hits: 1,
	// Quality budget thresholds
	max_complexity_delta: 5,
	max_public_api_delta: 10,
	max_duplication_ratio: 5, // percentage (5%)
	min_test_to_code_ratio: 30, // percentage (30%)
};

export async function handleBenchmarkCommand(
	directory: string,
	args: string[],
): Promise<string> {
	let cumulative = args.includes('--cumulative');
	if (args.includes('--ci-gate')) cumulative = true;
	const maxCostUsd = parseMaxCostUsd(args);
	const mode: 'in-memory' | 'cumulative' = cumulative
		? 'cumulative'
		: 'in-memory';
	const costSummary = cumulative
		? summarizeTelemetryCosts(directory)
		: undefined;

	// Agent health
	const agentMap = new Map<
		string,
		{ toolCalls: number; hardLimits: number; warnings: number }
	>();
	for (const [, s] of swarmState.agentSessions) {
		const e = agentMap.get(s.agentName) || {
			toolCalls: 0,
			hardLimits: 0,
			warnings: 0,
		};
		const windows = Object.values(s.windows);
		e.toolCalls += windows.reduce((sum, w) => sum + w.toolCalls, 0);
		e.hardLimits += windows.filter((w) => w.hardLimitHit).length;
		e.warnings += windows.filter((w) => w.warningIssued).length;
		agentMap.set(s.agentName, e);
	}
	const agentHealth = Array.from(agentMap.entries()).map(([a, v]) => ({
		agent: a,
		...v,
	}));

	// Tool perf
	const toolPerf: Array<{
		tool: string;
		calls: number;
		successRate: number;
		avg: number;
	}> = [];
	for (const [, a] of swarmState.toolAggregates) {
		const successRate = a.count ? (a.successCount / a.count) * 100 : 0;
		toolPerf.push({
			tool: a.tool,
			calls: a.count,
			successRate: Math.round(successRate * 10) / 10,
			avg: a.count ? Math.round(a.totalDuration / a.count) : 0,
		});
	}
	toolPerf.sort((a, b) => b.calls - a.calls);

	// Delegations
	let delegationCount = 0;
	for (const c of swarmState.delegationChains.values())
		delegationCount += c.length;

	// Cumulative
	let quality:
		| {
				reviewPassRate: number | null;
				testPassRate: number | null;
				totalReviews: number;
				testsPassed: number;
				testsFailed: number;
				additions: number;
				deletions: number;
		  }
		| undefined;
	// Quality metrics from quality_budget evidence
	let qualityMetrics:
		| {
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
		  }
		| undefined;
	if (cumulative) {
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
				result = await loadEvidence(directory, tid);
			} catch (_evidenceErr) {
				warn(
					'benchmark: skipping corrupt or unreadable evidence for task',
					tid,
				);
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
		const totalReviews = reviewPasses + reviewFails,
			totalTests = testPasses + testFails;
		quality = {
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
			qualityMetrics = {
				complexityDelta:
					Math.round((totalComplexityDelta / qualityEvidenceCount) * 10) / 10,
				publicApiDelta:
					Math.round((totalPublicApiDelta / qualityEvidenceCount) * 10) / 10,
				duplicationRatio:
					Math.round((totalDuplicationRatio / qualityEvidenceCount) * 10) / 10,
				testToCodeRatio:
					Math.round((totalTestToCodeRatio / qualityEvidenceCount) * 10) / 10,
				thresholds: {
					maxComplexityDelta: CI.max_complexity_delta,
					maxPublicApiDelta: CI.max_public_api_delta,
					maxDuplicationRatio: CI.max_duplication_ratio,
					minTestToCodeRatio: CI.min_test_to_code_ratio,
				},
				hasEvidence: true,
			};
		} else {
			qualityMetrics = {
				complexityDelta: 0,
				publicApiDelta: 0,
				duplicationRatio: 0,
				testToCodeRatio: 0,
				thresholds: {
					maxComplexityDelta: CI.max_complexity_delta,
					maxPublicApiDelta: CI.max_public_api_delta,
					maxDuplicationRatio: CI.max_duplication_ratio,
					minTestToCodeRatio: CI.min_test_to_code_ratio,
				},
				hasEvidence: false,
			};
		}
	}

	// CI gate
	let ciGate:
		| {
				passed: boolean;
				checks: {
					name: string;
					value: number;
					threshold: number;
					operator: string;
					passed: boolean;
				}[];
		  }
		| undefined;
	if (args.includes('--ci-gate')) {
		let totalCalls = 0,
			totalFailures = 0;
		for (const [, a] of swarmState.toolAggregates) {
			totalCalls += a.count;
			totalFailures += a.failureCount;
		}
		const agentErrorRate = totalCalls ? (totalFailures / totalCalls) * 100 : 0;
		let maxHardLimits = 0;
		for (const v of agentMap.values())
			if (v.hardLimits > maxHardLimits) maxHardLimits = v.hardLimits;

		// Get quality metrics values (use 0 if no evidence)
		// Quality checks only fail when there IS evidence and it exceeds thresholds
		// When no evidence exists, quality checks pass by default
		const hasQualityEvidence = qualityMetrics?.hasEvidence ?? false;
		const complexityDelta = qualityMetrics?.complexityDelta ?? 0;
		const publicApiDelta = qualityMetrics?.publicApiDelta ?? 0;
		const duplicationRatio = qualityMetrics?.duplicationRatio ?? 0;
		const testToCodeRatio = qualityMetrics?.testToCodeRatio ?? 0;

		const checks = [
			{
				name: 'Review pass rate',
				value: quality?.reviewPassRate ?? 0,
				threshold: CI.review_pass_rate,
				operator: '>=',
				passed: (quality?.reviewPassRate ?? 0) >= CI.review_pass_rate,
			},
			{
				name: 'Test pass rate',
				value: quality?.testPassRate ?? 0,
				threshold: CI.test_pass_rate,
				operator: '>=',
				passed: (quality?.testPassRate ?? 0) >= CI.test_pass_rate,
			},
			{
				name: 'Agent error rate',
				value: Math.round(agentErrorRate * 10) / 10,
				threshold: CI.max_agent_error_rate,
				operator: '<=',
				passed: agentErrorRate <= CI.max_agent_error_rate,
			},
			{
				name: 'Hard limit hits',
				value: maxHardLimits,
				threshold: CI.max_hard_limit_hits,
				operator: '<=',
				passed: maxHardLimits <= CI.max_hard_limit_hits,
			},
			// Quality budget checks - only fail if evidence exists and exceeds threshold
			{
				name: 'Complexity Delta',
				value: complexityDelta,
				threshold: CI.max_complexity_delta,
				operator: '<=',
				passed:
					!hasQualityEvidence || complexityDelta <= CI.max_complexity_delta,
			},
			{
				name: 'Public API Delta',
				value: publicApiDelta,
				threshold: CI.max_public_api_delta,
				operator: '<=',
				passed:
					!hasQualityEvidence || publicApiDelta <= CI.max_public_api_delta,
			},
			{
				name: 'Duplication Ratio',
				value: duplicationRatio,
				threshold: CI.max_duplication_ratio,
				operator: '<=',
				passed:
					!hasQualityEvidence || duplicationRatio <= CI.max_duplication_ratio,
			},
			{
				name: 'Test-to-Code Ratio',
				value: testToCodeRatio,
				threshold: CI.min_test_to_code_ratio,
				operator: '>=',
				passed:
					!hasQualityEvidence || testToCodeRatio >= CI.min_test_to_code_ratio,
			},
		];
		if (maxCostUsd !== null) {
			checks.push({
				name: 'Total cost',
				value: costSummary?.total_cost_usd ?? 0,
				threshold: maxCostUsd,
				operator: '<=',
				passed: (costSummary?.total_cost_usd ?? 0) <= maxCostUsd,
			});
		}
		ciGate = { passed: checks.every((c) => c.passed), checks: checks };
	}

	// Output
	const lines: string[] = [
		`## Swarm Benchmark (mode: ${mode})`,
		'',
		'### Agent Health',
	];
	if (!agentHealth.length) lines.push('No agent sessions recorded');
	else
		for (const { agent, toolCalls, hardLimits, warnings } of agentHealth) {
			const parts = [`${toolCalls} tool calls`];
			if (warnings > 0)
				parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
			parts.push(
				hardLimits
					? `${hardLimits} hard limit hit${hardLimits > 1 ? 's' : ''}`
					: '0 hard limits',
			);
			lines.push(
				`- ${hardLimits ? '⚠️' : '✅'} **${agent}**: ${parts.join(', ')}`,
			);
		}
	lines.push('', '### Tool Performance');
	if (!toolPerf.length) lines.push('No tool data recorded');
	else {
		lines.push(
			'| Tool | Calls | Success Rate | Avg Duration |',
			'|------|-------|-------------|-------------|',
		);
		for (const { tool, calls, successRate, avg } of toolPerf)
			lines.push(`| ${tool} | ${calls} | ${successRate}% | ${avg}ms |`);
	}
	lines.push(
		'',
		'### Delegations',
		delegationCount
			? `Total: ${delegationCount} delegations`
			: 'No delegations recorded',
		'',
	);

	if (quality) {
		lines.push('### Quality Signals');
		if (!quality.totalReviews && !quality.testsPassed && !quality.additions)
			lines.push('No evidence data found');
		else {
			if (quality.reviewPassRate !== null)
				lines.push(
					`- Review pass rate: ${quality.reviewPassRate}% (${quality.totalReviews}) ${quality.reviewPassRate >= 70 ? '✅' : '❌'}`,
				);
			else lines.push('- Review pass rate: N/A (no reviews)');
			if (quality.testPassRate !== null)
				lines.push(
					`- Test pass rate: ${quality.testPassRate}% (${quality.testsPassed}/${quality.testsPassed + quality.testsFailed}) ${quality.testPassRate >= 80 ? '✅' : '❌'}`,
				);
			else lines.push('- Test pass rate: N/A (no tests)');
			lines.push(
				`- Code churn: +${quality.additions} / -${quality.deletions} lines`,
			);
		}
		lines.push('');
	}

	// Quality Metrics section
	if (qualityMetrics?.hasEvidence) {
		lines.push('### Quality Metrics');
		lines.push(
			`- Complexity Delta: ${qualityMetrics.complexityDelta} (max: ${qualityMetrics.thresholds.maxComplexityDelta}) ${qualityMetrics.complexityDelta <= qualityMetrics.thresholds.maxComplexityDelta ? '✅' : '❌'}`,
		);
		lines.push(
			`- Public API Delta: ${qualityMetrics.publicApiDelta} (max: ${qualityMetrics.thresholds.maxPublicApiDelta}) ${qualityMetrics.publicApiDelta <= qualityMetrics.thresholds.maxPublicApiDelta ? '✅' : '❌'}`,
		);
		lines.push(
			`- Duplication Ratio: ${qualityMetrics.duplicationRatio}% (max: ${qualityMetrics.thresholds.maxDuplicationRatio}%) ${qualityMetrics.duplicationRatio <= qualityMetrics.thresholds.maxDuplicationRatio ? '✅' : '❌'}`,
		);
		lines.push(
			`- Test-to-Code Ratio: ${qualityMetrics.testToCodeRatio}% (min: ${qualityMetrics.thresholds.minTestToCodeRatio}%) ${qualityMetrics.testToCodeRatio >= qualityMetrics.thresholds.minTestToCodeRatio ? '✅' : '❌'}`,
		);
		lines.push('');
	}

	if (costSummary) {
		lines.push('### Cost Signals');
		lines.push(
			`- Total tracked cost: $${costSummary.total_cost_usd.toFixed(6)} (${costSummary.delegations} delegations)`,
			`- Reported: $${costSummary.total_reported_usd.toFixed(6)}; estimated: $${costSummary.total_estimated_usd.toFixed(6)}; unavailable: ${costSummary.unavailable_delegations}`,
		);
		lines.push('');
	}

	if (ciGate) {
		lines.push('### CI Gate', ciGate.passed ? '✅ PASSED' : '❌ FAILED');
		for (const c of ciGate.checks) {
			// Format value based on check type
			let valueStr: string;
			if (c.name === 'Complexity Delta' || c.name === 'Public API Delta') {
				valueStr = `${c.value}`;
			} else if (c.name === 'Total cost') {
				valueStr = `$${c.value.toFixed(6)}`;
			} else {
				valueStr = `${c.value}%`;
			}
			const thresholdStr =
				c.name === 'Complexity Delta' || c.name === 'Public API Delta'
					? `${c.threshold}`
					: c.name === 'Total cost'
						? `$${c.threshold.toFixed(6)}`
						: `${c.threshold}%`;
			lines.push(
				`- ${c.name}: ${valueStr} ${c.operator} ${thresholdStr} ${c.passed ? '✅' : '❌'}`,
			);
		}
		lines.push('');
	}

	const json: Record<string, unknown> = {
		mode,
		timestamp: new Date().toISOString(),
		agent_health: agentHealth.map((a) => ({
			agent: a.agent,
			tool_calls: a.toolCalls,
			hard_limit_hits: a.hardLimits,
			warnings: a.warnings,
		})),
		tool_performance: toolPerf.map((t) => ({
			tool: t.tool,
			calls: t.calls,
			success_rate: t.successRate,
			avg_duration_ms: t.avg,
		})),
		delegations: delegationCount,
	};
	if (quality)
		json.quality = {
			review_pass_rate: quality.reviewPassRate,
			test_pass_rate: quality.testPassRate,
			total_reviews: quality.totalReviews,
			total_tests_passed: quality.testsPassed,
			total_tests_failed: quality.testsFailed,
			additions: quality.additions,
			deletions: quality.deletions,
		};
	if (qualityMetrics)
		json.quality_metrics = {
			complexity_delta: qualityMetrics.complexityDelta,
			public_api_delta: qualityMetrics.publicApiDelta,
			duplication_ratio: qualityMetrics.duplicationRatio,
			test_to_code_ratio: qualityMetrics.testToCodeRatio,
			thresholds: qualityMetrics.thresholds,
			has_evidence: qualityMetrics.hasEvidence,
		};
	if (costSummary)
		json.costs = {
			total_cost_usd: costSummary.total_cost_usd,
			total_reported_usd: costSummary.total_reported_usd,
			total_estimated_usd: costSummary.total_estimated_usd,
			total_input_tokens: costSummary.total_input_tokens,
			total_output_tokens: costSummary.total_output_tokens,
			total_reasoning_tokens: costSummary.total_reasoning_tokens,
			total_cache_tokens: costSummary.total_cache_tokens,
			delegations: costSummary.delegations,
			unavailable_delegations: costSummary.unavailable_delegations,
		};
	if (ciGate)
		json.ci_gate = {
			passed: ciGate.passed,
			checks: ciGate.checks.map((c) => ({
				name: c.name,
				value: c.value,
				threshold: c.threshold,
				operator: c.operator as '>=' | '<=',
				passed: c.passed,
			})),
		};
	lines.push(
		'[BENCHMARK_JSON]',
		JSON.stringify(json, null, 2),
		'[/BENCHMARK_JSON]',
	);
	return lines.join('\n');
}

function parseMaxCostUsd(args: string[]): number | null {
	const index = args.indexOf('--max-cost-usd');
	if (index === -1) return null;
	const raw = args[index + 1];
	if (!raw || raw.startsWith('--')) {
		throw new Error(
			'Invalid --max-cost-usd value: expected a non-negative number.',
		);
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(
			'Invalid --max-cost-usd value: expected a non-negative number.',
		);
	}
	return parsed;
}
