/**
 * skill_regenerate — Regenerate an active skill by re-clustering its source
 * knowledge entries and updating the SKILL.md in place.
 *
 * Reads the existing SKILL.md frontmatter to identify source knowledge IDs,
 * resolves current entries from knowledge stores, re-clusters them, and writes
 * an updated SKILL.md. If source IDs yield no matches, falls back to
 * re-clustering from scratch using the slug as a keyword hint.
 */

import { z } from 'zod';
import { regenerateSkill } from '../services/skill-generator.js';
import { createSwarmTool } from './create-tool.js';

export const skill_regenerate: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Regenerate an active skill by re-clustering its source knowledge entries and updating the SKILL.md in place.',
		args: {
			slug: z
				.string()
				.min(1)
				.describe('Slug of the active skill to regenerate.'),
			evaluate: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					'Validate regenerated content against .swarm/skills/evals/<slug> before writing. Default false.',
				),
		},
		execute: async (args: unknown, directory): Promise<string> => {
			const a = (args ?? {}) as { slug?: string; evaluate?: boolean };
			if (!a.slug || typeof a.slug !== 'string') {
				return JSON.stringify({ regenerated: false, reason: 'slug required' });
			}
			const result = await regenerateSkill(directory, a.slug, {
				evaluate: a.evaluate ?? false,
			});
			return JSON.stringify(result, null, 2);
		},
	});

export const _internals: { skill_regenerate: typeof skill_regenerate } = {
	skill_regenerate,
};
