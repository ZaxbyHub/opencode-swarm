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

/**
 * C0/C1 control characters and DEL: covers ESC (`\x1B`, the start of every
 * ANSI/CSI/OSC terminal-control sequence), BEL (`\x07`), and the rest of the
 * 0x00-0x1F and 0x7F-0x9F ranges. `\s` in JS regex does NOT match these, so a
 * plain whitespace collapse leaves them intact.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — this regex's entire purpose is matching terminal-control characters (ESC/BEL/etc.) so they can be stripped before /swarm diagnose renders untrusted content (security review, issue #1886 follow-up).
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F-\x9F]/g;

/**
 * Strip terminal-control characters and collapse whitespace runs to a single
 * space, producing a string safe to append as one `/swarm diagnose` markdown
 * bullet (`formatDiagnoseMarkdown` emits `- ${warning}`).
 */
function sanitizeBufferedLine(s: string): string {
	// Collapse whitespace FIRST: tab/LF/CR fall inside the C0 control range
	// too, and they must become a single space (readability), not vanish
	// outright the way a dangerous control char (ESC, BEL, ...) should. A
	// second collapse pass after stripping controls cleans up any new
	// adjacency left behind when a control char sat between two independent
	// whitespace runs (e.g. "a \x1B\n b" -> "a  b" -> "a b").
	return s
		.replace(/\s+/g, ' ')
		.replace(CONTROL_CHARS_RE, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Buffer a warning for `/swarm diagnose`. This is the single write boundary
 * for `deferredWarnings` — `advisoryWarn` funnels through it, and roughly a
 * dozen call sites across `src/index.ts` and `src/agents/index.ts` call it
 * directly with hand-composed messages. Several of those interpolate
 * repo-controlled config content (agent names from `agents: z.record(...)`,
 * the `auto_select_architect` string, …) that flows straight from an
 * auto-loaded, attacker-editable `.opencode/opencode-swarm.json`.
 *
 * Sanitizing HERE — not in `advisoryWarn` — is what actually closes the class:
 * every path into the buffer passes through this one function, so a future
 * direct caller can't reintroduce the terminal-control-character /
 * markdown-bullet-breaking class this guards against (security review,
 * issue #1886 follow-up; an earlier revision of this fix sanitized only
 * inside `advisoryWarn` and missed every direct caller).
 */
export function addDeferredWarning(warning: string): void {
	const sanitized = sanitizeBufferedLine(warning);
	if (deferredWarnings.length < MAX_DEFERRED_WARNINGS - 1) {
		deferredWarnings.push(sanitized);
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
 * Upper bound (chars) on the rendered `data` detail appended to a buffered
 * advisory. The buffer itself is already capped at MAX_DEFERRED_WARNINGS
 * entries; this bounds per-entry size so a large validation dump cannot bloat
 * `/swarm diagnose`. Overflow is truncated with an ellipsis.
 */
const MAX_ADVISORY_DETAIL_CHARS = 600;

/**
 * Render the optional `data` argument of `advisoryWarn` into a compact,
 * single-line, bounded string that is safe to append to the operator-visible
 * deferred-warning buffer. Returns '' when there is nothing meaningful to show.
 *
 * Intentionally generic (no Zod/domain coupling): strings pass through, Errors
 * surface their `.message`, string arrays join, and anything else is
 * JSON-stringified with a `String()` fallback for circular refs, BigInt, and
 * the `undefined`-return cases (functions/symbols). Callers that want a clean,
 * human-readable summary (e.g. flattened Zod issues) should pass a pre-formatted
 * string — see `formatZodIssues` in `config/loader.ts` (issue #1886).
 */
function renderAdvisoryDetail(data: unknown): string {
	if (data === undefined || data === null) return '';
	let raw: string;
	if (typeof data === 'string') {
		raw = data;
	} else if (data instanceof Error) {
		raw = data.message;
	} else if (Array.isArray(data) && data.every((d) => typeof d === 'string')) {
		raw = (data as string[]).join('; ');
	} else {
		try {
			// JSON.stringify RETURNS undefined (does not throw) for functions and
			// symbols; the ?? covers that, the catch covers circular refs/BigInt.
			raw = JSON.stringify(data) ?? String(data);
		} catch {
			raw = String(data);
		}
	}
	const collapsed = sanitizeBufferedLine(raw);
	if (collapsed === '') return '';
	return collapsed.length > MAX_ADVISORY_DETAIL_CHARS
		? `${collapsed.slice(0, MAX_ADVISORY_DETAIL_CHARS - 1)}…`
		: collapsed;
}

/**
 * Operational advisory: a non-fatal, operator-actionable condition reached on
 * a path that can run while the host TUI owns the terminal (plugin init,
 * /swarm command handlers, tool execution, chat/tool hooks). Routes to BOTH
 * delivery channels:
 *
 * 1. `addDeferredWarning` — buffers it for `/swarm diagnose`, so the operator
 *    can discover the condition without it polluting the live display. The
 *    optional `data` is folded into the buffered entry (rendered compact +
 *    single-line) so actionable detail is visible in `/swarm diagnose`, not
 *    only under debug (issue #1886: config-validation detail was silently lost).
 * 2. `log` — the debug-gated logger, so the message AND the structured `data`
 *    also show under `OPENCODE_SWARM_DEBUG=1` for live debugging.
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
	const detail = renderAdvisoryDetail(data);
	// addDeferredWarning sanitizes on write, so `message` (which some callers
	// build by interpolating untrusted content) is protected there too — not
	// just the `data` half rendered above.
	addDeferredWarning(detail ? `${message} ${detail}` : message);
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
