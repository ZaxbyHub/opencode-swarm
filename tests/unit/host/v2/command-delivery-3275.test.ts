/**
 * #3318 AC9 (DISCRIMINATING): a v2 command invoked with a `delivery` value
 * must pass that value through to the submitted `session.prompt` input;
 * invocations WITHOUT a `delivery` must still submit exactly
 * `{ sessionID, text }` (green at both ends, keeping the existing dispatch
 * suite's toEqual pins valid).
 *
 * At base the submit call ignores `invocation.delivery`
 * (`prompt({ sessionID: invocation.sessionID, text })`), so the recorded
 * input carries no `delivery` — the pass-through half is red at base, the
 * exact-shape half green.
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
	delivery?: string;
}

interface RegisteredCommand {
	name: string;
	description?: string;
	execute: (invocation: {
		sessionID: string;
		prompt: { text: string };
		delivery?: string;
	}) => Promise<void>;
}

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

describe('#3318 AC9 — invocation.delivery is passed through to the submitted prompt input', () => {
	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await removeTreeWithRetry(dir);
		}
	});

	async function registerWithRecordingPrompt(): Promise<{
		commands: RegisteredCommand[];
		prompts: RecordedPrompt[];
	}> {
		const commands: RegisteredCommand[] = [];
		const prompts: RecordedPrompt[] = [];
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
			} as V1HooksSubset,
			trackedMkdtemp('v2-3318-ac9-'),
			[],
		);
		return { commands, prompts };
	}

	test('delivery "queue" reaches the submitted session.prompt input (RED at base: absent)', async () => {
		const { commands, prompts } = await registerWithRecordingPrompt();
		const swarm = commands.find((c) => c.name === 'swarm');
		expect(swarm).toBeDefined();
		await swarm?.execute({
			sessionID: 'ses-ac9-queue',
			prompt: { text: 'status' },
			delivery: 'queue',
		});
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.sessionID).toBe('ses-ac9-queue');
		expect(prompts[0]?.delivery).toBe('queue');
	}, 30000);

	test('delivery "steer" reaches the submitted session.prompt input (RED at base: absent)', async () => {
		const { commands, prompts } = await registerWithRecordingPrompt();
		const swarm = commands.find((c) => c.name === 'swarm');
		await swarm?.execute({
			sessionID: 'ses-ac9-steer',
			prompt: { text: 'status' },
			delivery: 'steer',
		});
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.sessionID).toBe('ses-ac9-steer');
		expect(prompts[0]?.delivery).toBe('steer');
	}, 30000);

	test('without delivery the input is exactly { sessionID, text } (green at both ends)', async () => {
		const { commands, prompts } = await registerWithRecordingPrompt();
		const swarm = commands.find((c) => c.name === 'swarm');
		await swarm?.execute({
			sessionID: 'ses-ac9-none',
			prompt: { text: 'status' },
		});
		expect(prompts.length).toBe(1);
		expect(prompts[0]).toEqual({
			sessionID: 'ses-ac9-none',
			text: '/swarm status',
		});
	}, 30000);
});
