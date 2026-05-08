/**
 * Curator analyze tool — explicit mechanism to trigger curator phase analysis
 * and apply knowledge recommendations. Closes the curator data pipeline by
 * giving the architect an explicit tool to call after reviewing phase data.
 */

import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import { CuratorConfigSchema, KnowledgeConfigSchema } from '../config/schema';
import {
	applyCuratorKnowledgeUpdates,
	runCuratorPhase,
} from '../hooks/curator';
import { createCuratorLLMDelegate } from '../hooks/curator-llm-factory.js';
import type { KnowledgeRecommendation } from '../hooks/curator-types.js';
import {
	buildApprovedReceipt,
	buildRejectedReceipt,
	persistReviewReceipt,
} from '../hooks/review-receipt.js';
import { createSwarmTool } from './create-tool';

export const curator_analyze: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Run curator phase analysis and optionally apply knowledge recommendations. ' +
			'Call this after reviewing a phase to apply knowledge updates. ' +
			'If recommendations is provided, applies them via applyCuratorKnowledgeUpdates.',
		args: {
			phase: z.number().int().min(1).describe('Phase number to analyze'),
			recommendations: z
				.array(
					z.object({
						action: z.enum([
							'promote',
							'archive',
							'flag_contradiction',
							'rewrite',
						]),
						entry_id: z.string().optional(),
						lesson: z.string(),
						reason: z.string(),
						category: z
							.enum([
								'process',
								'architecture',
								'tooling',
								'security',
								'testing',
								'debugging',
								'performance',
								'integration',
								'other',
							])
							.optional(),
						confidence: z.number().min(0).max(1).optional(),
					}),
				)
				.optional()
				.describe(
					'Knowledge recommendations to apply. If omitted, only collects digest data.',
				),
		},
		execute: async (
			args: unknown,
			directory: string,
			ctx?: ToolContext,
		): Promise<string> => {
			const typedArgs = args as {
				phase: number;
				recommendations?: KnowledgeRecommendation[];
			};

			try {
				// Validate phase
				if (!Number.isInteger(typedArgs.phase) || typedArgs.phase < 1) {
					return JSON.stringify(
						{ error: 'phase must be a positive integer >= 1' },
						null,
						2,
					);
				}

				// Validate recommendations actions if provided
				if (typedArgs.recommendations) {
					const validActions = [
						'promote',
						'archive',
						'flag_contradiction',
						'rewrite',
					];
					for (const rec of typedArgs.recommendations) {
						if (!validActions.includes(rec.action)) {
							return JSON.stringify(
								{
									error: `Invalid recommendation action: ${rec.action}`,
								},
								null,
								2,
							);
						}
					}
				}

				// Validate entry_id values: undefined is allowed (new entry), a valid UUID v4 is
				// allowed (update existing), any other non-empty string is a caller error.
				if (typedArgs.recommendations) {
					const UUID_V4 =
						/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
					for (const rec of typedArgs.recommendations) {
						if (rec.entry_id !== undefined && !UUID_V4.test(rec.entry_id)) {
							return JSON.stringify(
								{
									error:
										`Invalid entry_id '${rec.entry_id}': must be a UUID v4 or omitted. ` +
										`Use undefined/omit entry_id to create a new entry.`,
								},
								null,
								2,
							);
						}
					}
				}

				const { config } = loadPluginConfigWithMeta(directory);
				const curatorConfig = CuratorConfigSchema.parse(config.curator ?? {});
				const knowledgeConfig = KnowledgeConfigSchema.parse(
					config.knowledge ?? {},
				);

				// Run the curator phase analysis (collects digest + compliance)
				const llmDelegate = createCuratorLLMDelegate(
					directory,
					'phase',
					ctx?.sessionID,
				);
				const curatorResult = await runCuratorPhase(
					directory,
					typedArgs.phase,
					[], // agentsDispatched — empty for on-demand analysis
					curatorConfig,
					{},
					llmDelegate,
				);

				// Persist review receipt for drift tracking (best-effort)
				{
					const scopeContent =
						curatorResult.digest?.summary ??
						`Phase ${typedArgs.phase} curator analysis`;
					const complianceWarnings = curatorResult.compliance.filter(
						(c) => c.severity === 'warning',
					);
					const receipt =
						complianceWarnings.length > 0
							? buildRejectedReceipt({
									agent: 'curator',
									scopeContent,
									scopeDescription: 'phase-digest',
									blockingFindings: complianceWarnings.map((c) => ({
										location: `phase-${c.phase}`,
										summary: c.description,
										severity:
											c.type === 'missing_reviewer'
												? ('high' as const)
												: ('medium' as const),
									})),
									evidenceReferences: [],
									passConditions: [
										'resolve all compliance warnings before phase completion',
									],
								})
							: buildApprovedReceipt({
									agent: 'curator',
									scopeContent,
									scopeDescription: 'phase-digest',
									checkedAspects: [
										'phase_compliance',
										'knowledge_recommendations',
										'phase_digest',
									],
									validatedClaims: [
										`phase: ${typedArgs.phase}`,
										`knowledge_recommendations: ${curatorResult.knowledge_recommendations.length}`,
									],
								});
					persistReviewReceipt(directory, receipt).catch(() => {});
				}

				let applied = 0;
				let skipped = 0;

				// Apply recommendations if provided.
				// entry_id values are pre-validated in the early-validation block above:
				// undefined → new entry, valid UUID v4 → update existing.
				if (typedArgs.recommendations && typedArgs.recommendations.length > 0) {
					const result = await applyCuratorKnowledgeUpdates(
						directory,
						typedArgs.recommendations,
						knowledgeConfig,
					);
					applied = result.applied;
					skipped = result.skipped;
				}

				return JSON.stringify(
					{
						phase_digest: curatorResult.digest,
						compliance_count: curatorResult.compliance.length,
						applied,
						skipped,
					},
					null,
					2,
				);
			} catch (error) {
				return JSON.stringify(
					{
						error: error instanceof Error ? error.message : String(error),
						phase: typedArgs.phase,
					},
					null,
					2,
				);
			}
		},
	});
