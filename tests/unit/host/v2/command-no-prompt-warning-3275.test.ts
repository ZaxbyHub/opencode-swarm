/**
 * #3318 AC4 (DISCRIMINATING): a v2 command executing on a host that exposes
 * no `session.prompt` must record a deferred warning naming the command and
 * must NOT run the registry handler.
 *
 * At base the no-prompt arm is the #3169 side-effect-free no-op — the hook is
 * not invoked (that half is green at base and asserted here too) — but the
 * operator sees nothing: the condition reaches only the debug-gated `log()`,
 * so `getDeferredWarnings()` is empty (probe-observed silent no-op,
 * `threw="" prompts=0`). The warning half is what is red at base.
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

describe('#3318 AC4 — no session.prompt surface warns instead of silently no-opping', () => {
	afterEach(async () => {
		clearDeferredWarnings();
		for (const dir of tempDirs.splice(0)) {
			await removeTreeWithRetry(dir);
		}
	});

	test('executing without a session prompt surface records a warning naming the command and skips the registry handler', async () => {
		clearDeferredWarnings();
		const commands: RegisteredCommand[] = [];
		let hookInvocations = 0;

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
					// No prompt member at all — the host exposes no prompt surface.
				},
			} as never,
			{
				config: async (cfg: Record<string, unknown>) => {
					cfg.command = {
						swarm: { template: '/swarm $ARGUMENTS', description: 'swarm' },
						'swarm-status': {
							template: '/swarm status',
							description: 'swarm status',
						},
					};
				},
				'command.execute.before': async () => {
					hookInvocations += 1;
				},
			} as V1HooksSubset,
			trackedMkdtemp('v2-3318-ac4-'),
			[],
		);

		const status = commands.find((c) => c.name === 'swarm-status');
		expect(status).toBeDefined();
		await status?.execute({ sessionID: 'ses-ac4', prompt: { text: '' } });

		// Green-at-base half: the registry handler must NOT run on a host
		// without the prompt surface (side-effect-free no-op, #3169).
		expect(hookInvocations).toBe(0);

		// Discriminating half: at base the silent no-op leaves the deferred
		// warning buffer EMPTY — the command failure is invisible.
		const warnings = getDeferredWarnings();
		expect(warnings.some((w) => w.includes('swarm-status'))).toBe(true);
	}, 30000);
});
