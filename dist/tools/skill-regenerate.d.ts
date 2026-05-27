/**
 * skill_regenerate — Regenerate an active skill by re-clustering its source
 * knowledge entries and updating the SKILL.md in place.
 *
 * Reads the existing SKILL.md frontmatter to identify source knowledge IDs,
 * resolves current entries from knowledge stores, re-clusters them, and writes
 * an updated SKILL.md. If source IDs yield no matches, falls back to
 * re-clustering from scratch using the slug as a keyword hint.
 */
import { createSwarmTool } from './create-tool.js';
export declare const skill_regenerate: ReturnType<typeof createSwarmTool>;
export declare const _internals: {
    skill_regenerate: typeof skill_regenerate;
};
