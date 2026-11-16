/**
 * #2910 W6 implementation-phase control for the safeHook swallowed-command-
 * error registry (#3318 AC6): the STALE-ENTRY and LIFECYCLE controls the
 * frozen checks do not carry.
 *
 *  - Stale-entry control: seed the registry with an unread entry for
 *    (sessionID, command), then run a dispatch for the SAME pair whose
 *    safeHook-wrapped handler RESOLVES with real output (non-empty parts).
 *    The dispatch must use the handler's output (never the fallback), record
 *    NO warning naming the command, and leave the seeded entry untouched
 *    (read-once consumption belongs to a real empty-parts consult only).
 *  - PRR-002 (swarm-pr-review pr3444-20261025): setup cleanup does NOT clear
 *    the process-global registry anymore — the registry is bounded FIFO
 *    (64, explicit eviction — the invariant-8 strategy), and a global clear
 *    at cleanup would wipe an overlapping live instance's unread entries.
 *    Bounded-state proof: after MORE than 64 recordings the OLDEST entries
 *    are evicted, with no cleanup involved.
 *  - PRR-006: timeout residue — a dispatch that times out (dispatch budget
 *    pinned small through _internals.dispatchTimeoutMs) leaves its
 *    still-running handler's LATE throw recorded in the registry; a LATER
 *    legit-empty dispatch for the same key must NOT warn on that residue
 *    (the consult filters records older than its own dispatch start).
 *
 * Fakes only (no mock.module); the REAL safeHook and the REAL
 * registerV2AgentsAndCommands / openCodeSwarmV2Setup drive the legs.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	clearSwallowedCommandErrorRegistry,
	getLastSwallowedCommandError,
	safeHook,
} from '../../../../src/hooks/utils';
import {
	_internals as dispatcherInternals,
	registerV2AgentsAndCommands,
} from '../../../../src/host/v2/agents-commands';
import { clearV2AgentTransformSurface } from '../../../../src/host/v2/model-apply';
import { openCodeSwarmV2Setup } from '../../../../src/host/v2/setup';
import type { V1HooksSubset } from '../../../../src/host/v2/types';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';
import { resetSwarmState } from '../../../../src/state';
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

const STALE_SESSION = 'ses-2910-stale';
const STALE_COMMAND = 'swarm-status';
const STALE_MESSAGE = 'stale swallowed failure 2910 (prior run residue)';
/** Production dispatch budget (300 s), captured once for seam restoration. */
const PRODUCTION_DISPATCH_TIMEOUT_MS = dispatcherInternals.dispatchTimeoutMs;

const tempDirs: string[] = [];

function trackedMkdtemp(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	tempDirs.push(dir);
	return dir;
}

/** Seed one unread registry entry via the REAL safeHook catch arm. */
async function seedStaleEntry(): Promise<void> {
	const throwingHandler = async (): Promise<void> => {
		throw new Error(STALE_MESSAGE);
	};
	await safeHook(throwingHandler)(
		{
			sessionID: STALE_SESSION,
			command: STALE_COMMAND,
			arguments: '',
		} as never,
		{ parts: [] } as never,
	);
}

afterEach(async () => {
	dispatcherInternals.dispatchTimeoutMs = PRODUCTION_DISPATCH_TIMEOUT_MS;
	clearSwallowedCommandErrorRegistry();
	clearDeferredWarnings();
	clearV2AgentTransformSurface();
	resetSwarmState();
	for (const dir of tempDirs.splice(0)) {
		await removeTreeWithRetry(dir);
	}
});

describe('#2910 W6 stale-entry control for the swallowed-command-error registry', () => {
	test('an unread stale entry does not warn on or alter a fresh successful dispatch (read-once intact)', async () => {
		clearSwallowedCommandErrorRegistry();
		clearDeferredWarnings();
		await seedStaleEntry();
		expect(getLastSwallowedCommandError(STALE_SESSION, STALE_COMMAND)).toBe(
			STALE_MESSAGE,
		);
		// Re-seed: the assertion above consumed the entry (read-once) — the
		// control needs the entry PRESENT during the dispatch.
		await seedStaleEntry();

		const commands: RegisteredCommand[] = [];
		const prompts: RecordedPrompt[] = [];
		let hookInvocations = 0;
		// Production shape: the handler is safeHook-wrapped and RESOLVES with
		// real output (non-empty parts) — nothing fails in this dispatch.
		const cleanHandler = async (
			_input: unknown,
			output: { parts: unknown[] },
		): Promise<void> => {
			hookInvocations += 1;
			output.parts.splice(0, output.parts.length, {
				type: 'text',
				text: 'REAL-OUTPUT-2910',
			});
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
						'swarm-status': {
							template: '/swarm status',
							description: 'swarm status',
						},
					};
				},
				'command.execute.before': safeHook(cleanHandler),
			} as unknown as V1HooksSubset,
			trackedMkdtemp('v2-2910-stale-'),
			[],
		);

		const status = commands.find((c) => c.name === STALE_COMMAND);
		expect(status).toBeDefined();
		await status?.execute({ sessionID: STALE_SESSION, prompt: { text: '' } });

		// The dispatched prompt was used (never the template fallback).
		expect(hookInvocations).toBe(1);
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toBe('REAL-OUTPUT-2910');

		// The stale entry produced NO warning naming the command.
		const warnings = getDeferredWarnings();
		expect(warnings.some((w) => w.includes(STALE_COMMAND))).toBe(false);

		// Read-once intact: a non-empty-parts dispatch never consults the
		// registry, so the seeded entry survives untouched for a real consumer.
		expect(getLastSwallowedCommandError(STALE_SESSION, STALE_COMMAND)).toBe(
			STALE_MESSAGE,
		);
	}, 30_000);
});

describe('#2910 W6 the registry stays bounded WITHOUT cleanup (PRR-002)', () => {
	test('setup cleanup does NOT clear the registry (owner isolation beats the global clear)', async () => {
		clearSwallowedCommandErrorRegistry();
		clearDeferredWarnings();
		await seedStaleEntry();

		const directory = trackedMkdtemp('v2-2910-noclear-');
		const registration = { dispose: async () => {} };
		const makeTransform = () => async (_fn: (editor: unknown) => void) =>
			registration;
		const ctx = {
			location: { directory },
			agent: { transform: makeTransform() },
			command: { transform: makeTransform() },
			tool: { transform: makeTransform(), hook: async () => registration },
			session: { hook: async () => registration },
			event: {},
		};
		const cleanup = await openCodeSwarmV2Setup(ctx as never, {
			runInit: async () =>
				({
					config: (c: Record<string, unknown>) => {
						c.agent = {};
						c.command = {};
					},
					dispose: async () => {},
				}) as never,
		});
		await cleanup();

		// Post-PRR-002 contract: cleanup no longer clears the process-global
		// registry — an overlapping live instance's unread entries survive
		// another instance's cleanup (bounded FIFO keeps it safe instead).
		expect(getLastSwallowedCommandError(STALE_SESSION, STALE_COMMAND)).toBe(
			STALE_MESSAGE,
		);
	}, 30_000);

	test('bounded state: more than 64 recordings evict the OLDEST — no cleanup needed', async () => {
		clearSwallowedCommandErrorRegistry();
		// 65 recordings (bound 64): index 0 is the oldest and MUST be evicted
		// by the explicit FIFO eviction, proving the registry's own invariant-8
		// strategy — the property that made the cleanup-time global clear
		// unnecessary (PRR-002) and harmful across instances.
		for (let i = 0; i <= 64; i += 1) {
			const throwingHandler = async (): Promise<void> => {
				throw new Error(`bounded-eviction boom ${i}`);
			};
			await safeHook(throwingHandler)(
				{ sessionID: `ses-bounded-${i}`, command: `cmd-bounded-${i}` } as never,
				{ parts: [] } as never,
			);
		}
		expect(
			getLastSwallowedCommandError('ses-bounded-0', 'cmd-bounded-0'),
		).toBeUndefined();
		expect(
			getLastSwallowedCommandError('ses-bounded-64', 'cmd-bounded-64'),
		).toBe('bounded-eviction boom 64');
	}, 30_000);
});

describe('#2910 W6 timeout residue does not poison a later same-key dispatch (PRR-006)', () => {
	test('dispatch 1 times out, its late throw records, dispatch 2 legit-empty stays silent', async () => {
		clearSwallowedCommandErrorRegistry();
		clearDeferredWarnings();
		// Pin the dispatch budget small so the timeout arm is reachable fast
		// (declared _internals seam; restored in afterEach).
		dispatcherInternals.dispatchTimeoutMs = 50;

		const commands: RegisteredCommand[] = [];
		const prompts: RecordedPrompt[] = [];
		const lateThrowHandler = async (): Promise<void> => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			throw new Error('LATE-FAILURE-2910');
		};
		const legitEmptyHandler = async (): Promise<void> => {
			// Resolves having written NO parts — the legitimately-empty shape.
		};

		const register = async (handler: () => Promise<void>): Promise<void> => {
			commands.length = 0;
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
							'swarm-status': {
								template: '/swarm status',
								description: 'swarm status',
							},
						};
					},
					'command.execute.before': safeHook(handler),
				} as unknown as V1HooksSubset,
				trackedMkdtemp('v2-2910-timeout-residue-'),
				[],
			);
		};

		// DISPATCH 1: times out at ~50 ms; the handler is STILL RUNNING and
		// throws at ~300 ms — its swallowed record lands AFTER dispatch 1
		// already returned (the residue class, review PRR-006).
		await register(lateThrowHandler);
		const status = commands.find((c) => c.name === STALE_COMMAND);
		expect(status).toBeDefined();
		await status?.execute({
			sessionID: STALE_SESSION,
			prompt: { text: '' },
		});
		// The timeout arm submitted its bounded notice (dispatch 1's only
		// prompt) and returned without consulting the registry.
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.text).toContain('dispatch exceeded its');

		// Let the late throw land and be recorded.
		await new Promise((resolve) => setTimeout(resolve, 450));

		// DISPATCH 2: legitimately empty parts for the SAME (session, key).
		// Pre-PRR-006 this consult saw dispatch 1's residue and emitted a
		// FALSE "handler failed" warning; the consult now filters records
		// older than its own dispatch start (consume-and-ignore).
		await register(legitEmptyHandler);
		const status2 = commands.find((c) => c.name === STALE_COMMAND);
		expect(status2).toBeDefined();
		await status2?.execute({
			sessionID: STALE_SESSION,
			prompt: { text: '' },
		});
		const warnings = getDeferredWarnings();
		expect(
			warnings.some((w) => w.includes('LATE-FAILURE-2910')),
			`no false warning on stale residue; got: ${JSON.stringify(warnings)}`,
		).toBe(false);
		// The fallback was submitted for the legit-empty dispatch.
		expect(prompts.length).toBe(2);
		expect(prompts[1]?.text).toBe('/swarm status');

		// CONTROL (residue was really recorded): one more timed-out dispatch
		// leaves a fresh late record; a DIRECT read (no sinceMs filter)
		// returns it — proving the filtering above was the dispatcher's
		// staleness gate, not a missing record.
		await register(lateThrowHandler);
		const status3 = commands.find((c) => c.name === STALE_COMMAND);
		await status3?.execute({
			sessionID: STALE_SESSION,
			prompt: { text: '' },
		});
		await new Promise((resolve) => setTimeout(resolve, 450));
		expect(getLastSwallowedCommandError(STALE_SESSION, STALE_COMMAND)).toBe(
			'LATE-FAILURE-2910',
		);
	}, 30_000);
});
