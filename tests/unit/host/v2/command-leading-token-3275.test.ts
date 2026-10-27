/**
 * #3318 AC7 (DISCRIMINATING): a leading `/swarm` or `swarm` token in
 * `invocation.prompt.text` must be stripped (exactly one token, only when it
 * is exactly `/swarm` or `swarm`) before dispatch, so the hook receives the
 * same `arguments` as for the bare arguments; text that does not begin with
 * that exact token is left unchanged.
 *
 * At base the text is passed through verbatim, so the recorded hook
 * `arguments` for `/swarm status` and `swarm status` are the raw texts
 * (probe-observed downstream result: ``Command `/swarm /swarm` not found.``
 * and ``Command `/swarm swarm` not found.``). The unchanged arms
 * (`status`, `swarmish status`, ``) are green at both ends.
 *
 * Fakes only (no mock.module); local fake-ctx helper following the pattern of
 * tests/unit/host/v2/command-dispatch-3169.test.ts (nothing imported from it);
 * canonicalMkdtemp project directory.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { registerV2AgentsAndCommands } from '../../../../src/host/v2/agents-commands';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

interface RecordedPrompt {
	sessionID: string;
	text: string;
}

interface RegisteredCommand {
	name: string;
	description?: string;
	execute: (invocation: {
		sessionID: string;
		prompt: { text: string };
	}) => Promise<void>;
}

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

describe('#3318 AC7 — a leading /swarm or swarm token is stripped before dispatch', () => {
	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await removeTreeWithRetry(dir);
		}
	});

	test('hook arguments match the bare arguments for leading-token texts; near-miss and empty texts unchanged', async () => {
		const commands: RegisteredCommand[] = [];
		const prompts: RecordedPrompt[] = [];
		const recordedArguments: string[] = [];

		await registerV2AgentsAndCommands(
			{
				agent: {
					transform: async () => ({ dispose: async () => {} }),
					reload: async () => {},
				},
				command: {
					transform: async (
						cb: (e: { add(d: RegisteredCommand): void }) => void,
					) => {
						cb({
							add(d) {
								commands.push(d);
							},
						});
						return { dispose: async () => {} };
					},
					reload: async () => {},
				},
				session: {
					hook: async () => ({ dispose: async () => {} }),
					prompt: async (input: unknown) => {
						prompts.push(input as RecordedPrompt);
					},
				},
			} as never,
			{
				config: async (cfg: Record<string, unknown>) => {
					cfg.command = {
						swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
					};
				},
				// Recording registry hook: the `arguments` it receives are the
				// dispatch input the normalization must fix. Parts stay empty so
				// the fallback template is submitted (irrelevant to this check).
				'command.execute.before': async (input: unknown) => {
					const typed = input as { arguments?: unknown };
					recordedArguments.push(
						typeof typed.arguments === 'string' ? typed.arguments : '',
					);
				},
			} as V1HooksSubset,
			trackedMkdtemp('v2-3318-ac7-'),
			[],
		);

		const swarm = commands.find((c) => c.name === 'swarm');
		expect(swarm).toBeDefined();

		const cases: Array<{ typed: string; expected: string }> = [
			// Bare arguments pass through (green at both ends).
			{ typed: 'status', expected: 'status' },
			// Leading '/swarm' token stripped (RED at base: recorded verbatim).
			{ typed: '/swarm status', expected: 'status' },
			// Leading 'swarm' token stripped (RED at base: recorded verbatim).
			{ typed: 'swarm status', expected: 'status' },
			// Near-miss token must NOT be stripped (green at both ends).
			{ typed: 'swarmish status', expected: 'swarmish status' },
			// Empty text unchanged (green at both ends).
			{ typed: '', expected: '' },
		];

		for (const c of cases) {
			await swarm?.execute({ sessionID: 'ses-ac7', prompt: { text: c.typed } });
			expect(recordedArguments[recordedArguments.length - 1]).toBe(c.expected);
		}

		// Every case dispatched exactly once.
		expect(recordedArguments.length).toBe(cases.length);
	}, 30000);
});
