/**
 * #3318 AC5 (DISCRIMINATING): a rejecting v2 command prompt submission must
 * record a deferred warning naming the command and the error, and the
 * `execute` call must still resolve.
 *
 * At base the rejection is swallowed into the debug-gated `log()`
 * (agents-commands.ts prompt-submission catch), so `getDeferredWarnings()`
 * is empty; `execute` resolving is the already-correct half (asserted).
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

const PROMPT_REJECTION_MESSAGE =
	'v2 prompt surface rejected submission (test double #3318 AC5)';

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

describe('#3318 AC5 — a rejected prompt submission warns and execute still resolves', () => {
	afterEach(async () => {
		clearDeferredWarnings();
		for (const dir of tempDirs.splice(0)) {
			await removeTreeWithRetry(dir);
		}
	});

	test('a rejecting ctx.session.prompt leaves execute resolved with a deferred warning naming command + error', async () => {
		clearDeferredWarnings();
		const commands: RegisteredCommand[] = [];
		let promptCalls = 0;

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
					// 2.0.26 SessionApi shape: one object input (#3169) — rejecting.
					prompt: async (_input: unknown) => {
						promptCalls += 1;
						throw new Error(PROMPT_REJECTION_MESSAGE);
					},
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
			} as V1HooksSubset,
			trackedMkdtemp('v2-3318-ac5-'),
			[],
		);

		const status = commands.find((c) => c.name === 'swarm-status');
		expect(status).toBeDefined();

		// Green-at-base half: execute must still RESOLVE (the handler's side
		// effects are done; a submission-surface error must not fail execute).
		let rejected = false;
		try {
			await status?.execute({ sessionID: 'ses-ac5', prompt: { text: '' } });
		} catch {
			rejected = true;
		}
		expect(rejected).toBe(false);
		expect(promptCalls).toBe(1);

		// Discriminating half: at base the rejection is swallowed into the
		// debug-gated log, leaving the deferred-warning buffer EMPTY.
		const warnings = getDeferredWarnings();
		expect(
			warnings.some(
				(w) =>
					w.includes('swarm-status') && w.includes(PROMPT_REJECTION_MESSAGE),
			),
		).toBe(true);
	}, 30000);
});
