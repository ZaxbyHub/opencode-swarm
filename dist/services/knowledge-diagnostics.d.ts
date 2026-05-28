/**
 * Knowledge-system diagnostics: a reusable debug-metadata helper that any
 * knowledge tool can surface, plus a `/swarm diagnose` health summary.
 *
 * Path/version drift is a documented diagnostic concern (a stale plugin cache or
 * a mismatched resolved directory can make the knowledge store look broken).
 * This module reports the exact resolved paths, raw-vs-normalized entry counts,
 * status breakdown, event volume, and cache freshness so those issues surface.
 */
export interface KnowledgeDebugMeta {
    plugin_version: string;
    directory: string;
    swarm_path: string;
    hive_path: string;
    events_path: string;
    raw_entry_count: number;
    normalized_entry_count: number;
    corrupt_line_count: number;
    schema_versions: Record<string, number>;
    entries_missing_v2_counters: number;
    status_breakdown: {
        active: number;
        archived: number;
        quarantined: number;
        rejected: number;
    };
    event_count: number;
    retrieval_events_7d: number;
    cache_status: 'fresh' | 'stale' | 'unknown';
}
/**
 * Compute the debug-metadata block for the knowledge system. Best-effort: never
 * throws (each I/O step degrades to zero/empty). Aggregates swarm + hive tiers.
 */
export declare function computeKnowledgeDebug(directory: string): Promise<KnowledgeDebugMeta>;
export interface KnowledgeHealth {
    name: string;
    status: '✅' | '❌' | '⚠️' | '⬜';
    detail: string;
}
/**
 * Build the "Knowledge health" diagnose check from the debug metadata. Warns on
 * raw-vs-normalized mismatch (corrupt lines), entries missing v2 counters, or a
 * stale plugin cache; otherwise reports a healthy summary.
 */
export declare function checkKnowledgeHealth(directory: string): Promise<KnowledgeHealth>;
