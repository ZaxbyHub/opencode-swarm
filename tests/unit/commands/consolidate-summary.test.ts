/**
 * `/swarm consolidate` success summary (`buildConsolidateSummary`).
 *
 * This is the only production consumer of `SkillImproveResult.macroMotifs.
 * duplicatesSuppressed` / `.successMotifs.duplicatesSuppressed` (issue #1821
 * AC21), so it is tested directly through the module's Tier-0 pure-function
 * seam rather than by mocking `runSkillConsolidation`.
 */

import { describe, expect, it } from 'bun:test';
import { _test_exports } from '../../../src/commands/consolidate.js';
import type { SkillImproveResult } from '../../../src/services/skill-improver.js';

const { buildConsolidateSummary } = _test_exports;

function improverResult(
	overrides: Partial<SkillImproveResult> = {},
): SkillImproveResult {
	return {
		source: 'manual',
		proposalPath: '.swarm/skill-improver/proposals/x.md',
		quota: { calls_used: 1, max_calls: 5 },
		...overrides,
	} as SkillImproveResult;
}

describe('buildConsolidateSummary', () => {
	it('reports motif counts without a suppression line when nothing was deduped', () => {
		const summary = buildConsolidateSummary(
			improverResult({
				macroMotifs: {
					motifs: 2,
					proposalsWritten: 2,
					duplicatesSuppressed: 0,
				},
				successMotifs: {
					motifs: 1,
					proposalsWritten: 1,
					duplicatesSuppressed: 0,
				},
			}),
			'.swarm/skill-improver/state.json',
			5,
		);
		expect(summary).toContain('Failure motifs: 2');
		expect(summary).toContain('Success motifs: 1');
		expect(summary).not.toContain('Duplicate recommendations suppressed');
	});

	it('sums suppression across both motif kinds', () => {
		const summary = buildConsolidateSummary(
			improverResult({
				macroMotifs: {
					motifs: 3,
					proposalsWritten: 0,
					duplicatesSuppressed: 3,
				},
				successMotifs: {
					motifs: 2,
					proposalsWritten: 1,
					duplicatesSuppressed: 1,
				},
			}),
			'.swarm/skill-improver/state.json',
			5,
		);
		// The load-bearing distinction: a run that proposed nothing because
		// everything was already emitted must not read like a run that found
		// nothing at all.
		expect(summary).toContain('Failure motifs: 0');
		expect(summary).toContain('Duplicate recommendations suppressed: 4');
	});

	it('treats a missing duplicatesSuppressed as zero', () => {
		const summary = buildConsolidateSummary(
			improverResult({
				macroMotifs: { motifs: 1, proposalsWritten: 1 },
			}),
			'.swarm/skill-improver/state.json',
			5,
		);
		expect(summary).not.toContain('Duplicate recommendations suppressed');
	});

	it('falls back cleanly when the improver produced no result', () => {
		const summary = buildConsolidateSummary(
			undefined,
			'.swarm/skill-improver/state.json',
			7,
		);
		expect(summary).toContain('Source: unknown');
		expect(summary).toContain('Proposal: (none)');
		expect(summary).toContain('Quota: 0/7');
		expect(summary).not.toContain('Duplicate recommendations suppressed');
		expect(summary).toContain('No skills were auto-activated.');
	});
});
