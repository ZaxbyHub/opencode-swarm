/**
 * Handles the /swarm turbo command.
 * Supports standard turbo toggle, lean turbo mode, and status reporting.
 *
 * @param directory - Project directory (used to persist Lean Turbo run state)
 * @param args - Optional arguments: "lean" | "standard" | "on" | "off" | "status" | undefined
 * @param sessionID - Session ID for accessing active session state
 * @returns Feedback message about Turbo Mode state
 */
export declare function handleTurboCommand(directory: string, args: string[], sessionID: string): Promise<string>;
