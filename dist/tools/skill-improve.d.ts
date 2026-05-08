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
import { createSwarmTool } from './create-tool.js';
export declare const skill_improve: ReturnType<typeof createSwarmTool>;
export declare const _internals: {
    skill_improve: typeof skill_improve;
};
