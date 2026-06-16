import { describe, expect, mock, test } from 'bun:test';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';

// Fix A: a lane's ephemeral session must be created as a child of the runner's
// owning session (parentID) so OpenCode does not persist it as a new TUI root.
// We drive dispatchLane directly with an injected _sessionOps mock, avoiding
// the full plan/lock machinery.
//
// `_sessionOps` is a documented public test-seam field declared at
// runner.ts:265-283. It is part of the class's intentional DI contract — the
// class JSDoc shows this exact injection pattern. The `as unknown as` cast on
// the assigned value is only needed because `SessionClient` is not exported
// and the bun `mock()` wrapper differs in exact type signature while remaining
// structurally compatible.

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
		runner._sessionOps = makeMockSessionOps((b) => {
			capturedBody = b as { parentID?: string; title?: string };
		}) as unknown as typeof runner._sessionOps;

		const result = await runner.dispatchLane(LANE, 'coder');

		expect(result.ok).toBe(true);
		expect(capturedBody?.parentID).toBe('sess-parent');
		expect(capturedBody?.title).toContain('background');
	});
});
