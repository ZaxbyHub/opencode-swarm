/**
 * /swarm context-map stats — show aggregated context-capsule telemetry.
 * FR-013: thin invocation wrapper over getTelemetrySummary; aggregation logic unchanged.
 * Issue #2037: the summary is now a bounded lifetime aggregate (see
 * src/context-map/telemetry.ts). Existing prose output is preserved verbatim;
 * this command additionally discloses partial coverage / dropped / corrupt
 * counts when those are non-zero so a bounded store never presents a
 * complete-looking number for truncated history.
 */

import { getTelemetrySummary } from '../context-map/telemetry.js';

export async function handleContextMapStatsCommand(
	directory: string,
): Promise<string> {
	const summary = getTelemetrySummary(directory);

	if (summary.total_delegations === 0 && summary.corrupt_entries === 0) {
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

	// Issue #2037 disclosure: only surface non-default coverage/drop/corrupt
	// facts. `'complete'` is the default and adds nothing. A truncated read
	// (header'd store still draining an unmigrated legacy tail) surfaces as
	// 'partial-unmigrated', never as a complete-looking 'truncated' number.
	if (summary.coverage === 'partial-unmigrated') {
		lines.push(
			'',
			'> Historical context telemetry spans more than the documented read bound and is being migrated in bounded passes; totals above cover only the part already accounted. Run `/swarm context-map stats` again after the store settles for the full lifetime figure.',
		);
	}
	if (summary.dropped_entries > 0) {
		lines.push(
			`**Dropped (age-pruned raw records, totals unaffected):** ${summary.dropped_entries}`,
		);
	}
	if (summary.corrupt_entries > 0) {
		lines.push(
			`**Corrupt/partial lines skipped (diagnostics only):** ${summary.corrupt_entries}`,
		);
	}

	return lines.join('\n');
}
