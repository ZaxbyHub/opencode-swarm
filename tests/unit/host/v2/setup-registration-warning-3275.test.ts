/**
 * #3318 AC3 (DISCRIMINATING): when the v2 setup's agent and command
 * registration fails (here: the injected runInit returns hooks whose `config`
 * hook throws, so no command table can exist), setup must still resolve,
 * record a deferred warning NAMING COMMAND REGISTRATION, and write the same
 * text to stderr via `console.warn`.
 *
 * At base `setup.ts` catches the per-domain registration failure and only
 * calls the debug-gated `log()`, so `getDeferredWarnings()` holds no
 * registration warning and no `console.warn` names command registration. A
 * `console.warn` about something else (e.g. the model-roster warnings) does
 * NOT satisfy the AC.
 *
 * Follows the openCodeSwarmV2Setup(ctx, { runInit }) pattern of
 * setup-wiring-3022.test.ts with a fake v2 ctx (fakes only, no mock.module);
 * console.warn is spied by plain reassignment and restored in finally.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { clearV2AgentTransformSurface } from '../../../../src/host/v2/model-apply';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../../helpers/tmpdir';

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

/** Fake v2 Context with every domain setup touches (setup-wiring-3022 shape). */
function fakeV2Ctx(directory: string): unknown {
	const registration = { dispose: async () => {} };
	const makeTransform = () => async (_fn: (editor: unknown) => void) =>
		registration;
	return {
		location: { directory },
		agent: { transform: makeTransform() },
		command: { transform: makeTransform() },
		tool: { transform: makeTransform(), hook: async () => registration },
		session: { hook: async () => registration },
		event: {},
	};
}

const isCommandRegistrationWarning = (text: string): boolean =>
	text.includes('command') && text.includes('registration');

describe('#3318 AC3 — registration failure records a command-registration warning on both surfaces', () => {
	afterEach(async () => {
		clearDeferredWarnings();
		clearV2AgentTransformSurface();
		for (const dir of tempDirs.splice(0)) {
			await removeTreeWithRetry(dir);
		}
	});

	test('a throwing config hook resolves setup, buffers a command-registration warning, and console.warns the same text', async () => {
		clearDeferredWarnings();
		const directory = trackedMkdtemp('v2-3318-ac3-');

		const originalWarn = console.warn;
		const warnTexts: string[] = [];
		console.warn = (...args: unknown[]) => {
			if (args.length > 0 && typeof args[0] === 'string')
				warnTexts.push(args[0]);
		};
		let cleanup: (() => Promise<void>) | undefined;
		try {
			// Base behavior under test: setup must RESOLVE even though the
			// config hook throws inside registerV2AgentsAndCommands.
			cleanup = await openCodeSwarmV2Setup(fakeV2Ctx(directory) as never, {
				runInit: async () =>
					({
						config: async () => {
							throw new Error(
								'synthetic config hook exploded (test double #3318 AC3)',
							);
						},
					}) as never,
			});
			await cleanup?.();
		} finally {
			console.warn = originalWarn;
		}

		expect(typeof cleanup).toBe('function');

		// The discriminating assertions: at base the buffer holds NO warning
		// naming command registration (the failure only reaches debug log).
		const warnings = getDeferredWarnings();
		const registrationWarnings = warnings.filter(isCommandRegistrationWarning);
		expect(registrationWarnings.length).toBeGreaterThan(0);

		const matchedWarn = warnTexts.find(isCommandRegistrationWarning);
		expect(matchedWarn).toBeDefined();

		// Same text on both surfaces (whitespace-insensitive: the buffer
		// sanitizes whitespace runs on write).
		const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
		expect(
			registrationWarnings.some(
				(w) => collapse(w) === collapse(matchedWarn ?? ''),
			),
		).toBe(true);
	}, 30000);
});
