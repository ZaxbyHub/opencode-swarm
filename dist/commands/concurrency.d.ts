/**
 * Handles the /swarm concurrency command.
 * Supports setting, resetting, and checking concurrency override values.
 *
 * @param directory - Project directory (used to load plan execution_profile)
 * @param args - Optional arguments: "set" | "status" | "reset" with optional value
 * @param sessionID - Session ID for accessing active session state
 * @returns Feedback message about concurrency state
 */
export declare function handleConcurrencyCommand(directory: string, args: string[], sessionID: string): Promise<string>;
