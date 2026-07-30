/**
 * Stored Input Args Helpers
 *
 * Extracted from guardrails.ts. Provides module-level storage for tool
 * input args by callID, used by guardrails for delegation detection
 * and exposed via safe accessor helpers.
 */

/**
 * v6.12: Module-level storage for tool input args by callID.
 * Used by guardrails for delegation detection, exposed via safe accessor helpers.
 *
 * Keyed by callID (one entry per tool call), so this map grows with the number
 * of in-flight/un-retrieved tool calls. It is FIFO-capped at
 * MAX_STORED_INPUT_ARGS (invariant 8) to bound memory for process lifetime.
 * Entries are normally cleaned up via deleteStoredInputArgs after retrieval, but
 * a lost-after (e.g. a toolBefore that never pairs with a toolAfter) would
 * otherwise leak forever.
 */
const storedInputArgs = new Map<string, unknown>();

/**
 * Max stored callID->args entries before the oldest-inserted is evicted
 * (invariant 8). Larger than the per-session cap because callIDs are per
 * tool-call, not per-session.
 */
export const MAX_STORED_INPUT_ARGS = 2000;

/**
 * Retrieves stored input args for a given callID.
 * Used by other hooks (e.g., delegation-gate) to access tool input args.
 * @param callID The callID to look up
 * @returns The stored args or undefined if not found
 */
export function getStoredInputArgs(callID: string): unknown | undefined {
	return storedInputArgs.get(callID);
}

/**
 * Stores input args for a given callID.
 * Used by guardrails toolBefore hook; may be used by other hooks if needed.
 * @param callID The callID to store args under
 * @param args The tool input args to store
 */
export function setStoredInputArgs(callID: string, args: unknown): void {
	storedInputArgs.set(callID, args);
	// FIFO-cap the callID count (invariant 8): evict oldest-inserted callID to
	// bound memory. Map preserves insertion order, so the first key is the
	// oldest. Skip self-eviction of the key just set.
	while (storedInputArgs.size > MAX_STORED_INPUT_ARGS) {
		const oldest = storedInputArgs.keys().next().value;
		if (oldest === undefined || oldest === callID) break;
		storedInputArgs.delete(oldest);
	}
}

/**
 * Deletes stored input args for a given callID (cleanup after retrieval).
 * @param callID The callID to delete
 */
export function deleteStoredInputArgs(callID: string): void {
	storedInputArgs.delete(callID);
}
