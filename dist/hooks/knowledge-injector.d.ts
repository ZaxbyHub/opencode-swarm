/** Phase-Start Knowledge Injection Hook for opencode-swarm v6.17.
 *
 * Injects relevant knowledge (from both swarm + hive tiers) into the architect's
 * context at phase start. Caches the injection text for re-injection after
 * compaction. Skips for non-architect agents. Appends rejected-pattern warnings
 * to prevent re-learning loops.
 */
import type { KnowledgeConfig, MessageWithParts } from './knowledge-types.js';
/**
 * Creates a knowledge injection hook that injects relevant knowledge into the
 * architect's message context at phase start. Supports caching for re-injection
 * after compaction. Cache is per-instance (bound to the returned hook closure),
 * ensuring no cross-test pollution in Bun's shared test-runner process.
 *
 * @param directory - The project directory containing .swarm/
 * @param config - Knowledge system configuration
 * @returns A hook function that injects knowledge into messages
 */
export declare function createKnowledgeInjectorHook(directory: string, config: KnowledgeConfig): (input: Record<string, never>, output: {
    messages?: MessageWithParts[];
}) => Promise<void>;
