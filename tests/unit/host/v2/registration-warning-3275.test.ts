/**
 * #3318 AC2 (DISCRIMINATING): an agent-transform rejection during v2
 * registration must record a deferred warning naming the agent-transform
 * failure and its error message.
 *
 * At base the rejection reaches only the debug-gated `log()` (visible solely
 * under OPENCODE_SWARM_DEBUG=1), so `getDeferredWarnings()` is empty after a
 * failed registration. The check calls `clearDeferredWarnings()` first, runs
 * the registration with a rejecting fake agent transform, and asserts the
 * buffer holds a warning that contains `agent` and the rejection message
 * (substring contract — the implementer keeps wording freedom).
 *
 * Fakes only (no mock.module); local fake-ctx helper following the pattern of
 * tests/unit/host/v2/command-dispatch-3169.test.ts (nothing imported from it);
 * canonicalMkdtemp project directory.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { registerV2AgentsAndCommands } from '../../../../src/host/v2/agents-commands';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

interface RegisteredCommand {
	name: string;
	description?: string;
	execute: (invocation: unknown) => Promise<void>;
}

const AGENT_REJECTION_MESSAGE =
	'agent transform rejected by host (test double #3318 AC2)';

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

describe('#3318 AC2 — agent-transform rejection records a deferred warning', () => {
	afterEach(async () => {
		clearDeferredWarnings();
		for (const dir of tempDirs.splice(0)) {
			await removeTreeWithRetry(dir);
		}
	});

	test('a rejecting ctx.agent.transform buffers a warning naming agent + the error message', async () => {
		clearDeferredWarnings();
		const commands: RegisteredCommand[] = [];

		const registration = registerV2AgentsAndCommands(
			{
				agent: {
					transform: async () => {
						throw new Error(AGENT_REJECTION_MESSAGE);
					},
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
				},
			} as never,
			{
				config: async (cfg: Record<string, unknown>) => {
					cfg.command = COMMAND_TABLE;
				},
			} as V1HooksSubset,
			trackedMkdtemp('v2-3318-ac2-'),
			[],
		);
		// Whether the registration call resolves or rejects is AC1's concern;
		// here only the warning contract is pinned.
		await registration.catch(() => {});

		// The discriminating assertion: at base the failure is silent, so the
		// deferred-warning buffer is EMPTY after the failed registration.
		const warnings = getDeferredWarnings();
		expect(warnings.length).toBeGreaterThan(0);
		const matched = warnings.filter(
			(w) =>
				w.toLowerCase().includes('agent') &&
				w.includes(AGENT_REJECTION_MESSAGE),
		);
		expect(matched.length).toBeGreaterThan(0);
	}, 30000);
});
