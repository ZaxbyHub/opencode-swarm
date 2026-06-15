import { describe, expect, mock, test } from 'bun:test';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';

// Fix A: a lane's ephemeral session must be created as a child of the runner's
// owning session (parentID) so OpenCode does not persist it as a new TUI root.
// We drive dispatchLane directly with an injected _sessionOps mock, avoiding
// the full plan/lock machinery.
//
// Injection seam: LeanTurboRunner stores its SDK session operations in the
// `_sessionOps` field (prefixed by convention as a test seam). The cast below
// replaces it before the first `dispatchLane` call, skipping network I/O
// while keeping the full business logic path under test. If the runner is
// refactored to expose _internals (like integration.ts / reviewer.ts), update
// to use that instead.

const LANE: LeanTurboLane = {
	laneId: 'lane-1',
	taskIds: ['1.1'],
	files: ['src/a.ts'],
	status: 'pending',
};

function makeMockSessionOps(capture: (body: unknown) => void) {
	return {
		create: mock(async (params: { body?: unknown }) => {
			capture(params.body);
			return { data: { id: 'lane-sess' }, error: null };
		}),
		prompt: mock(async () => ({
			data: { parts: [{ type: 'text', text: 'Done' }] },
			error: null,
		})),
		delete: mock(async () => {}),
	};
}

describe('LeanTurboRunner lane session parenting', () => {
	test('attaches parentID + background title to the lane session', async () => {
		let capturedBody: { parentID?: string; title?: string } | undefined;
		const runner = new LeanTurboRunner({
			directory: '/tmp/runner-parent',
			sessionID: 'sess-parent',
		});
		(
			runner as unknown as {
				_sessionOps: ReturnType<typeof makeMockSessionOps>;
			}
		)._sessionOps = makeMockSessionOps((b) => {
			capturedBody = b as { parentID?: string; title?: string };
		});

		const result = await runner.dispatchLane(LANE, 'coder');

		expect(result.ok).toBe(true);
		expect(capturedBody?.parentID).toBe('sess-parent');
		expect(capturedBody?.title).toContain('background');
	});
});
