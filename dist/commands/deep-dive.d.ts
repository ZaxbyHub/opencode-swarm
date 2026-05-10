/**
 * Handle /swarm deep-dive command.
 * Sanitizes scope input, parses flags, and emits a DEEP_DIVE mode signal.
 */
export declare function handleDeepDiveCommand(_directory: string, args: string[]): Promise<string>;
