/**
 * Bounded buffer for deferred non-critical init warnings.
 * Populated during plugin startup when quiet:true; replayed in /swarm diagnose.
 * Extracted from index.ts so agents/index.ts and diagnose-service.ts can
 * share the buffer without creating a circular dependency.
 * Max 50 entries to prevent memory growth.
 * Access is restricted via getter to prevent unauthorized mutation.
 */
const deferredWarnings: string[] = [];
const MAX_DEFERRED_WARNINGS = 50;

export function addDeferredWarning(warning: string): void {
	if (deferredWarnings.length < MAX_DEFERRED_WARNINGS) {
		deferredWarnings.push(warning);
	}
}

/**
 * Returns a shallow copy of the current deferred warnings. The copy is
 * safe to read but cannot mutate the internal buffer. Use
 * addDeferredWarning() to add entries.
 */
export function getDeferredWarnings(): readonly string[] {
	// Return a SHALLOW COPY, not the live reference. Defense-in-depth: even
	// if a caller casts away the readonly annotation via
	// (getDeferredWarnings() as string[]).push('x'), the cast now mutates
	// the throwaway copy, not the internal buffer. The MAX_DEFERRED_WARNINGS
	// cap and `addDeferredWarning` boundary are still the only way to add
	// entries to the actual buffer.
	return [...deferredWarnings];
}

/**
 * Clears all deferred warnings. This is for session-lifecycle management
 * and is called by src/index.ts at session start to isolate state.
 */
export function clearDeferredWarnings(): void {
	deferredWarnings.length = 0;
}
