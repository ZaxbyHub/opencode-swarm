/**
 * Handles the /swarm reset command.
 * Clears all swarm state files from .swarm/ and project root.
 * Stops background automation and resets in-memory queues.
 * Requires --confirm flag as a safety gate.
 */
export declare function handleResetCommand(directory: string, args: string[]): Promise<string>;
