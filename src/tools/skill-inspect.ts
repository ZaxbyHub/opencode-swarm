/**
 * skill_inspect — Print a generated skill (active or draft) with its source
 * knowledge IDs.
 */

import { z } from 'zod';
import { inspectSkill } from '../services/skill-generator.js';
import { createSwarmTool } from './create-tool.js';

export const skill_inspect: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Read a generated skill (active or draft) and return its full markdown body and metadata.',
		args: {
			slug: z.string().min(1).describe('Slug of the skill to inspect.'),
			prefer: z.enum(['auto', 'proposal', 'active']).optional().default('auto'),
		},
		execute: async (args: unknown, directory): Promise<string> => {
			const a = (args ?? {}) as {
				slug?: string;
				prefer?: 'auto' | 'proposal' | 'active';
			};
			if (!a.slug || typeof a.slug !== 'string') {
				return JSON.stringify({ found: false, reason: 'slug required' });
			}
			const result = await inspectSkill(directory, a.slug, a.prefer ?? 'auto');
			return JSON.stringify(result, null, 2);
		},
	});

export const _internals: { skill_inspect: typeof skill_inspect } = {
	skill_inspect,
};
