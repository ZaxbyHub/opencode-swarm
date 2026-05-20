/**
 * Knowledge-to-skill compiler.
 *
 * Selects mature, high-confidence knowledge entries (with optional actionable
 * directive metadata), clusters them, and emits SKILL.md files either as draft
 * proposals (.swarm/skills/proposals/<slug>.md) or active generated skills
 * (.opencode/skills/generated/<slug>/SKILL.md).
 *
 * Safety:
 *   - slug sanitizer rejects path traversal / control chars / absolute paths
 *   - active mode never overwrites a manually edited skill unless force=true
 *   - generated files always carry an explicit "<!-- generated -->" header
 *   - file writes are atomic (write to .tmp, rename)
 */
import type { KnowledgeEntryBase } from '../hooks/knowledge-types.js';
export declare function sanitizeSlug(input: string): string;
export declare function isValidSlug(slug: string): boolean;
export declare function proposalPath(directory: string, slug: string): string;
export declare function activePath(directory: string, slug: string): string;
/** Repo-relative path used inside SKILLS: file: references and entry metadata. */
export declare function activeRepoRelativePath(slug: string): string;
export interface CandidateSelectionOptions {
    minConfidence: number;
    minConfirmations: number;
}
export interface KnowledgeCluster {
    slug: string;
    title: string;
    entries: KnowledgeEntryBase[];
    triggers: string[];
    required_actions: string[];
    forbidden_actions: string[];
    target_agents: string[];
    verification_checks: string[];
    avgConfidence: number;
}
export declare function selectCandidateEntries(directory: string, opts: CandidateSelectionOptions): Promise<KnowledgeEntryBase[]>;
export declare function clusterEntries(entries: KnowledgeEntryBase[]): KnowledgeCluster[];
export declare function renderSkillMarkdown(cluster: KnowledgeCluster, mode?: GenerateMode): string;
export type GenerateMode = 'draft' | 'active';
export interface GenerateRequest {
    directory: string;
    mode: GenerateMode;
    slug?: string;
    sourceKnowledgeIds?: string[];
    force?: boolean;
    minConfidence?: number;
    minConfirmations?: number;
}
export interface GenerateResult {
    written: Array<{
        slug: string;
        path: string;
        mode: GenerateMode;
        sourceKnowledgeIds: string[];
        preserved: boolean;
    }>;
    skipped: Array<{
        slug: string;
        reason: string;
    }>;
}
export declare function generateSkills(req: GenerateRequest): Promise<GenerateResult>;
/**
 * Stamp source knowledge entries with `generated_skill_slug` and
 * `generated_skill_path` metadata. Refactored in Phase G′ to take
 * `(directory, slug, ids)` so it can be called both from direct active-mode
 * generation AND from `activateProposal` after parsing the draft frontmatter.
 */
declare function stampSourceEntries(directory: string, slug: string, ids: string[]): Promise<void>;
/**
 * Bounded YAML frontmatter parser for generated drafts. Recognises the exact
 * shape we emit in renderSkillMarkdown — no full YAML lib required.
 *
 * Returns null when the document does not begin with a `---` frontmatter
 * fence or the closing fence is missing.
 */
export declare function parseDraftFrontmatter(content: string): {
    name?: string;
    status?: string;
    sourceKnowledgeIds: string[];
} | null;
export declare function activateProposal(directory: string, slug: string, force?: boolean): Promise<{
    activated: boolean;
    from: string;
    to: string;
    reason?: string;
    stamped?: boolean;
    stampedIds?: string[];
}>;
export declare function listSkills(directory: string): Promise<{
    proposals: Array<{
        slug: string;
        path: string;
    }>;
    active: Array<{
        slug: string;
        path: string;
    }>;
}>;
export declare function inspectSkill(directory: string, slug: string, prefer?: 'auto' | 'proposal' | 'active'): Promise<{
    found: boolean;
    path?: string;
    content?: string;
    mode?: GenerateMode;
}>;
export declare const _internals: {
    sanitizeSlug: typeof sanitizeSlug;
    isValidSlug: typeof isValidSlug;
    selectCandidateEntries: typeof selectCandidateEntries;
    clusterEntries: typeof clusterEntries;
    renderSkillMarkdown: typeof renderSkillMarkdown;
    generateSkills: typeof generateSkills;
    activateProposal: typeof activateProposal;
    listSkills: typeof listSkills;
    inspectSkill: typeof inspectSkill;
    stampSourceEntries: typeof stampSourceEntries;
    parseDraftFrontmatter: typeof parseDraftFrontmatter;
};
export {};
