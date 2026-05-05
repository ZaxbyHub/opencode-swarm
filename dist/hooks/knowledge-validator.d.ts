/** Three-layer validation gate for the opencode-swarm v6.17 knowledge system. */
import type { KnowledgeCategory, KnowledgeEntryBase } from './knowledge-types.js';
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
