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
import { SkillImproverConfigSchema } from '../config/schema';
import { runSkillImprover } from '../services/skill-improver.js';
import { createSwarmTool } from './create-tool.js';

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
		},
		execute: async (args: unknown, directory, ctx): Promise<string> => {
			const a = (args ?? {}) as {
				targets?: Array<'skills' | 'spec' | 'architect_prompt' | 'knowledge'>;
				mode?: 'proposal' | 'draft_skills';
				max_calls?: number;
			};
			const { config } = loadPluginConfigWithMeta(directory);
			const parsed = SkillImproverConfigSchema.parse(
				config.skill_improver ?? {},
			);
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
			const result = await runSkillImprover({
				directory,
				config: parsed,
				targets: a.targets,
				mode: a.mode,
				maxCalls: a.max_calls,
				sessionId: ctx?.sessionID,
			});
			return JSON.stringify(result, null, 2);
		},
	});

export const _internals: { skill_improve: typeof skill_improve } = {
	skill_improve,
};
