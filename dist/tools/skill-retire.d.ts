/**
 * skill_retire — Retire a generated skill by adding a retired.marker file.
 *
 * Retired skills are excluded from discovery, scoring, and agent injection.
 * The marker file approach preserves reversibility (unretire = delete marker).
 * The SKILL.md is NOT deleted on retirement.
 */
import { createSwarmTool } from './create-tool.js';
export declare const skill_retire: ReturnType<typeof createSwarmTool>;
export declare const _internals: {
    skill_retire: typeof skill_retire;
};
