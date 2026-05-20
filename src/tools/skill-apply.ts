/**
 * skill_apply — Activate a draft proposal into the active generated skills tree.
 *
 * Refuses to overwrite an active SKILL.md that lacks the generator stamp
 * (i.e., one a human has authored or edited) unless force=true is passed.
 */

import { z } from 'zod';
import { activateProposal } from '../services/skill-generator.js';
import { createSwarmTool } from './create-tool.js';

export const skill_apply: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'Activate a draft skill proposal (.swarm/skills/proposals/<slug>.md) into .opencode/skills/generated/<slug>/SKILL.md.',
	args: {
		slug: z.string().min(1).describe('Slug of the proposal to activate.'),
		force: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				'Overwrite an existing active SKILL.md even if it lacks the generator stamp. Default false.',
			),
	},
	execute: async (args: unknown, directory): Promise<string> => {
		const a = (args ?? {}) as { slug?: string; force?: boolean };
		if (!a.slug || typeof a.slug !== 'string') {
			return JSON.stringify({ activated: false, reason: 'slug required' });
		}
		const result = await activateProposal(directory, a.slug, a.force ?? false);
		return JSON.stringify(result, null, 2);
	},
});

export const _internals: { skill_apply: typeof skill_apply } = { skill_apply };
