/**
 * skill_improve — Run the skill_improver agent / service under daily quota.
 *
 * Default write_mode is 'proposal' — writes only to
 * .swarm/skill-improver/proposals/<ts>.md and never mutates source code.
 * 'draft_skills' mode additionally calls skill_generate (draft mode) for
 * mature, un-compiled clusters.
 *
 * Closes issue #629: lets users wire an expensive OpenRouter model and cap
 * its usage to e.g. 10 calls/day.
 */

import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../config';
import {
	KnowledgeConfigSchema,
	SkillImproverConfigSchema,
} from '../config/schema';
import {
	buildHumanApprovedWriteAuthority,
	consumeWriteApprovalFact,
	formatApproveWriteCommand,
	withWriteAuthority,
} from '../security/write-authority.js';
import {
	prepareApprovedSkillImproverCandidateWrite,
	runSkillImprover,
	writeApprovedSkillImproverCandidate,
} from '../services/skill-improver.js';
import { createSwarmTool } from './create-tool.js';

const writeAuthorityDependencies = {
	buildHumanApprovedWriteAuthority,
	consumeWriteApprovalFact,
	formatApproveWriteCommand,
	withWriteAuthority,
};

export const skill_improve: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Run the skill_improver capability under daily quota. Writes a proposal under .swarm/skill-improver/proposals/<timestamp>.md. With mode="draft_skills" it also drafts SKILL.md proposals for mature clusters. Quota is enforced via .swarm/skill-improver-quota.json.',
		args: {
			targets: z
				.array(z.enum(['skills', 'spec', 'architect_prompt', 'knowledge']))
				.optional(),
			mode: z.enum(['proposal', 'draft_skills']).optional(),
			max_calls: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe(
					'Override the per-run reservation count (capped by daily max).',
				),
			evaluate: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					'When mode="draft_skills", validate generated draft skills before writing proposals. Default false.',
				),
			approved_candidate_content: z
				.string()
				.max(64_000)
				.optional()
				.describe(
					'Exact approval candidate returned by a prior challenge. When provided, skill_improve writes this approved proposal or draft manifest verbatim instead of regenerating it.',
				),
		},
		execute: async (args: unknown, directory, ctx): Promise<string> => {
			const a = (args ?? {}) as {
				targets?: Array<'skills' | 'spec' | 'architect_prompt' | 'knowledge'>;
				mode?: 'proposal' | 'draft_skills';
				max_calls?: number;
				evaluate?: boolean;
				approved_candidate_content?: string;
			};
			const { config } = loadPluginConfigWithMeta(directory);
			const parsed = SkillImproverConfigSchema.parse(
				config.skill_improver ?? {},
			);
			const knowledgeConfig = KnowledgeConfigSchema.parse(
				config.knowledge ?? {},
			);
			const enrichmentConfig = knowledgeConfig.enrichment ?? {
				max_calls_per_day: 30,
				quota_window: 'utc' as const,
			};
			if (!parsed.enabled) {
				return JSON.stringify(
					{
						ran: false,
						reason:
							'skill_improver is disabled. Set "skill_improver.enabled": true in opencode-swarm config to use this tool.',
					},
					null,
					2,
				);
			}
			const request = {
				directory,
				config: parsed,
				targets: a.targets,
				mode: a.mode,
				maxCalls: a.max_calls,
				sessionId: ctx?.sessionID,
				enrichmentQuota: {
					maxCalls: enrichmentConfig.max_calls_per_day,
					window: enrichmentConfig.quota_window,
				},
				evaluateDrafts: a.evaluate ?? false,
				approvedCandidateContent: a.approved_candidate_content,
			} as const;
			if (parsed.require_user_approval) {
				if (a.approved_candidate_content) {
					const prepared =
						await prepareApprovedSkillImproverCandidateWrite(request);
					if (prepared.kind === 'result') {
						return JSON.stringify(prepared.result, null, 2);
					}
					const fact =
						await writeAuthorityDependencies.consumeWriteApprovalFact({
							directory,
							request: prepared.prepared.request,
						});
					if (!fact) {
						return JSON.stringify(
							{
								ran: false,
								reason: 'skill_improver requires an exact human write approval',
								approvalRequired: {
									request: prepared.prepared.request,
									command: writeAuthorityDependencies.formatApproveWriteCommand(
										prepared.prepared.request,
									),
									candidateContent: prepared.prepared.candidateContent,
									candidateContentChars:
										prepared.prepared.candidateContent.length,
									candidateContentTokenEstimate: Math.max(
										1,
										Math.ceil(prepared.prepared.candidateContent.length / 4),
									),
									allowedPaths: prepared.prepared.allowedPaths,
								},
								quota: prepared.prepared.quota,
								source: prepared.prepared.source,
								model: prepared.prepared.model,
							},
							null,
							2,
						);
					}
					const result = await writeAuthorityDependencies.withWriteAuthority(
						writeAuthorityDependencies.buildHumanApprovedWriteAuthority(fact),
						() => writeApprovedSkillImproverCandidate(prepared.prepared),
					);
					return JSON.stringify(result, null, 2);
				}
				const result = await runSkillImprover({
					...request,
					allowAutoApply: false,
				});
				if (result.approvalRequired?.request) {
					return JSON.stringify(
						{
							...result,
							approvalRequired: {
								...result.approvalRequired,
								command: writeAuthorityDependencies.formatApproveWriteCommand(
									result.approvalRequired.request,
								),
							},
						},
						null,
						2,
					);
				}
				return JSON.stringify(result, null, 2);
			}
			const result = await runSkillImprover(request);
			return JSON.stringify(result, null, 2);
		},
	});

export const _internals: {
	skill_improve: typeof skill_improve;
	writeAuthorityDependencies: typeof writeAuthorityDependencies;
} = {
	skill_improve,
	writeAuthorityDependencies,
};
