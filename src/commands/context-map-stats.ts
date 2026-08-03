/**
 * /swarm context-map stats — show aggregated context-capsule telemetry.
 * FR-013: thin invocation wrapper over getTelemetrySummary; aggregation logic unchanged.
 */

import { getTelemetrySummary } from '../context-map/telemetry.js';

export async function handleContextMapStatsCommand(
	directory: string,
): Promise<string> {
	const summary = getTelemetrySummary(directory);

	if (summary.total_delegations === 0) {
		return 'No capsule telemetry recorded.';
	}

	const pct = (n: number, d: number): string =>
		d === 0 ? 'N/A' : `${((n / d) * 100).toFixed(1)}%`;

	const lines: string[] = [
		'# Context-map capsule telemetry',
		'',
		`**Total delegations:** ${summary.total_delegations}`,
		`**Cache hits:** ${summary.total_cache_hits} (${pct(summary.total_cache_hits, summary.total_cache_hits + summary.total_cache_misses)} hit rate)`,
		`**Cache misses:** ${summary.total_cache_misses}`,
		`**Stale entries detected:** ${summary.total_stale_entries}`,
		`**Avg token estimate:** ${summary.avg_token_estimate.toFixed(1)} tokens/capsule`,
		`**Success rate:** ${summary.success_rate.toFixed(1)}%`,
		`**Recommended reads:** ${summary.total_recommended_reads}`,
		`**Skipped reads:** ${summary.total_skipped_reads}`,
	];

	return lines.join('\n');
}
