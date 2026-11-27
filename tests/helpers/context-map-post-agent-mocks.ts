/**
 * Shared mock-assignment helper for src/context-map/post-agent-update tests
 * (split out of tests/unit/context-map/post-agent-update.test.ts for the
 * FR-006 file cap).
 */
import { mock } from 'bun:test';
import { _internals } from '../../src/context-map/post-agent-update';
import type { ContextMap } from '../../src/types/context-map';

/**
 * Mock the loadContextMap seam AND keep the discriminated
 * `readContextMapState` seam coherent with it.
 *
 * r17 (P1): the update path reads through the discriminated
 * `readContextMapState` seam FIRST. Keep the two reads coherent for
 * seam-based tests: a mocked map is a valid readable map (`ok`), a mocked
 * null is the rebuild-legitimate `missing` case (the semantics these
 * tests encoded before the discriminated read existed). A genuinely
 * unreadable existing map is covered by the integration-style
 * child-update-corrupt-preservation.test.ts on the real filesystem.
 */
export function setLoadContextMap(
	fn: (directory: string) => ContextMap | null,
): ReturnType<typeof mock> {
	const mockFn = mock(fn);
	_internals.loadContextMap = mockFn as typeof _internals.loadContextMap;
	_internals.readContextMapState = mock((directory: string) => {
		const map = fn(directory);
		return map === null
			? { kind: 'missing' as const }
			: { kind: 'ok' as const, map };
	}) as typeof _internals.readContextMapState;
	return mockFn;
}
