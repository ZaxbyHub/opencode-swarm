import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dispatchCriticAndWriteEvent } from '../../../src/hooks/full-auto-intercept';
import { _internals as stateInternals } from '../../../src/state';

// Fix A: dispatchCriticAndWriteEvent must create its ephemeral critic session
// as a child of the calling architect session (parentID) so OpenCode does not
// persist it as a new TUI root.

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'fa-intercept-parent-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('dispatchCriticAndWriteEvent background session parenting', () => {
	test('attaches parentID + background title when a sessionID is provided', async () => {
		let capturedBody: { parentID?: string; title?: string } | undefined;
		stateInternals.swarmState.opencodeClient = {
			session: {
				create: async (params: {
					body?: { parentID?: string; title?: string };
				}) => {
					capturedBody = params.body;
					return { data: { id: 'critic-sess' } };
				},
				prompt: async () => ({
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: APPROVED\nREASONING: ok\nEVIDENCE_CHECKED: diff\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
							},
						],
					},
				}),
				delete: async () => ({}),
			},
		} as typeof stateInternals.swarmState.opencodeClient;

		await dispatchCriticAndWriteEvent(
			tmpDir,
			'architect output',
			'critic context',
			'm',
			'phase_completion',
			1,
			0,
			'critic_oversight',
			'architect-sess',
		);

		expect(capturedBody?.parentID).toBe('architect-sess');
		expect(capturedBody?.title).toContain('background');
	});

	test('omits body (root session) when no sessionID is provided', async () => {
		let capturedBody: unknown;
		stateInternals.swarmState.opencodeClient = {
			session: {
				create: async (params: { body?: unknown }) => {
					capturedBody = params.body;
					return { data: { id: 'critic-sess' } };
				},
				prompt: async () => ({
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: APPROVED\nREASONING: ok\nEVIDENCE_CHECKED: diff\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
							},
						],
					},
				}),
				delete: async () => ({}),
			},
		} as typeof stateInternals.swarmState.opencodeClient;

		await dispatchCriticAndWriteEvent(
			tmpDir,
			'architect output',
			'critic context',
			'm',
			'phase_completion',
			1,
			0,
			'critic_oversight',
		);

		expect(capturedBody).toBeUndefined();
	});
});
