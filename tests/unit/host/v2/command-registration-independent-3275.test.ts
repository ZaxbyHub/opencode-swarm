/**
 * #3318 AC1 (DISCRIMINATING): the v2 command table must register even when
 * the v2 agent transform rejects.
 *
 * At base `registerV2AgentsAndCommands` awaits `ctx.agent.transform` BEFORE
 * `ctx.command.transform` (src/host/v2/agents-commands.ts), so an
 * agent-transform rejection escapes the function before a single command is
 * added (probe-observed `commands registered = 0`). The check passes a fake
 * ctx whose agent transform rejects, tolerates either a resolved or a
 * rejected registration call, and asserts the `swarm` and `swarm-status`
 * definitions were added through `ctx.command.transform`.
 *
 * Fakes only (no mock.module); local fake-ctx helper following the pattern of
 * tests/unit/host/v2/command-dispatch-3169.test.ts (nothing imported from it);
 * canonicalMkdtemp project directory.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { registerV2AgentsAndCommands } from '../../../../src/host/v2/agents-commands';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

interface RegisteredCommand {
	name: string;
	description?: string;
	execute: (invocation: unknown) => Promise<void>;
}

const AGENT_REJECTION_MESSAGE =
	'agent transform rejected by host (test double #3318 AC1)';

const COMMAND_TABLE = {
	swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
	'swarm-status': { template: '/swarm status', description: 'swarm status' },
};

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

describe('#3318 AC1 — command registration survives an agent-transform rejection', () => {
	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await removeTreeWithRetry(dir);
		}
	});

	test('a rejecting ctx.agent.transform still adds the swarm and swarm-status commands', async () => {
		const commands: RegisteredCommand[] = [];
		let agentTransformCalls = 0;
		let commandTransformCalls = 0;

		const registration = registerV2AgentsAndCommands(
			{
				agent: {
					transform: async () => {
						agentTransformCalls += 1;
						throw new Error(AGENT_REJECTION_MESSAGE);
					},
					reload: async () => {},
				},
				command: {
					transform: async (
						cb: (e: { add(d: RegisteredCommand): void }) => void,
					) => {
						commandTransformCalls += 1;
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
				},
			} as never,
			{
				config: async (cfg: Record<string, unknown>) => {
					cfg.command = COMMAND_TABLE;
				},
			} as V1HooksSubset,
			trackedMkdtemp('v2-3318-ac1-'),
			[],
		);
		// Tolerate either a resolved or a rejected registration call: the AC
		// pins the command table, not the function's own outcome (at base the
		// agent-transform rejection propagates out of the whole function).
		await registration.catch(() => {});

		expect(agentTransformCalls).toBe(1);
		// The discriminating assertions: the command transform ran and the
		// `swarm` + `swarm-status` definitions were added (base: 0 commands).
		expect(commandTransformCalls).toBe(1);
		const names = commands.map((c) => c.name);
		expect(names).toContain('swarm');
		expect(names).toContain('swarm-status');
	}, 30000);
});
