/**
 * skill_list — List generator-emitted skill drafts and active SKILL.md files.
 */

import { listSkills } from '../services/skill-generator.js';
import { createSwarmTool } from './create-tool.js';

export const skill_list: ReturnType<typeof createSwarmTool> = createSwarmTool({
	description:
		'List generated skill drafts (under .swarm/skills/proposals) and active generated skills (under .opencode/skills/generated).',
	args: {},
	execute: async (_args, directory): Promise<string> => {
		const result = await listSkills(directory);
		return JSON.stringify(result, null, 2);
	},
});

export const _internals: { skill_list: typeof skill_list } = { skill_list };
