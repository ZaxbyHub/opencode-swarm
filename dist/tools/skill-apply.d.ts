/**
 * skill_apply — Activate a draft proposal into the active generated skills tree.
 *
 * Refuses to overwrite an active SKILL.md that lacks the generator stamp
 * (i.e., one a human has authored or edited) unless force=true is passed.
 */
import { createSwarmTool } from './create-tool.js';
export declare const skill_apply: ReturnType<typeof createSwarmTool>;
export declare const _internals: {
    skill_apply: typeof skill_apply;
};
