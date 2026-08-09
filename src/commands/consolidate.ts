import { loadPluginConfigWithMeta } from '../config';
import {
	KnowledgeConfigSchema,
	SkillImproverConfigSchema,
} from '../config/schema';
import { runSkillConsolidation } from '../services/skill-consolidation.js';
import type { SkillImproveResult } from '../services/skill-improver.js';

/**
 * Render the success summary for a completed consolidation run.
 *
 * Extracted as a pure function so the reporting surface — in particular the
 * #1821 AC21 duplicate-suppression line, whose only production consumer is this
 * command — is testable without mocking `runSkillConsolidation`.
 */
function buildConsolidateSummary(
	improver: SkillImproveResult | undefined,
	statePath: string,
	fallbackMaxCalls: number,
): string {
	const lines = [
		'Skill consolidation complete.',
		'',
		`Source: ${improver?.source ?? 'unknown'}`,
		`Proposal: ${improver?.proposalPath ?? '(none)'}`,
		`Quota: ${improver?.quota.calls_used ?? 0}/${improver?.quota.max_calls ?? fallbackMaxCalls}`,
		`State: ${statePath}`,
	];
	if (improver?.draftSkillsWritten?.length) {
		lines.push(`Draft skills: ${improver.draftSkillsWritten.length}`);
	}
	if (improver?.macroMotifs) {
		lines.push(`Failure motifs: ${improver.macroMotifs.proposalsWritten}`);
	}
	if (improver?.successMotifs) {
		lines.push(`Success motifs: ${improver.successMotifs.proposalsWritten}`);
	}
	// #1821 AC21: surface cross-producer dedup so a run that proposes nothing
	// because everything was already emitted is distinguishable from a run that
	// found nothing at all.
	const duplicatesSuppressed =
		(improver?.macroMotifs?.duplicatesSuppressed ?? 0) +
		(improver?.successMotifs?.duplicatesSuppressed ?? 0);
	if (duplicatesSuppressed > 0) {
		lines.push(`Duplicate recommendations suppressed: ${duplicatesSuppressed}`);
	}
	lines.push('', 'No skills were auto-activated.');
	return lines.join('\n');
}

export async function handleConsolidateCommand(
	directory: string,
	args: string[],
	options: { sessionID?: string } = {},
): Promise<string> {
	const force =
		args.includes('--force') || !args.includes('--respect-interval');
	const evaluate = args.includes('--evaluate');
	const { config } = loadPluginConfigWithMeta(directory);
	const skillConfig = SkillImproverConfigSchema.parse(
		config.skill_improver ?? {},
	);
	const knowledgeConfig = KnowledgeConfigSchema.parse(config.knowledge ?? {});
	const enrichmentConfig = knowledgeConfig.enrichment ?? {
		max_calls_per_day: 30,
		quota_window: 'utc' as const,
	};

	try {
		const result = await runSkillConsolidation({
			directory,
			config: skillConfig,
			source: 'manual',
			sessionId: options.sessionID,
			force,
			evaluateDrafts: evaluate,
			enrichmentQuota: {
				maxCalls: enrichmentConfig.max_calls_per_day,
				window: enrichmentConfig.quota_window,
			},
		});

		if (!result.started) {
			return [
				'Skill consolidation did not run.',
				'',
				`Reason: ${result.reason ?? 'not scheduled'}`,
				`State: ${result.statePath}`,
			].join('\n');
		}

		return buildConsolidateSummary(
			result.result,
			result.statePath,
			skillConfig.max_calls_per_day,
		);
	} catch (err) {
		return [
			'Skill consolidation encountered an error.',
			'',
			`Error: ${err instanceof Error ? err.message : String(err)}`,
		].join('\n');
	}
}

export const _internals = {
	handleConsolidateCommand,
};

/** Pure-function seam for tests (writing-tests SKILL.md, Tier 0). */
export const _test_exports = { buildConsolidateSummary };
