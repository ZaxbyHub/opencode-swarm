/**
 * skill_generate — Compile mature knowledge into a SKILL.md.
 *
 * Modes:
 *   - draft  → writes .swarm/skills/proposals/<slug>.md
 *   - active → writes .opencode/skills/generated/<slug>/SKILL.md and stamps
 *              source knowledge entries with generated_skill_path metadata.
 *
 * Refuses to overwrite a manually edited active SKILL.md unless force=true.
 * Slugs are sanitized; path traversal is rejected at the validator layer.
 */
import { createSwarmTool } from './create-tool.js';
export declare const skill_generate: ReturnType<typeof createSwarmTool>;
export declare const _internals: {
    skill_generate: typeof skill_generate;
};
