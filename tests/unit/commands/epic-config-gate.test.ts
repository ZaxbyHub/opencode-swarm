/**
 * `/swarm epic` — config master gate.
 *
 *  - `start` renders the start refusal `epic-disabled-by-config` as
 *    EPIC_MODE_CONFIG_DISABLED_MESSAGE (the gate itself is tested in
 *    tests/unit/epic/start-refusals.test.ts).
 *  - `close`, `status`, `learning`, `prior` keep working with the mode gate off —
 *    a user can always inspect or close an epic. (The co-change gate and
 *    v2 declared scopes are exercised through `epic_next_wave`:
 *    tests/unit/epic/next-wave-*.test.ts.)
 *
 * Uses the `_internals` DI seam (AGENTS.md invariant 7).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _internals, handleEpicCommand } from '../../../src/commands/epic';
import { EPIC_MODE_CONFIG_DISABLED_MESSAGE } from '../../../src/epic/config-gate';

const realInternals = { ..._internals };
let config: Record<string, unknown>;

beforeEach(() => {
	config = {};
	_internals.loadPluginConfigWithMeta = (() => ({ config })) as never;
	_internals.retireLegacyEpicSessionState = (() => ({
		rowsRemoved: 0,
		activeSessions: 0,
		fileArchivedTo: null,
		errors: [],
	})) as never;
});

afterEach(() => {
	Object.assign(_internals, realInternals);
});

describe('/swarm epic start — config gate refusal rendering', () => {
	test('epic-disabled-by-config renders the remediation message', async () => {
		_internals.startEpic = (async () => ({
			status: 'refused',
			reason: 'epic-disabled-by-config',
			details: [EPIC_MODE_CONFIG_DISABLED_MESSAGE],
		})) as never;
		const out = await handleEpicCommand('/fake', ['start'], 'sess-1');
		expect(out).toBe(
			`Epic not started — **epic-disabled-by-config**.\n\n${EPIC_MODE_CONFIG_DISABLED_MESSAGE}`,
		);
	});
});

describe('/swarm epic — other subcommands work with the mode gate off', () => {
	test('`close` always works (no epic open)', async () => {
		_internals.closeEpic = (async () => ({
			status: 'no-epic',
			repairedSentinel: false,
		})) as never;
		const out = await handleEpicCommand('/fake', ['close'], 'sess-1');
		expect(out).toBe('No epic is open.');
	});

	test('status / learning / prior render without the opt-in', async () => {
		for (const sub of [[], ['status'], ['learning'], ['prior']]) {
			const out = await handleEpicCommand('/fake', sub, 'sess-1');
			expect(out).not.toContain(EPIC_MODE_CONFIG_DISABLED_MESSAGE);
			expect(out).toContain('Epic Mode');
		}
	});
});
