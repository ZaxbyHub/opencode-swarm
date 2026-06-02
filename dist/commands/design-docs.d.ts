/**
 * Handle /swarm design-docs command (issue #1080).
 * Sanitizes the description, parses flags, and emits a DESIGN_DOCS mode signal
 * that routes the architect into the design-doc generation/sync workflow.
 */
export declare function handleDesignDocsCommand(directory: string, args: string[]): Promise<string>;
