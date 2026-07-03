/**
 * Handles the /swarm curate command.
 * Runs knowledge curation and hive promotion review on-demand.
 *
 * Usage:
 * - /swarm curate — Run curation on existing swarm entries
 *
 * Returns a summary with counts, or zero counts for empty-state.
 */

import { KnowledgeConfigSchema } from '../config/schema.js';
import { checkHivePromotions } from '../hooks/hive-promoter.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store.js';
import type {
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from '../hooks/knowledge-types.js';
import { readSwarmFileAsync } from '../hooks/utils.js';

export const _internals = {
	checkHivePromotions,
	readKnowledge,
	resolveSwarmKnowledgePath,
	readSwarmFileAsync,
	loadCuratorDeps: async () => {
		const [{ CuratorConfigSchema }, curator, { createCuratorLLMDelegate }] =
			await Promise.all([
				import('../config/schema.js'),
				import('../hooks/curator.js'),
				import('../hooks/curator-llm-factory.js'),
			]);
		return { CuratorConfigSchema, curator, createCuratorLLMDelegate };
	},
};

export interface CurationSummary {
	timestamp: string;
	new_promotions: number;
	encounters_incremented: number;
	advancements: number;
	total_hive_entries: number;
	knowledge_applied?: number;
	knowledge_skipped?: number;
	curator_phase?: number;
}

/**
 * Handles the /swarm curate command.
 * Runs hive promotion review on existing swarm entries.
 */
export async function handleCurateCommand(
	directory: string,
	_args: string[],
	options?: { sessionID?: string },
): Promise<string> {
	try {
		// Use default config for manual curation
		const config: KnowledgeConfig = KnowledgeConfigSchema.parse({});

		// Read existing swarm entries
		const swarmPath = _internals.resolveSwarmKnowledgePath(directory);
		const swarmEntries =
			(await _internals.readKnowledge<SwarmKnowledgeEntry>(swarmPath)) ?? [];

		const summary: CurationSummary = await _internals.checkHivePromotions(
			swarmEntries,
			config,
		);

		if (options?.sessionID) {
			let onDemandPhase = 1;
			try {
				const { CuratorConfigSchema, curator, createCuratorLLMDelegate } =
					await _internals.loadCuratorDeps();
				const curatorConfig = CuratorConfigSchema.parse({});
				const priorSummary = await _internals.readSwarmFileAsync(
					directory,
					'curator-summary.json',
				);
				if (priorSummary) {
					try {
						const parsed = JSON.parse(priorSummary) as {
							last_phase_covered?: unknown;
						};
						if (
							typeof parsed.last_phase_covered === 'number' &&
							Number.isFinite(parsed.last_phase_covered)
						) {
							onDemandPhase = Math.max(1, parsed.last_phase_covered + 1);
						}
					} catch {
						// Corrupt summary should not block manual curation.
					}
				}

				// F-004: clamp onDemandPhase to the plan's phase count so we
				// don't run a phantom digest for a non-existent phase.
				let planPhaseCount = Infinity;
				try {
					const planRaw = await _internals.readSwarmFileAsync(
						directory,
						'plan.json',
					);
					if (planRaw) {
						const plan = JSON.parse(planRaw) as { phases?: unknown[] };
						if (Array.isArray(plan.phases)) planPhaseCount = plan.phases.length;
					}
				} catch {
					// No plan or unreadable — leave unbounded.
				}

				if (planPhaseCount !== Infinity && onDemandPhase > planPhaseCount) {
					// All plan phases already covered — skip the on-demand phase pass.
					summary.knowledge_applied = 0;
					summary.knowledge_skipped = 0;
					summary.curator_phase = onDemandPhase;
				} else {
					const delegate = createCuratorLLMDelegate(
						directory,
						'phase',
						options.sessionID,
					);
					const curatorResult = await curator.runCuratorPhase(
						directory,
						onDemandPhase,
						['curator'],
						curatorConfig,
						{},
						delegate,
					);
					const applied = await curator.applyCuratorKnowledgeUpdates(
						directory,
						curatorResult.knowledge_recommendations,
						config,
					);
					summary.knowledge_applied = applied.applied;
					summary.knowledge_skipped = applied.skipped;
					summary.curator_phase = onDemandPhase;

					// F-002: re-check hive promotion after knowledge updates so
					// newly hive_eligible entries are considered in the same run
					// (mirrors executePostMortemActions).
					try {
						const updatedEntries =
							(await _internals.readKnowledge<SwarmKnowledgeEntry>(
								swarmPath,
							)) ?? [];
						const postUpdateHive = await _internals.checkHivePromotions(
							updatedEntries,
							config,
						);
						summary.new_promotions += postUpdateHive.new_promotions;
						summary.encounters_incremented +=
							postUpdateHive.encounters_incremented;
						summary.advancements += postUpdateHive.advancements;
						summary.total_hive_entries = postUpdateHive.total_hive_entries;
					} catch {
						// Hive re-check is advisory; do not fail the curation.
					}
				}
			} catch (err) {
				// F-005: surface the error so the user can distinguish
				// "nothing to curate" from "hard failure".
				summary.knowledge_applied = 0;
				summary.knowledge_skipped = 0;
				summary.curator_phase = onDemandPhase;
				const reason = err instanceof Error ? err.message : String(err);
				return `${formatCurationSummary(summary)}\n\n⚠️ On-demand curator phase skipped: ${reason}`;
			}
		}

		// Return human-readable summary
		// Zero counts indicate empty-state (nothing to promote)
		return formatCurationSummary(summary);
	} catch (error) {
		// Return clear user-facing error message
		if (error instanceof Error) {
			return `❌ Curation failed: ${error.message}`;
		}
		return `❌ Curation failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Format curation summary for human-readable output.
 * Always returns the same shape, with zero counts for empty-state.
 */
function formatCurationSummary(summary: CurationSummary): string {
	const lines = [
		`📚 Curation complete`,
		``,
		`New promotions: ${summary.new_promotions}`,
		`Encounters incremented: ${summary.encounters_incremented}`,
		`Advancements: ${summary.advancements}`,
		`Total hive entries: ${summary.total_hive_entries}`,
	];
	if (summary.knowledge_applied !== undefined) {
		lines.push(
			`Knowledge recommendations: ${summary.knowledge_applied} applied, ${summary.knowledge_skipped ?? 0} skipped`,
		);
	}
	if (summary.curator_phase !== undefined) {
		lines.push(`Curator digest phase: ${summary.curator_phase}`);
	}

	return lines.join('\n');
}
