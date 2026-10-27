/**
 * #3318 AC6 (DISCRIMINATING): when the command hook dispatch THROWS (not a
 * timeout), the system must still submit the expanded-template fallback AND
 * record a deferred warning naming the command.
 *
 * The throw is reachable only with an UNwrapped hook (production wraps the
 * handler in safeHook, which would swallow the throw into empty parts — the
 * existing dispatch suite documents this); the fake hook here is built that
 * way on purpose. At base the fallback arm logs only via the debug-gated
 * `log()`, so the fallback prompt IS submitted (green-at-base half) but
 * `getDeferredWarnings()` is empty (the red half).
 *
 * Fakes only (no mock.module); local fake-ctx helper following the pattern of
 * tests/unit/host/v2/command-dispatch-3169.test.ts (nothing imported from it);
 * canonicalMkdtemp project directory.
 *
 * PRODUCTION-SHAPED AMENDMENT (plan-critic finding; frozen contract): the
 * first test below drives an UNwrapped throwing hook — a shape reachable
 * only in tests. Production installs the command handler as
 * 'command.execute.before': safeHook(commandHandler) (src/index.ts ~5054),
 * and safeHook's catch (src/hooks/utils.ts) swallows a handler throw into
 * empty output — the dispatcher's own catch arm NEVER fires for a real
 * handler failure, so a fix wired only into that catch arm would be silent
 * in production. The second test wraps a throwing handler in the REAL
 * safeHook and freezes the production-shaped fix contract:
 *
 *   src/hooks/utils.ts must export
 *   getLastSwallowedCommandError(sessionID: string, command: string): string | undefined
 *
 * — a bounded per-(sessionID, command) registry into which safeHook records
 * swallowed command-handler errors (take-once or read-once semantics are
 * both acceptable). The v2 dispatcher must consult it after an empty-parts
 * dispatch and record a deferred warning naming the command AND the
 * swallowed error message. At base the second test is RED: safeHook has no
 * such registry and no warning is recorded.
 *
 * NO-FALSE-POSITIVE CONTROL (round-2 amendment; third test): a legitimately
 * EMPTY dispatch — a safeHook-wrapped handler that RESOLVES writing nothing,
 * with NO thrown error — must degrade to the expanded-template fallback (the
 * designed degradation) while recording NO warning naming the command and
 * leaving NOTHING in the swallowed-error registry for that (sessionID,
 * command). At base the no-warning half is GREEN (base never warns); the
 * registry half is RED via the missing-export typeof check, so the whole
 * test is red at base for the same missing-seam reason as the second test.
 *
 * The registry LIFECYCLE contract itself (recording, keying, bounded
 * eviction, read-once, cleanup export) is frozen in the NON-frozen
 * production-code test file
 * tests/unit/hooks/utils-swallowed-command-error-registry.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { safeHook } from '../../../../src/hooks/utils';
import { registerV2AgentsAndCommands } from '../../../../src/host/v2/agents-commands';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';
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

describe('#3318 AC6 — a throwing hook dispatch submits the fallback and warns', () => {
	afterEach(async () => {
		clearDeferredWarnings();
		for (const dir of tempDirs.splice(0)) {
			await removeTreeWithRetry(dir);
		}
	});

	test('an unwrapped throwing command.execute.before falls back to the template AND records a warning', async () => {
		clearDeferredWarnings();
		const commands: RegisteredCommand[] = [];
		const prompts: RecordedPrompt[] = [];
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
					prompt: async (input: unknown) => {
						prompts.push(input as RecordedPrompt);
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
				// Deliberately UNwrapped (production safeHook would swallow this
				// throw into empty parts): the raw throw must degrade to the
				// template fallback AND now be operator-visible.
				'command.execute.before': async () => {
					hookInvocations += 1;
					throw new Error('hook dispatch exploded (test double #3318 AC6)');
				},
			} as V1HooksSubset,
			trackedMkdtemp('v2-3318-ac6-'),
			[],
		);

		const status = commands.find((c) => c.name === 'swarm-status');
		expect(status).toBeDefined();
		await status?.execute({ sessionID: 'ses-ac6', prompt: { text: '' } });

		// Green-at-base half: the dispatch RAN and degraded to the expanded
		// template fallback (never skipped, never thrown on).
		expect(hookInvocations).toBe(1);
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('/swarm status');

		// Discriminating half: at base the fallback arm logs only through the
		// debug-gated log — the deferred-warning buffer is EMPTY.
		const warnings = getDeferredWarnings();
		expect(warnings.some((w) => w.includes('swarm-status'))).toBe(true);
	}, 30000);

	test('safeHook-wrapped handler failure still warns with fallback', async () => {
		clearDeferredWarnings();
		const commands: RegisteredCommand[] = [];
		const prompts: RecordedPrompt[] = [];
		let hookInvocations = 0;

		// PRODUCTION shape (src/index.ts ~5054): the handler is installed as
		// safeHook(commandHandler) — single argument. safeHook's catch
		// swallows the throw and resolves, leaving the dispatcher's
		// output.parts EMPTY, so the dispatcher's own catch arm never fires
		// and the empty-parts fallback arm carries the degradation.
		const throwingCommandHandler = async (
			_input: unknown,
			_output: unknown,
		): Promise<void> => {
			hookInvocations += 1;
			throw new Error('safeHook-swallowed command handler failure 3318-AC6b');
		};

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
						'swarm-status': {
							template: '/swarm status',
							description: 'swarm status',
						},
					};
				},
				// The REAL production wrapper: safeHook(fn). The inner throw is
				// caught inside safeHook (debug-gated warn only) and the hook
				// RESOLVES with the dispatcher's output.parts still empty.
				'command.execute.before': safeHook(throwingCommandHandler),
			} as V1HooksSubset,
			trackedMkdtemp('v2-3318-ac6b-'),
			[],
		);

		const status = commands.find((c) => c.name === 'swarm-status');
		expect(status).toBeDefined();
		await status?.execute({ sessionID: 'ses-ac6b', prompt: { text: '' } });

		// Frozen (a) — green at base: the swallowed failure still submits the
		// expanded-template fallback prompt (empty parts === fallback).
		expect(hookInvocations).toBe(1);
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('/swarm status');

		// Frozen (b) — RED at base: a REAL (safeHook-swallowed) handler
		// failure must be operator-visible as a deferred warning naming the
		// command AND the swallowed error message. At base safeHook has no
		// registry and the dispatcher records nothing.
		const warnings = getDeferredWarnings();
		expect(
			warnings.some(
				(w) =>
					w.includes('swarm-status') &&
					w.includes('safeHook-swallowed command handler failure 3318-AC6b'),
			),
		).toBe(true);

		// Frozen-contract shape check (post-fix only — unreachable at base
		// because the assertion above already failed): the warning is fed by
		// the bounded per-(sessionID, command) registry the fix must export
		// from src/hooks/utils.ts. Presence ONLY — never invoked here, so
		// take-once semantics stay unconsumed for the dispatcher's own read.
		const hooksUtils = await import('../../../../src/hooks/utils');
		expect(
			typeof (hooksUtils as unknown as Record<string, unknown>)
				.getLastSwallowedCommandError,
		).toBe('function');
	}, 30000);

	test('legitimate empty dispatch stays silent (no false positive)', async () => {
		clearDeferredWarnings();
		const commands: RegisteredCommand[] = [];
		const prompts: RecordedPrompt[] = [];
		let hookInvocations = 0;

		// A legitimately EMPTY dispatch: the safeHook-wrapped handler RESOLVES
		// writing nothing and throws NOTHING (e.g. a plugin with nothing to add
		// for this invocation). This is the designed empty-parts case, NOT a
		// failure — it must degrade to the template fallback WITHOUT any
		// warning or registry entry.
		const quietCommandHandler = async (
			_input: unknown,
			_output: unknown,
		): Promise<void> => {
			hookInvocations += 1;
		};

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
						'swarm-status': {
							template: '/swarm status',
							description: 'swarm status',
						},
					};
				},
				'command.execute.before': safeHook(quietCommandHandler),
			} as V1HooksSubset,
			trackedMkdtemp('v2-3318-ac6c-'),
			[],
		);

		const status = commands.find((c) => c.name === 'swarm-status');
		expect(status).toBeDefined();
		await status?.execute({ sessionID: 'ses-ac6c', prompt: { text: '' } });

		// Green-at-base half: the legitimately-empty dispatch still submits
		// the expanded-template fallback (the DESIGNED degradation — empty
		// parts === fallback).
		expect(hookInvocations).toBe(1);
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('/swarm status');

		// Green-at-base half: NO warning names the command (base never warns;
		// the fix must keep it that way for a legitimate empty dispatch).
		const warnings = getDeferredWarnings();
		expect(warnings.some((w) => w.includes('swarm-status'))).toBe(false);

		// RED-at-base half (the discriminator): the swallowed-error registry
		// export must exist (typeof guard fails at base — safeHook has no
		// registry yet) and hold NOTHING for this (sessionID, command): a
		// resolved-without-throw handler must never be recorded.
		const hooksUtils = await import('../../../../src/hooks/utils');
		const getLastSwallowedCommandError = (
			hooksUtils as unknown as Record<string, unknown>
		)['getLastSwallowedCommandError'];
		expect(typeof getLastSwallowedCommandError).toBe('function');
		expect(
			(
				getLastSwallowedCommandError as (
					sessionID: string,
					command: string,
				) => string | undefined
			)('ses-ac6c', 'swarm-status'),
		).toBeUndefined();
	}, 30000);
});
