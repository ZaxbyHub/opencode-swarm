import { loadPluginConfigWithMeta } from '../config';
import {
	KnowledgeConfigSchema,
	SkillImproverConfigSchema,
} from '../config/schema';
import { runSkillConsolidation } from '../services/skill-consolidation.js';

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

		const improver = result.result;
		const lines = [
			'Skill consolidation complete.',
			'',
			`Source: ${improver?.source ?? 'unknown'}`,
			`Proposal: ${improver?.proposalPath ?? '(none)'}`,
			`Quota: ${improver?.quota.calls_used ?? 0}/${improver?.quota.max_calls ?? skillConfig.max_calls_per_day}`,
			`State: ${result.statePath}`,
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
		lines.push('', 'No skills were auto-activated.');
		return lines.join('\n');
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
