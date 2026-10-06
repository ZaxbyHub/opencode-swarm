/**
 * Epic v2 — non-Epic `/swarm turbo` invocations are byte-identical to
 * upstream (pre-Epic-v2) replies and session flags.
 *
 * The expected replies below are the exact strings upstream `turbo.ts`
 * (upstream/main 17d4d538c) returns for the same sequences, captured with
 * the scratch probe against a pristine upstream worktree. The only durable
 * difference is intentional: upstream's Turbo-off path also wrote an
 * inactive Epic v1 session row (`.swarm/epic-state.json` + a
 * `turbo.epic.session` coordination row); Epic v2 has no per-session Epic
 * rows, so Turbo never writes Epic state.
 *
 * Uses the REAL open-epic probe (no Epic sentinel in the temp project).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, handleTurboCommand } from '../../../src/commands/turbo';
import { TURBO_BYPASS_DISCLOSURE } from '../../../src/commands/turbo-constants';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const ON = `Turbo Mode enabled. ${TURBO_BYPASS_DISCLOSURE}`;
const ON_STANDARD = `Turbo Mode enabled (standard). ${TURBO_BYPASS_DISCLOSURE}`;
const OFF = 'Turbo Mode disabled';
const LEAN_ON =
	`Lean Turbo enabled. ${TURBO_BYPASS_DISCLOSURE} ` +
	'Per-lane: reviewer gates and file-lock conflict detection. ' +
	'(maxParallelCoders=4, conflict_policy=serialize, Full-Auto: inactive)';
const BOGUS =
	'Unknown turbo argument "bogus". Turbo state is unchanged.\n' +
	'Valid arguments: (none) | on | off | status | lean [on|off] | standard [on|off] | epic [on|off].\n' +
	'Run `/swarm help` for details.';

const realLoader = _internals.loadPluginConfigWithMeta;
let tmpDir: string;
let sid: string;
let sidCounter = 0;
let restoreClock: Restore | null = null;

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-01-01T00:00:00.000Z' });
	_internals.loadPluginConfigWithMeta = (() => ({
		config: {},
		loadedFromFile: false,
	})) as unknown as typeof _internals.loadPluginConfigWithMeta;
	tmpDir = canonicalMkdtemp('turbo-upstream-parity-');
	sidCounter += 1;
	sid = `sess-turbo-parity-${sidCounter}`;
	startAgentSession(sid, 'architect');
});

afterEach(() => {
	_internals.loadPluginConfigWithMeta = realLoader;
	resetSwarmState();
	closeAllProjectDbs();
	restoreClock?.();
	restoreClock = null;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup on Windows file-lock races.
	}
});

async function run(seq: string[][]): Promise<string[]> {
	const outs: string[] = [];
	for (const args of seq)
		outs.push(await handleTurboCommand(tmpDir, args, sid));
	return outs;
}

function flags() {
	const s = swarmState.agentSessions.get(sid);
	return {
		turboMode: s?.turboMode,
		turboStrategy: s?.turboStrategy,
		leanTurboActive: s?.leanTurboActive,
	};
}

function assertNoEpicState(): void {
	expect(fs.existsSync(path.join(tmpDir, '.swarm', 'epic-state.json'))).toBe(
		false,
	);
	expect(
		fs.existsSync(path.join(tmpDir, '.swarm', 'epic-state.json.imported')),
	).toBe(false);
	expect(fs.existsSync(path.join(tmpDir, '.swarm', 'epic'))).toBe(false);
}

describe('non-Epic /swarm turbo replies are identical to upstream', () => {
	test('standard on/off/toggle sequence (incl. lean toggle and unknown arg)', async () => {
		const outs = await run([
			['on'],
			['off'],
			['standard', 'on'],
			['standard'],
			[],
			[],
			['lean'],
			['bogus'],
			['off'],
			['off'],
		]);
		expect(outs).toEqual([
			ON,
			OFF,
			ON_STANDARD,
			OFF,
			ON,
			OFF,
			LEAN_ON,
			BOGUS,
			OFF,
			OFF,
		]);
		expect(flags()).toEqual({
			turboMode: false,
			turboStrategy: undefined,
			leanTurboActive: false,
		});
		assertNoEpicState();
	});

	test('lean on/off/toggle then standard toggle sequence', async () => {
		const outs = await run([
			['lean', 'on'],
			['off'],
			['lean'],
			['lean'],
			['standard'],
			['standard', 'off'],
		]);
		expect(outs).toEqual([LEAN_ON, OFF, LEAN_ON, OFF, ON_STANDARD, OFF]);
		expect(flags()).toEqual({
			turboMode: false,
			turboStrategy: undefined,
			leanTurboActive: false,
		});
		assertNoEpicState();
	});

	test('switching lean → standard keeps the plain upstream reply', async () => {
		const outs = await run([['lean', 'on'], ['standard', 'on'], ['status']]);
		expect(outs).toEqual([
			LEAN_ON,
			ON_STANDARD,
			'Turbo: standard (turboMode=true)',
		]);
		expect(flags()).toEqual({
			turboMode: true,
			turboStrategy: 'standard',
			leanTurboActive: false,
		});
		assertNoEpicState();
	});

	test('Turbo off on a never-Turbo session writes nothing at all', async () => {
		expect(await run([['off'], ['standard', 'off'], ['lean', 'off']])).toEqual([
			OFF,
			OFF,
			OFF,
		]);
		expect(fs.existsSync(path.join(tmpDir, '.swarm'))).toBe(false);
	});
});
