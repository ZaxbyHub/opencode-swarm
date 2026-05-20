/** Knowledge query tool for architect-level access to swarm and hive knowledge.
 * Provides filtered, formatted text output for knowledge retrieval.
 */
import type { tool } from '@opencode-ai/plugin';
import type { HiveKnowledgeEntry } from '../hooks/knowledge-types.js';
declare function formatHiveEntry(entry: HiveKnowledgeEntry): string;
export declare const knowledge_query: ReturnType<typeof tool>;
export declare const _test_exports: {
    formatHiveEntry: typeof formatHiveEntry;
};
export {};
