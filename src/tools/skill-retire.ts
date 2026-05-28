/**
 * skill_retire — Retire a generated skill by adding a retired.marker file.
 *
 * Retired skills are excluded from discovery, scoring, and agent injection.
 * The marker file approach preserves reversibility (unretire = delete marker).
 * The SKILL.md is NOT deleted on retirement.
 */

import { z } from 'zod';
import { retireSkill } from '../services/skill-generator.js';
import { createSwarmTool } from './create-tool.js';

export const skill_retire: ReturnType<typeof createSwarmTool> = createSwarmTool(
	{
		description:
			'Retire a generated skill by adding a retired.marker file. Retired skills are excluded from scoring and injection.',
		args: {
			slug: z.string().min(1).describe('Slug of the active skill to retire.'),
			reason: z.string().optional().describe('Optional reason for retirement.'),
		},
		execute: async (args: unknown, directory): Promise<string> => {
			const a = (args ?? {}) as { slug?: string; reason?: string };
			if (!a.slug || typeof a.slug !== 'string') {
				return JSON.stringify({ retired: false, reason: 'slug required' });
			}
			const result = await retireSkill(directory, a.slug, a.reason);
			return JSON.stringify(result, null, 2);
		},
	},
);

export const _internals: { skill_retire: typeof skill_retire } = {
	skill_retire,
};
