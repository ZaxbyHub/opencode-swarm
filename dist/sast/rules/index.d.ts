/**
 * SAST Rule Engine - Main entry point
 * Provides rule registration, loading, and execution for static security analysis
 */
export interface SastRule {
    id: string;
    name: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    languages: string[];
    description: string;
    remediation?: string;
    query?: string;
    pattern?: RegExp;
    validate?: (match: SastMatch, context: SastContext) => boolean;
}
export interface SastMatch {
    text: string;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    captures?: Record<string, string>;
}
export interface SastContext {
    filePath: string;
    content: string;
    language: string;
    parser?: unknown;
    tree?: unknown;
}
export interface SastFinding {
    rule_id: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    message: string;
    location: {
        file: string;
        line: number;
        column?: number;
    };
    remediation?: string;
    excerpt?: string;
}
export declare const _internals: {
    getAllRules: typeof getAllRules;
    getRulesForLanguage: typeof getRulesForLanguage;
    getRuleById: typeof getRuleById;
    findPatternMatches: typeof findPatternMatches;
    executeRulesSync: typeof executeRulesSync;
    executeRules: typeof executeRules;
    getRuleStats: typeof getRuleStats;
};
/**
 * Get all registered rules
 */
export declare function getAllRules(): SastRule[];
/**
 * Get rules for a specific language
 */
export declare function getRulesForLanguage(language: string): SastRule[];
/**
 * Get rule by ID
 */
export declare function getRuleById(id: string): SastRule | undefined;
/**
 * Parse source code and extract matches for a given pattern
 */
declare function findPatternMatches(content: string, pattern: RegExp): SastMatch[];
/**
 * Execute rules synchronously (pattern matching only)
 * This is the primary execution method for offline SAST
 */
export declare function executeRulesSync(filePath: string, content: string, language: string): SastFinding[];
/**
 * Execute rules against a file (async version with tree-sitter support)
 * Falls back to pattern matching if tree-sitter is unavailable
 */
export declare function executeRules(filePath: string, content: string, language: string): Promise<SastFinding[]>;
/**
 * Get statistics about rules
 */
export declare function getRuleStats(): {
    total: number;
    bySeverity: Record<string, number>;
    byLanguage: Record<string, number>;
};
export {};
