/**
 * Bounded buffer for deferred non-critical init warnings.
 * Populated during plugin startup when quiet:true; replayed in /swarm diagnose.
 * Extracted from index.ts so agents/index.ts and diagnose-service.ts can
 * share the buffer without creating a circular dependency.
 * Max 50 entries to prevent memory growth.
 * Access is restricted via getter to prevent unauthorized mutation.
 */
import { log } from '../utils/logger.js';

const deferredWarnings: string[] = [];
const MAX_DEFERRED_WARNINGS = 50;
// Set once the cap is reached so a single trailing sentinel can be appended
// by addDeferredWarning. Prevents silent truncation from hiding actionable
// advisories (epic #1752 PR2 review F-003).
let deferredWarningsTruncated = false;

export function addDeferredWarning(warning: string): void {
	if (deferredWarnings.length < MAX_DEFERRED_WARNINGS - 1) {
		deferredWarnings.push(warning);
		return;
	}
	// Reserve the last slot for a truncation sentinel so /swarm diagnose can
	// tell the operator that further advisories were dropped, rather than
	// silently losing them. SECURITY/fallback messages emitted after the cap
	// is hit would otherwise vanish without trace.
	if (!deferredWarningsTruncated) {
		deferredWarnings.push(
			`[opencode-swarm] ${MAX_DEFERRED_WARNINGS - 1} deferred warnings buffered; additional advisories were dropped (cap reached). Run with OPENCODE_SWARM_DEBUG=1 to see all advisories in the debug log.`,
		);
		deferredWarningsTruncated = true;
	}
}

/**
 * Operational advisory: a non-fatal, operator-actionable condition reached on
 * a path that can run while the host TUI owns the terminal (plugin init,
 * /swarm command handlers, tool execution, chat/tool hooks). Routes the message
 * to BOTH delivery channels:
 *
 * 1. `addDeferredWarning` — buffers it for `/swarm diagnose`, so the operator
 *    can discover the condition without it polluting the live display.
 * 2. `log` — the debug-gated logger, so it also shows under
 *    `OPENCODE_SWARM_DEBUG=1` for live debugging.
 *
 * This NEVER writes raw stderr/stdout. It is the safe replacement for the raw
 * `console.warn` calls that corrupt the bubbletea TUI (issue #1249 class, and
 * the broader sweep in `.zcode/issue-traces/bundled-skill-tui-pollution/`).
 *
 * Discriminator vs plain `log()`: use `advisoryWarn` only when the operator
 * could plausibly act on the message (fix a malformed config, pick a
 * worktree, repair a broken skill sync). Use plain `log()` for purely
 * diagnostic fail-open catches (skipped malformed lines, best-effort cleanup)
 * that would flood `/swarm diagnose` if buffered.
 *
 * Per AGENTS.md Invariant 10: "Do not emit diagnostic noise into chat-visible
 * streams."
 */
export function advisoryWarn(message: string, data?: unknown): void {
	addDeferredWarning(message);
	log(message, data);
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
	deferredWarningsTruncated = false;
}
