import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dispatchFullAutoOversight } from '../../../src/full-auto/oversight';
import { _internals as stateInternals } from '../../../src/state';

// Fix A: the ephemeral oversight session must be created as a child of the
// calling session (parentID) so OpenCode does not persist it as a new TUI root.

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-oversight-parent-')),
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

describe('dispatchFullAutoOversight background session parenting', () => {
	test('binds the critic session to the calling session (parentID + background title)', async () => {
		let capturedBody: { parentID?: string; title?: string } | undefined;
		stateInternals.swarmState.opencodeClient = {
			session: {
				create: async (params: {
					body?: { parentID?: string; title?: string };
				}) => {
					capturedBody = params.body;
					return { data: { id: 'oversight-sess' } };
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

		await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-parent',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'm',
			oversightAgentName: 'critic_oversight',
		});

		expect(capturedBody?.parentID).toBe('sess-parent');
		expect(capturedBody?.title).toContain('background');
	});
});
