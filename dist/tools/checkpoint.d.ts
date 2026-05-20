import type { ToolDefinition } from '@opencode-ai/plugin/tool';
/**
 * Record a checkpoint without staging or committing changes.
 * Writes only to .swarm/checkpoints.json with the current HEAD SHA.
 * Used by spiral detection to avoid silently committing mid-flight user work.
 */
export declare function saveCheckpointRecord(label: string, directory: string): {
    success: boolean;
    sha?: string;
    error?: string;
};
export declare const checkpoint: ToolDefinition;
