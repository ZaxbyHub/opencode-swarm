/**
 * #3446 — the legacy (v1) reactive-intercept critic path gets the same bounds as
 * the v2 oversight dispatcher: no bash/shell, and a brevity instruction.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { FULL_AUTO_CRITIC_DENIED_TOOLS } from '../../../src/full-auto/critic-tools';
import {
	buildCriticContext,
	dispatchCriticAndWriteEvent,
} from '../../../src/hooks/full-auto-intercept';
import { _internals as stateInternals } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('intercept-critic-bounds-');
	fs.mkdirSync(`${tmpDir}/.swarm`, { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('legacy intercept critic bounds', () => {
	test('buildCriticContext asks for at most 5 in-project tool calls', () => {
		for (const kind of ['question', 'phase_completion'] as const) {
			const text = buildCriticContext('architect output', kind);
			expect(text).toContain('at most 5 tool calls');
			expect(text).toContain('never search or recurse over the home directory');
		}
	});

	test('the dispatched prompt denies the shared critic tool set, including shell', async () => {
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
				create: mock(async () => ({ data: { id: 'critic-v1' }, error: null })),
				prompt,
				delete: mock(async () => ({})),
			},
		} as never;

		await dispatchCriticAndWriteEvent(
			tmpDir,
			'architect output',
			buildCriticContext('architect output', 'question'),
			'test-model',
			'question',
			0,
			0,
			'critic_oversight',
		);

		const body = (
			prompt.mock.calls[0]?.[0] as { body: { tools: Record<string, boolean> } }
		).body;
		expect(body.tools).toEqual({ ...FULL_AUTO_CRITIC_DENIED_TOOLS });
		expect(body.tools.shell).toBe(false);
		expect(body.tools.bash).toBe(false);
	});
});
