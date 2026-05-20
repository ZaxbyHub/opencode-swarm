/**
 * Handles /swarm knowledge quarantine <id> [reason] command.
 * Moves a knowledge entry to quarantine with optional reason.
 * Accepts a full ID or a unique prefix.
 */
export declare function handleKnowledgeQuarantineCommand(directory: string, args: string[]): Promise<string>;
/**
 * Handles /swarm knowledge restore <id> command.
 * Restores a quarantined knowledge entry.
 * Accepts a full ID or a unique prefix.
 */
export declare function handleKnowledgeRestoreCommand(directory: string, args: string[]): Promise<string>;
/**
 * Handles /swarm knowledge migrate [directory] command.
 * Triggers one-time migration from .swarm/context.md to .swarm/knowledge.jsonl.
 */
export declare function handleKnowledgeMigrateCommand(directory: string, args: string[]): Promise<string>;
/**
 * Handles /swarm knowledge command (no subcommand) - lists knowledge entries.
 * Lists entries from .swarm/knowledge.jsonl with id, category, confidence, truncated text.
 */
export declare function handleKnowledgeListCommand(directory: string, _args: string[]): Promise<string>;
