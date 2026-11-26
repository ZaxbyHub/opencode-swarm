/**
 * In-memory child-session activity registry (the 2026-11-26 task 2.15 wedge).
 *
 * The background delegation stale sweep flips a `pending`/`running` record to
 * `stale` (failure class `liveness`) when its STORE `updatedAt` is older than
 * the sweep timeout — but a live child's activity never writes the store: the
 * record is written at dispatch and again only at its terminal. A
 * legitimately long coder round was therefore classified dead while
 * physically alive. Observed live (task 2.15, three consecutive rounds): each
 * round ran JVM-coupled test suites past the 30-minute mark, was
 * stale-swept AT the mark with zero store writes in between, and delivered
 * its committed work seconds after the flip — the settlement never happened,
 * the task wedged at idle with a user-salvaged deliverable (same family as
 * the 2.24 and 2.14 incidents).
 *
 * This registry is the observed-activity signal the sweep was missing. The v2
 * event pump feeds it (metadata only: session id + event type — never payload
 * text), and the sweep consults it before flipping: a child that showed ANY
 * host event within the sweep window, or that currently has an OPEN tool call
 * (a single long execution emits `session.tool.called` at its start and
 * nothing until it completes), is alive and must not be swept.
 *
 * Semantics:
 *   - `tool_open` / `tool_close` maintain a bounded per-session open-tool
 *     counter; an unmatched close is ignored. An open tool call blocks the
 *     sweep regardless of age — the alternative (capping the grace) re-creates
 *     the exact wedge this registry closes for any run longer than the cap.
 *   - `session_end` (session.execution.succeeded/interrupted/failed) clears
 *     the open counter: a session cannot outlive its own terminal, and the
 *     idle window then applies from the last observation.
 *   - Entries evict FIFO-by-activity beyond MAX_TRACKED_SESSIONS, preferring
 *     sessions with no open tool calls (an open call is never evicted while
 *     calmer entries exist). Bounded per AGENTS.md invariant 8.
 *
 * Process-local by design: the registry and the sweep run in the same plugin
 * instance. A host without the v2 event pump keeps the historical store-age
 * sweep semantics (fail-open to the pre-registry behavior).
 */

const MAX_TRACKED_SESSIONS = 128;
const MAX_OPEN_TOOL_COUNTER = 64;
const MAX_SESSION_ID_CHARS = 256;

export type ChildActivityEventKind =
	| 'event'
	| 'tool_open'
	| 'tool_close'
	| 'session_end';

interface ChildActivityEntry {
	lastEventAt: number;
	openToolCalls: number;
}

const activityBySession = new Map<string, ChildActivityEntry>();

function isTrackableSessionId(sessionID: string): boolean {
	return sessionID.trim() !== '' && sessionID.length <= MAX_SESSION_ID_CHARS;
}

function evictIfNeededLocked(): void {
	if (activityBySession.size <= MAX_TRACKED_SESSIONS) return;
	// Evict the stalest quiet entry first; only when EVERY entry carries an
	// open tool call does the bound win over the signal (absurd concurrency,
	// but memory stays bounded regardless).
	let victim: string | null = null;
	let victimAt = Number.POSITIVE_INFINITY;
	for (const [sessionID, entry] of activityBySession) {
		if (entry.openToolCalls > 0) continue;
		if (entry.lastEventAt < victimAt) {
			victim = sessionID;
			victimAt = entry.lastEventAt;
		}
	}
	if (victim === null) {
		for (const [sessionID, entry] of activityBySession) {
			if (entry.lastEventAt < victimAt) {
				victim = sessionID;
				victimAt = entry.lastEventAt;
			}
		}
	}
	if (victim !== null) activityBySession.delete(victim);
}

/**
 * Record one observed host event for a child session. All kinds bump the
 * last-activity timestamp; `tool_open`/`tool_close` maintain the open-tool
 * counter; `session_end` clears it. Untrackable ids are ignored (bounded
 * memory, never a crash on a hostile envelope).
 */
export function noteChildSessionEvent(
	sessionID: string,
	kind: ChildActivityEventKind,
): void {
	if (!isTrackableSessionId(sessionID)) return;
	const now = Date.now();
	let entry = activityBySession.get(sessionID);
	if (entry === undefined) {
		evictIfNeededLocked();
		entry = { lastEventAt: now, openToolCalls: 0 };
		activityBySession.set(sessionID, entry);
	}
	entry.lastEventAt = now;
	if (kind === 'tool_open') {
		entry.openToolCalls = Math.min(
			entry.openToolCalls + 1,
			MAX_OPEN_TOOL_COUNTER,
		);
	} else if (kind === 'tool_close') {
		entry.openToolCalls = Math.max(entry.openToolCalls - 1, 0);
	} else if (kind === 'session_end') {
		entry.openToolCalls = 0;
	}
}

/**
 * Whether this child session's observed activity blocks a stale sweep with
 * the given inactivity window: true when the session showed an event within
 * `withinMs`, OR when it currently has an open tool call. Unknown/quiet
 * sessions never block (the historical store-age sweep semantics apply).
 */
export function childBlocksStaleSweep(
	sessionID: string,
	withinMs: number,
): boolean {
	if (!isTrackableSessionId(sessionID)) return false;
	const entry = activityBySession.get(sessionID);
	if (entry === undefined) return false;
	if (entry.openToolCalls > 0) return true;
	const window = Math.max(withinMs, 0);
	return Date.now() - entry.lastEventAt <= window;
}

/** Test seam: clear the registry (AGENTS.md invariant 7/8 isolation). */
export function _resetChildActivityForTesting(): void {
	activityBySession.clear();
}

/**
 * Test seam: record an event with an explicit timestamp so tests can pin the
 * exact 2.15 wedge geometry (an open tool call OLDER than the sweep window
 * must still block — a single long execution writes no events in between).
 */
export function _noteChildSessionEventAtForTesting(
	sessionID: string,
	kind: ChildActivityEventKind,
	at: number,
): void {
	if (!isTrackableSessionId(sessionID)) return;
	const entry = activityBySession.get(sessionID) ?? {
		lastEventAt: at,
		openToolCalls: 0,
	};
	entry.lastEventAt = at;
	if (kind === 'tool_open') {
		entry.openToolCalls = Math.min(
			entry.openToolCalls + 1,
			MAX_OPEN_TOOL_COUNTER,
		);
	} else if (kind === 'tool_close') {
		entry.openToolCalls = Math.max(entry.openToolCalls - 1, 0);
	} else if (kind === 'session_end') {
		entry.openToolCalls = 0;
	}
	activityBySession.set(sessionID, entry);
}
