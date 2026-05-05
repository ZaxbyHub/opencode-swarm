import type { tool } from '@opencode-ai/plugin';
import type { SwarmKnowledgeEntry } from '../hooks/knowledge-types.js';
export interface CoChangeEntry {
    fileA: string;
    fileB: string;
    coChangeCount: number;
    npmi: number;
    lift: number;
    hasStaticEdge: boolean;
    totalCommits: number;
    commitsA: number;
    commitsB: number;
}
export interface DarkMatterOptions {
    minCommits?: number;
    minCoChanges?: number;
    npmiThreshold?: number;
    maxCommitsToAnalyze?: number;
}
/**
 * Parses git log to extract commit -> files mapping.
 * Returns empty Map on timeout or error.
 */
export declare function parseGitLog(directory: string, maxCommits: number): Promise<Map<string, Set<string>>>;
/**
 * Builds co-change matrix from commit -> files mapping.
 */
export declare function buildCoChangeMatrix(commitMap: Map<string, Set<string>>): Map<string, CoChangeEntry>;
/**
 * Detects static import edges between files.
 */
export declare function getStaticEdges(directory: string): Promise<Set<string>>;
/**
 * Main entry point: detects dark matter (hidden couplings).
 */
export declare function detectDarkMatter(directory: string, options?: DarkMatterOptions): Promise<CoChangeEntry[]>;
/**
 * Converts dark matter findings to knowledge entries.
 */
export declare function darkMatterToKnowledgeEntries(pairs: CoChangeEntry[], projectName: string): SwarmKnowledgeEntry[];
/**
 * Formats dark matter findings as markdown output.
 */
export declare function formatDarkMatterOutput(pairs: CoChangeEntry[]): string;
export declare const co_change_analyzer: ReturnType<typeof tool>;
/**
 * DI seam for testability. Contains all test-mocked exports.
 * Internal calls should use _internals.fn() instead of fn() directly.
 */
export declare const _internals: {
    parseGitLog: typeof parseGitLog;
    buildCoChangeMatrix: typeof buildCoChangeMatrix;
    getStaticEdges: typeof getStaticEdges;
    detectDarkMatter: typeof detectDarkMatter;
    darkMatterToKnowledgeEntries: typeof darkMatterToKnowledgeEntries;
    formatDarkMatterOutput: typeof formatDarkMatterOutput;
};
