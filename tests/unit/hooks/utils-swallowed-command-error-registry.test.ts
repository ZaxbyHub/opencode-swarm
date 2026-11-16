/**
 * #3318 AC6 swallowed-command-error registry — LIFECYCLE contract tests for
 * the planned src/hooks/utils.ts exports (plan-critic round 2 split these
 * out of the frozen discriminating check
 * tests/unit/host/v2/command-dispatch-failure-warning-3275.test.ts, which
 * freezes only the dispatcher-side warning behavior). This file is a
 * PRODUCTION-CODE test — frozen as DISCRIMINATING check C28 (manifest row + AC27).
 *
 * DECLARED CONTRACT (binding for the implementer):
 *   - src/hooks/utils.ts exports
 *       getLastSwallowedCommandError(sessionID: string, command: string): string | undefined
 *       clearSwallowedCommandErrorRegistry(): void
 *   - The RECORDING side is safeHook itself (src/hooks/utils.ts): when a
 *     wrapped handler throws AND the hook input is command-hook-shaped —
 *     { sessionID, command, arguments }, the v1 `command.execute.before`
 *     payload built in src/host/v2/agents-commands.ts
 *     (deferredV2ExecuteSwarmCommand) and installed in production as
 *     safeHook(commandHandler) at src/index.ts — the swallowed error message
 *     is recorded keyed by the exact (sessionID, command) pair.
 *   - BOUND: the registry holds AT MOST 64 entries; inserting one more
 *     evicts the OLDEST (FIFO) — bounded module-global state per AGENTS.md
 *     invariant 8.
 *   - READ-ONCE (pinned here): a successful read consumes the entry — a
 *     second read for the same (sessionID, command) returns undefined. The
 *     v2 dispatcher is the sole designed reader; read-once keeps a repeated
 *     empty-parts dispatch from re-warning a stale failure.
 *   - clearSwallowedCommandErrorRegistry() empties the registry (test
 *     isolation and session teardown).
 *
 * ALL arms fail at base on the MISSING EXPORTS: each test first passes a
 * typeof guard over both exports and otherwise throws a MISSING SEAM error
 * naming them (convention:
 * tests/unit/host/v2/setup-registration-budget-fakeclock-3327.test.ts).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as hooksUtils from '../../../src/hooks/utils';

/** Declared registry bound (see header contract note). */
const REGISTRY_BOUND = 64;

type GetLastSwallowedCommandError = (
	sessionID: string,
	command: string,
) => string | undefined;
type ClearSwallowedCommandErrorRegistry = () => void;

function requireRegistry(): {
	getLast: GetLastSwallowedCommandError;
	clear: ClearSwallowedCommandErrorRegistry;
} {
	const exports_ = hooksUtils as unknown as Record<string, unknown>;
	const getLast = exports_.getLastSwallowedCommandError;
	const clear = exports_.clearSwallowedCommandErrorRegistry;
	if (typeof getLast !== 'function' || typeof clear !== 'function') {
		throw new Error(
			`MISSING SEAM: src/hooks/utils.ts does not export getLastSwallowedCommandError(sessionID, command) and clearSwallowedCommandErrorRegistry() (#3318 AC6 declared seam — safeHook must record swallowed command-handler errors into a bounded per-(sessionID, command) read-once registry); got getLastSwallowedCommandError=${typeof getLast}, clearSwallowedCommandErrorRegistry=${typeof clear}`,
		);
	}
	return {
		getLast: getLast as GetLastSwallowedCommandError,
		clear: clear as ClearSwallowedCommandErrorRegistry,
	};
}

/**
 * Drive the REAL safeHook with a throwing handler and a command-hook-shaped
 * input — the exact production failure shape (handler throws inside
 * safeHook's catch, which swallows it into a resolved empty-parts hook).
 */
async function swallowThrow(
	sessionID: string,
	command: string,
	message: string,
): Promise<void> {
	const handler = async (): Promise<void> => {
		throw new Error(message);
	};
	await hooksUtils.safeHook(handler)(
		{ sessionID, command, arguments: '' } as never,
		{ parts: [] } as never,
	);
}

describe('src/hooks/utils swallowed-command-error registry (#3318 AC6 declared seam)', () => {
	afterEach(() => {
		// The registry is module-global state: empty it between tests so the
		// eviction/keying arms stay independent (AGENTS.md invariant 8). At
		// base the export is missing — nothing recorded, nothing to clear.
		const clear = (hooksUtils as unknown as Record<string, unknown>)
			.clearSwallowedCommandErrorRegistry;
		if (typeof clear === 'function') {
			(clear as ClearSwallowedCommandErrorRegistry)();
		}
	});

	test('recording: a safeHook-swallowed throw is readable via getLastSwallowedCommandError (base: MISSING SEAM -> red)', async () => {
		const { getLast } = requireRegistry();
		await swallowThrow('ses-rec', 'swarm-status', 'registry recording boom');
		expect(getLast('ses-rec', 'swarm-status')).toBe('registry recording boom');
	});

	test('keying: entries are isolated per (sessionID, command) pair (base: MISSING SEAM -> red)', async () => {
		const { getLast } = requireRegistry();
		await swallowThrow('ses-key', 'swarm-status', 'registry keying boom');
		// Different session, same command -> nothing.
		expect(getLast('ses-other', 'swarm-status')).toBeUndefined();
		// Same session, different command -> nothing.
		expect(getLast('ses-key', 'swarm-review')).toBeUndefined();
		// The misses above consumed nothing — the seeded entry is untouched.
		expect(getLast('ses-key', 'swarm-status')).toBe('registry keying boom');
	});

	test('bounded eviction: exceeding the declared bound of 64 evicts the OLDEST entry (base: MISSING SEAM -> red)', async () => {
		const { getLast } = requireRegistry();
		for (let i = 0; i <= REGISTRY_BOUND; i += 1) {
			await swallowThrow(`ses-evict-${i}`, `cmd-evict-${i}`, `evict boom ${i}`);
		}
		// Inserting entry bound+1 evicted the OLDEST (index 0)...
		expect(getLast('ses-evict-0', 'cmd-evict-0')).toBeUndefined();
		// ...while the NEWEST (index bound) is retained. Probing the evicted
		// oldest first is safe: a miss consumes nothing (read-once only
		// consumes a SUCCESSFUL read).
		expect(
			getLast(`ses-evict-${REGISTRY_BOUND}`, `cmd-evict-${REGISTRY_BOUND}`),
		).toBe(`evict boom ${REGISTRY_BOUND}`);
	});

	test('read-once: a second read for the same (sessionID, command) returns undefined (base: MISSING SEAM -> red)', async () => {
		const { getLast } = requireRegistry();
		await swallowThrow('ses-ro', 'swarm-status', 'read-once boom');
		expect(getLast('ses-ro', 'swarm-status')).toBe('read-once boom');
		expect(getLast('ses-ro', 'swarm-status')).toBeUndefined();
	});

	test('cleanup: clearSwallowedCommandErrorRegistry() empties the registry (base: MISSING SEAM -> red)', async () => {
		const { getLast, clear } = requireRegistry();
		await swallowThrow('ses-clean', 'swarm-status', 'cleanup boom');
		clear();
		// Seeded but NEVER read before the clear: without the clear this read
		// would return the message (read-once consumes only on READ) —
		// undefined proves the clear emptied the registry.
		expect(getLast('ses-clean', 'swarm-status')).toBeUndefined();
	});
});
