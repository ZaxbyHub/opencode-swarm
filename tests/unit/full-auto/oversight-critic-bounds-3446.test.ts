/**
 * #3446 — the Full-Auto critic must be bounded: no shell (which is not
 * read-only and let it run `find ~` until the oversight deadline killed it),
 * and a brevity instruction in the prompt.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FULL_AUTO_CRITIC_DENIED_TOOLS } from '../../../src/full-auto/critic-tools';
import { dispatchFullAutoOversight } from '../../../src/full-auto/oversight';
import { startFullAutoRun } from '../../../src/full-auto/state';
import { _internals as stateInternals } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('full-auto-critic-bounds-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FULL_AUTO_CRITIC_DENIED_TOOLS', () => {
	test('denies the mutating tools and shell', () => {
		for (const name of ['write', 'edit', 'patch', 'bash', 'shell']) {
			expect(FULL_AUTO_CRITIC_DENIED_TOOLS[name]).toBe(false);
		}
	});

	test('keeps the swarm verification tools reachable (execute is not denied)', () => {
		// Intentional: `execute` is how OpenCode 2 reaches diff/evidence/test_impact;
		// see the limit documented in critic-tools.ts.
		expect('execute' in FULL_AUTO_CRITIC_DENIED_TOOLS).toBe(false);
	});

	test('is immutable', () => {
		expect(Object.isFrozen(FULL_AUTO_CRITIC_DENIED_TOOLS)).toBe(true);
	});
});

describe('oversight dispatch bounds the critic', () => {
	test('sends the deny map and a brevity instruction with the prompt', async () => {
		startFullAutoRun(tmpDir, 'sess-bounds', { enabled: true });
		const prompt = mock(async (_args: unknown) => ({
			data: {
				parts: [
					{
						type: 'text',
						text: 'VERDICT: APPROVED\nREASONING: ok\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
					},
				],
			},
		}));
		stateInternals.swarmState.opencodeClient = {
			session: {
				create: mock(async () => ({ data: { id: 'critic-1' }, error: null })),
				prompt,
				delete: mock(async () => ({})),
			},
		} as never;

		await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-bounds',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'test-model',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: {},
		});

		const body = (
			prompt.mock.calls[0]?.[0] as {
				body: { tools: Record<string, boolean>; parts: { text: string }[] };
			}
		).body;
		expect(body.tools).toEqual({ ...FULL_AUTO_CRITIC_DENIED_TOOLS });
		expect(body.tools.shell).toBe(false);
		expect(body.parts[0].text).toContain('at most 5 tool calls');
		expect(body.parts[0].text).toContain(
			'never search or recurse over the home directory',
		);
	});
});
