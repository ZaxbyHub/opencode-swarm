/**
 * Knowledge application tracking — distinguishes shown / acknowledged / applied
 * / ignored / violated outcomes for injected knowledge directives.
 *
 * Writes one JSONL line per outcome to `.swarm/knowledge-application.jsonl`,
 * and updates per-entry retrieval-outcome counters on the source knowledge file.
 */
import type { KnowledgeApplicationResult } from './knowledge-types.js';
export declare function resolveApplicationLogPath(directory: string): string;
/**
 * Parse explicit knowledge-acknowledgment markers from architect text.
 * Recognised forms (case-insensitive, line-anchored or inline):
 *   KNOWLEDGE_APPLIED: <id>
 *   KNOWLEDGE_IGNORED: <id> reason=<reason>
 *   KNOWLEDGE_VIOLATED: <id> reason=<reason>
 */
export interface ParsedAcknowledgment {
    id: string;
    result: 'applied' | 'ignored' | 'violated';
    reason?: string;
}
export declare function parseAcknowledgments(text: string): ParsedAcknowledgment[];
export interface RecordContext {
    phase?: string;
    taskId?: string;
    action?: string;
    tool?: string;
    targetAgent?: string;
    sessionId?: string;
}
/** Record one or more knowledge IDs as "shown" (injected into context). */
export declare function recordKnowledgeShown(directory: string, ids: string[], ctx: RecordContext): Promise<void>;
/** Record an explicit acknowledgment outcome (applied / ignored / violated).
 *  Per-(sessionId, knowledgeId, result, dayKey) dedup is enforced by the
 *  caller via swarmState.knowledgeAckDedup; this fn always records when
 *  invoked, so test code can trigger duplicates if needed. The runtime
 *  integration in src/index.ts uses recordAcknowledgmentDeduped instead. */
export declare function recordAcknowledgment(directory: string, ack: ParsedAcknowledgment, ctx: RecordContext): Promise<void>;
/** Build the dedup key. Exported so test code and the runtime integration
 *  share the exact format. */
export declare function buildAckDedupKey(sessionId: string, id: string, result: KnowledgeApplicationResult, now?: Date): string;
/** Acknowledgment recording with dedup. Returns whether a record was actually
 *  written (false on dedup hit). dedupSet should be swarmState.knowledgeAckDedup
 *  in production; tests can pass a fresh Set. */
export declare function recordAcknowledgmentDeduped(directory: string, ack: ParsedAcknowledgment, ctx: RecordContext, dedupSet: Set<string>, now?: Date): Promise<boolean>;
/**
 * Process a chunk of architect text: extract any KNOWLEDGE_* markers and record
 * each as an outcome. Returns the parsed list (empty if none).
 */
export declare function processArchitectText(directory: string, text: string, ctx: RecordContext): Promise<ParsedAcknowledgment[]>;
export interface ShownNotAppliedQuery {
    taskId?: string;
    phase?: string;
    knowledgeIds: string[];
}
/**
 * Returns the subset of `knowledgeIds` that have at least one "shown" record
 * in the audit log without a subsequent "applied"/"ignored"/"violated" record
 * in the same task or phase scope.
 */
export declare function getShownButNotAcknowledged(directory: string, q: ShownNotAppliedQuery): Promise<string[]>;
export interface KnowledgeApplicationConfig {
    enabled: boolean;
    mode: 'warn' | 'enforce';
    min_confidence: number;
    critical_requires_ack: boolean;
    require_skill_refs: boolean;
}
export declare const DEFAULT_KNOWLEDGE_APPLICATION_CONFIG: KnowledgeApplicationConfig;
export interface GateResult {
    allowed: boolean;
    mode: 'warn' | 'enforce';
    violations: Array<{
        id: string;
        reason: string;
    }>;
    warnings: Array<{
        id: string;
        reason: string;
    }>;
}
/**
 * Enforce the knowledge-application contract before a high-risk action.
 * In 'warn' mode: never blocks; returns { allowed: true } with warnings.
 * In 'enforce' mode: returns { allowed: false } if any critical+matching
 * directive is in `criticalShownIds` and not present in `recentArchitectText`.
 */
export declare function gateKnowledgeApplication(args: {
    criticalShownIds: string[];
    recentArchitectText: string;
    config: KnowledgeApplicationConfig;
}): GateResult;
export declare const _internals: {
    parseAcknowledgments: typeof parseAcknowledgments;
    recordKnowledgeShown: typeof recordKnowledgeShown;
    recordAcknowledgment: typeof recordAcknowledgment;
    recordAcknowledgmentDeduped: typeof recordAcknowledgmentDeduped;
    processArchitectText: typeof processArchitectText;
    getShownButNotAcknowledged: typeof getShownButNotAcknowledged;
    gateKnowledgeApplication: typeof gateKnowledgeApplication;
    resolveApplicationLogPath: typeof resolveApplicationLogPath;
    buildAckDedupKey: typeof buildAckDedupKey;
};
