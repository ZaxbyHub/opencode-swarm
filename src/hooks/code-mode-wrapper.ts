/**
 * Per-call marker for the OpenCode v2 Code Mode `execute` wrapper (#3446).
 *
 * OpenCode v2 reaches plugin and MCP tools through one host-owned `execute`
 * tool whose input is a JS program (`{ code }`); every nested `tools.<name>()`
 * call is dispatched through the tool.execute.before chain under its own name.
 * Only the v2 adapter sees the host's real tool id, so only the adapter can
 * mark a call. The mark is NOT proof of provenance: a v2 tool event is just
 * {tool, sessionID, agent, messageID, id, input}, so a plugin- or MCP-provided
 * tool that shares the name `execute` and takes a string `code` is marked too.
 * That is why the Full-Auto classifier only honours the mark when the operator
 * opts in (`permission_policy.trust_code_mode_wrapper`, default false) and the
 * program is exactly one plain-data tool call. On a v1 host nothing is marked.
 *
 * Side-channel shape mirrors `src/sandbox/skip-state.ts` (keyed by
 * session + call, bounded, FIFO-evicted) so session state stays bounded
 * (invariant 8).
 */

/** Hard cap on retained marks; oldest are evicted first. */
export const MAX_CODE_MODE_WRAPPER_MARKS = 256;

const marks = new Set<string>();

function key(sessionID: string, callID: string): string {
	return `${sessionID}\u0000${callID}`;
}

/** Record that this exact call is the host's Code Mode `execute` wrapper. */
export function recordCodeModeWrapperCall(
	sessionID: string,
	callID: string,
): void {
	if (!sessionID || !callID) return;
	const k = key(sessionID, callID);
	// Re-insert so a repeated mark refreshes its FIFO position.
	marks.delete(k);
	marks.add(k);
	while (marks.size > MAX_CODE_MODE_WRAPPER_MARKS) {
		const oldest = marks.values().next().value;
		if (oldest === undefined) break;
		marks.delete(oldest);
	}
}

/** True only for a call the v2 adapter marked as the Code Mode wrapper. */
export function isCodeModeWrapperCall(
	sessionID: string,
	callID: string | undefined,
): boolean {
	if (!sessionID || !callID) return false;
	return marks.has(key(sessionID, callID));
}

/** Drop a mark once the call has completed. */
export function clearCodeModeWrapperCall(
	sessionID: string,
	callID: string,
): void {
	marks.delete(key(sessionID, callID));
}

/** Test seam: drop every mark. */
export function resetCodeModeWrapperCalls(): void {
	marks.clear();
}
