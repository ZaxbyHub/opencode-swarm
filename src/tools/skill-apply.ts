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
		evaluate: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				'Validate the proposal against .swarm/skills/evals/<slug> before activation. Default false.',
			),
		confirm_unevaluated: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				'Allow activation when evaluateSkillChange returns status "unevaluated" (no eval set exists). Default false — the activation is blocked with a surfaced reason so the caller can confirm. Generated skills auto-derive an eval stub from their source directives, so this only applies to non-directive skills with no stub.',
			),
	},
	execute: async (args: unknown, directory): Promise<string> => {
		const a = (args ?? {}) as {
			slug?: string;
			force?: boolean;
			evaluate?: boolean;
			confirm_unevaluated?: boolean;
		};
		if (!a.slug || typeof a.slug !== 'string') {
			return JSON.stringify({ activated: false, reason: 'slug required' });
		}
		const result = await activateProposal(directory, a.slug, a.force ?? false, {
			evaluate: a.evaluate ?? false,
			// G8 (issue #1717): surface-and-confirm gate — interactive tool
			// defaults to false so unevaluated activation requires explicit opt-in.
			confirmUnevaluated: a.confirm_unevaluated ?? false,
		});
		return JSON.stringify(result, null, 2);
	},
});

export const _internals: { skill_apply: typeof skill_apply } = { skill_apply };
