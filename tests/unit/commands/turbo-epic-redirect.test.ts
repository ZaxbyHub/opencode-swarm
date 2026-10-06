/**
 * Epic v2 — `/swarm turbo` no longer combines with Epic Mode.
 *
 *  - `/swarm turbo epic [on|off]` and bare `/swarm turbo epic` reply with a
 *    redirect to `/swarm epic start` and change NO state (no session flag,
 *    no Lean run state, no Epic durable state).
 *  - While an Epic is open for the project, every Turbo-ENABLING invocation
 *    is refused with `epic-open` before any state changes; disabling Turbo
 *    stays available.
 *
 * The open-epic probe is injected through `turbo._internals` (DI seam, no
 * `mock.module`).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	handleTurboCommand,
	TURBO_EPIC_OPEN_REFUSAL,
	TURBO_EPIC_REDIRECT_MESSAGE,
} from '../../../src/commands/turbo';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'sess-turbo-epic-redirect';
const realLoader = _internals.loadPluginConfigWithMeta;
const realProbe = _internals.isEpicOpenForProject;

let tmpDir: string;
let restoreClock: Restore | null = null;
let epicOpen = false;
const probe = mock((_dir: string) => epicOpen);

function session() {
	const s = swarmState.agentSessions.get(SESSION_ID);
	if (!s) throw new Error('session missing');
	return s;
}

function flags() {
	const s = session();
	return {
		turboMode: s.turboMode,
		turboStrategy: s.turboStrategy,
		leanTurboActive: s.leanTurboActive,
		leanTurboCurrentPhase: s.leanTurboCurrentPhase,
	};
}

function swarmEntries(): string[] {
	const root = path.join(tmpDir, '.swarm');
	return fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
}

function useConfig(config: Record<string, unknown>): void {
	_internals.loadPluginConfigWithMeta = (() => ({
		config,
		loadedFromFile: false,
	})) as unknown as typeof _internals.loadPluginConfigWithMeta;
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-01-01T00:00:00.000Z' });
	epicOpen = false;
	probe.mockClear();
	_internals.isEpicOpenForProject = probe;
	useConfig({});
	tmpDir = canonicalMkdtemp('turbo-epic-redirect-');
	startAgentSession(SESSION_ID, 'architect');
});

afterEach(() => {
	_internals.loadPluginConfigWithMeta = realLoader;
	_internals.isEpicOpenForProject = realProbe;
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

describe('`/swarm turbo epic*` is a redirect with no state change', () => {
	test.each([
		[['epic', 'on']],
		[['epic', 'off']],
		[['epic']],
		[['EPIC', 'ON']],
		[['epic', '']],
	])('%j → redirect, nothing written', async (args) => {
		const before = flags();
		const out = await handleTurboCommand(tmpDir, args, SESSION_ID);
		expect(out).toBe(TURBO_EPIC_REDIRECT_MESSAGE);
		expect(out).toContain('/swarm epic start');
		expect(out).toContain('neither Lean nor Turbo');
		expect(out).toContain('per-task QA is never waived');
		expect(flags()).toEqual(before);
		expect(swarmEntries()).toEqual([]);
	});

	test('redirect leaves an already-active Turbo untouched', async () => {
		await handleTurboCommand(tmpDir, ['standard', 'on'], SESSION_ID);
		const before = flags();
		expect(before.turboMode).toBe(true);
		for (const args of [['epic', 'off'], ['epic']]) {
			expect(await handleTurboCommand(tmpDir, args, SESSION_ID)).toBe(
				TURBO_EPIC_REDIRECT_MESSAGE,
			);
		}
		expect(flags()).toEqual(before);
	});

	test('redirect applies even when Epic is enabled in config', async () => {
		useConfig({ turbo: { epic: { mode: { enabled: true } } } });
		const out = await handleTurboCommand(tmpDir, ['epic', 'on'], SESSION_ID);
		expect(out).toBe(TURBO_EPIC_REDIRECT_MESSAGE);
		expect(session().turboMode).toBe(false);
		expect(swarmEntries()).toEqual([]);
	});

	test('an unknown epic sub-argument keeps the #2493 unknown-argument rejection', async () => {
		const out = await handleTurboCommand(
			tmpDir,
			['epic', 'sideways'],
			SESSION_ID,
		);
		expect(out).toStartWith('Unknown turbo argument "sideways"');
		expect(session().turboMode).toBe(false);
	});
});

describe('Turbo enable refused while an Epic is open (epic-open)', () => {
	test.each([
		[['on']],
		[[]],
		[['standard', 'on']],
		[['standard']],
		[['lean', 'on']],
		[['lean']],
	])('%j → refused, no state change', async (args) => {
		epicOpen = true;
		const out = await handleTurboCommand(tmpDir, args, SESSION_ID);
		expect(out).toBe(TURBO_EPIC_OPEN_REFUSAL);
		expect(out).toContain(
			'epic-open: close the epic first (/swarm epic close)',
		);
		expect(probe).toHaveBeenCalledWith(tmpDir);
		expect(flags()).toEqual({
			turboMode: false,
			turboStrategy: undefined,
			leanTurboActive: false,
			leanTurboCurrentPhase: undefined,
		});
		// Lean refusal happens before the durable run-state write.
		expect(swarmEntries()).toEqual([]);
	});

	test('`on` is refused even when config selects the lean strategy', async () => {
		epicOpen = true;
		useConfig({ turbo: { strategy: 'lean' } });
		expect(await handleTurboCommand(tmpDir, ['on'], SESSION_ID)).toBe(
			TURBO_EPIC_OPEN_REFUSAL,
		);
		expect(session().leanTurboActive).toBe(false);
		expect(swarmEntries()).toEqual([]);
	});

	test('disabling Turbo still works while an Epic is open', async () => {
		await handleTurboCommand(tmpDir, ['standard', 'on'], SESSION_ID);
		epicOpen = true;
		probe.mockClear();
		expect(await handleTurboCommand(tmpDir, ['off'], SESSION_ID)).toBe(
			'Turbo Mode disabled',
		);
		expect(session().turboMode).toBe(false);
		// Off paths never consult the probe.
		expect(probe).not.toHaveBeenCalled();
	});

	test('toggle-off of an active Turbo is not refused while an Epic is open', async () => {
		await handleTurboCommand(tmpDir, ['standard', 'on'], SESSION_ID);
		epicOpen = true;
		expect(await handleTurboCommand(tmpDir, [], SESSION_ID)).toBe(
			'Turbo Mode disabled',
		);
		expect(session().turboMode).toBe(false);
	});

	test('status is never refused', async () => {
		epicOpen = true;
		expect(await handleTurboCommand(tmpDir, ['status'], SESSION_ID)).toBe(
			'Turbo: off',
		);
		expect(probe).not.toHaveBeenCalled();
	});

	test('with no open Epic the enable paths proceed and consult the probe once', async () => {
		const out = await handleTurboCommand(tmpDir, ['on'], SESSION_ID);
		expect(out).toStartWith('Turbo Mode enabled.');
		expect(probe).toHaveBeenCalledTimes(1);
		expect(session().turboMode).toBe(true);
	});
});
