/**
 * Manifest-aware event-line helpers for tests reading the bounded core event
 * store (issue #2039). The store's line 1 is a `swarm-events-manifest`
 * header; tests need the EVENT lines only.
 *
 * Parses each line and checks its `type` — never a substring match (a legit
 * event payload could contain the literal 'swarm-events-manifest'; PR review
 * PRR-022). Malformed lines are KEPT so tests that count corruption still
 * see them.
 */

/** Event lines only (manifest header excluded, malformed lines kept). */
export function eventLinesOf(text: string): string[] {
	return text.split('\n').filter((line) => {
		if (!line.trim()) return false;
		try {
			return (
				(JSON.parse(line) as { type?: unknown }).type !==
				'swarm-events-manifest'
			);
		} catch {
			return true;
		}
	});
}

/** The newest (last) event line, manifest header excluded. */
export function newestEventLine(text: string): string {
	return eventLinesOf(text).pop() ?? '';
}
