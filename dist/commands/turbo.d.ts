import { loadPluginConfigWithMeta } from '../config';
/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.loadPluginConfigWithMeta(...)` so tests can replace the function
 * on this object without using `mock.module` from `bun:test`, which leaks
 * across files in Bun's shared test-runner process (AGENTS.md §7).
 * Mutating this local object is file-scoped and trivially restorable via afterEach.
 */
export declare const _internals: {
    loadPluginConfigWithMeta: typeof loadPluginConfigWithMeta;
};
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
