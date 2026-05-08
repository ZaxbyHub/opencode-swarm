/** Three-layer validation gate for the opencode-swarm v6.17 knowledge system. */
import type { ActionableDirectiveFields, DirectivePriority, KnowledgeCategory, KnowledgeEntryBase } from './knowledge-types.js';
export interface ValidationResult {
    valid: boolean;
    layer: 1 | 2 | 3 | null;
    reason: string | null;
    severity: 'error' | 'warning' | null;
}
export declare const DANGEROUS_COMMAND_PATTERNS: RegExp[];
export declare const SECURITY_DEGRADING_PATTERNS: RegExp[];
export declare const INVISIBLE_FORMAT_CHARS: RegExp;
export declare const INJECTION_PATTERNS: RegExp[];
export declare function validateLesson(candidate: string, existingLessons: string[], meta: {
    category: KnowledgeCategory;
    scope: string;
    confidence: number;
}): ValidationResult;
/** Maximum chars allowed per trigger / required-action / forbidden-action string. */
export declare const ACTIONABLE_STRING_MAX = 200;
/** Maximum number of items in any actionable list (triggers, required_actions, etc.). */
export declare const ACTIONABLE_LIST_MAX = 20;
/** Generated skill paths must be repo-local under one of these prefixes. */
export declare const ALLOWED_SKILL_PATH_PREFIXES: string[];
export interface ActionableValidationResult {
    valid: boolean;
    errors: string[];
}
/** Validate a generated_skill_path: must be repo-local and under an allowed prefix. */
export declare function validateSkillPath(p: unknown): boolean;
/** Validate the optional ActionableDirectiveFields block on a knowledge entry. */
export declare function validateActionableFields(fields: ActionableDirectiveFields | undefined): ActionableValidationResult;
export type { ActionableDirectiveFields, DirectivePriority };
export interface QuarantinedEntry extends KnowledgeEntryBase {
    quarantine_reason: string;
    quarantined_at: string;
    reported_by: 'architect' | 'user' | 'auto';
}
export interface EntryHealthResult {
    healthy: boolean;
    concern?: string;
}
export declare function auditEntryHealth(entry: KnowledgeEntryBase): EntryHealthResult;
export declare function quarantineEntry(directory: string, entryId: string, reason: string, reportedBy: 'architect' | 'user' | 'auto'): Promise<void>;
export declare function restoreEntry(directory: string, entryId: string): Promise<void>;
export declare const _internals: {
    validateLesson: typeof validateLesson;
    auditEntryHealth: typeof auditEntryHealth;
    quarantineEntry: typeof quarantineEntry;
    restoreEntry: typeof restoreEntry;
};
