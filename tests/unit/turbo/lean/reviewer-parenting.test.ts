import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../../../../src/state';
import { _internals } from '../../../../src/turbo/lean/reviewer';

// Fix A: defaultDispatchReviewerAgent must create its ephemeral session as a
// child of the calling session (parentID) when one is provided, so OpenCode
// does not persist it as a new TUI root.

function makeReviewPackage() {
	return {
		phase: 1,
		sessionID: 'test-session',
		laneSummaries: [],
		filesChanged: [],
		testResults: { totalLanes: 0, completedLanes: 0, failedLanes: 0 },
		buildStatus: 'unknown' as const,
		degradationSummary: {
			totalDegraded: 0,
			resolvedDegraded: 0,
			pendingDegraded: 0,
		},
	};
}

describe('defaultDispatchReviewerAgent background session parenting', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-reviewer-parent-'));
	});

	afterEach(() => {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	test('attaches parentID + background title when a parent session is provided', async () => {
		let capturedBody: { parentID?: string; title?: string } | undefined;
		const mockClient = {
			session: {
				create: mock(
					async (params: {
						body?: { parentID?: string; title?: string };
						query: { directory: string };
					}) => {
						capturedBody = params.body;
						return { data: { id: 'mock-session-id' } };
					},
				),
				prompt: mock(async () => ({
					data: {
						parts: [{ type: 'text', text: 'VERDICT: APPROVED\nREASON: ok' }],
					},
				})),
				delete: mock(async () => ({})),
			},
		};

		const originalClient = swarmState.opencodeClient;
		swarmState.opencodeClient = mockClient as typeof mockClient;
		try {
			await _internals.dispatchReviewerAgent(
				dir,
				makeReviewPackage(),
				'test_reviewer',
				0,
				'parent-sess',
			);
			expect(capturedBody?.parentID).toBe('parent-sess');
			expect(capturedBody?.title).toContain('background');
		} finally {
			swarmState.opencodeClient = originalClient;
		}
	});

	test('omits body (root session) when no parent session is provided', async () => {
		let capturedBody: unknown;
		const mockClient = {
			session: {
				create: mock(async (params: { body?: unknown }) => {
					capturedBody = params.body;
					return { data: { id: 'mock-session-id' } };
				}),
				prompt: mock(async () => ({
					data: {
						parts: [{ type: 'text', text: 'VERDICT: APPROVED\nREASON: ok' }],
					},
				})),
				delete: mock(async () => ({})),
			},
		};

		const originalClient = swarmState.opencodeClient;
		swarmState.opencodeClient = mockClient as typeof mockClient;
		try {
			await _internals.dispatchReviewerAgent(
				dir,
				makeReviewPackage(),
				'test_reviewer',
				0,
			);
			expect(capturedBody).toBeUndefined();
		} finally {
			swarmState.opencodeClient = originalClient;
		}
	});
});
