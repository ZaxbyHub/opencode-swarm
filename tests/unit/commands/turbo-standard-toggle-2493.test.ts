/**
 * Turbo bare `standard` toggle + unknown-argument sanitization (#2493 review).
 *
 * PC-2: the help text and JSDoc advertise `standard [on|off]`, and bare
 * `lean` / bare `epic` both toggle — bare `standard` used to fall through to
 * the unknown-argument rejection. F-11: the offending token in the
 * unknown-argument message is interpolated into a single-line message, so
 * control characters must be stripped.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals, handleTurboCommand } from '../../../src/commands/turbo';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import * as leanState from '../../../src/turbo/lean/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const mockLoadPluginConfigWithMeta = mock(() => ({
	config: {},
	loadedFromFile: false,
}));

const SESSION_ID = 'sess-turbo-standard-toggle';

let tmpDir: string;
let originalLoadPluginConfigWithMeta:
	| typeof _internals.loadPluginConfigWithMeta
	| undefined;

beforeEach(() => {
	originalLoadPluginConfigWithMeta = _internals.loadPluginConfigWithMeta;
	_internals.loadPluginConfigWithMeta = mockLoadPluginConfigWithMeta;
	mockLoadPluginConfigWithMeta.mockImplementation(() => ({
		config: {},
		loadedFromFile: false,
	}));

	tmpDir = canonicalMkdtemp('turbo-standard-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	startAgentSession(SESSION_ID, 'architect');
	leanState.repairStateUnreadable(tmpDir);
});

afterEach(() => {
	if (originalLoadPluginConfigWithMeta) {
		_internals.loadPluginConfigWithMeta = originalLoadPluginConfigWithMeta;
	}
	mockLoadPluginConfigWithMeta.mockReset();
	resetSwarmState();
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup on Windows file-lock races.
	}
	closeAllProjectDbs();
});

describe('bare `/swarm turbo standard` toggle (#2493 review PC-2)', () => {
	test('bare standard enables standard turbo when nothing is active', async () => {
		const out = await handleTurboCommand(tmpDir, ['standard'], SESSION_ID);
		expect(out).toContain('Turbo Mode enabled (standard)');
		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.turboMode).toBe(true);
		expect(session?.turboStrategy).toBe('standard');
	});

	test('bare standard disables standard turbo when it is active', async () => {
		await handleTurboCommand(tmpDir, ['standard'], SESSION_ID);
		const out = await handleTurboCommand(tmpDir, ['standard'], SESSION_ID);
		expect(out).toBe('Turbo Mode disabled');
		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.turboMode).toBe(false);
	});

	test('bare standard switches from lean to standard', async () => {
		const leanOut = await handleTurboCommand(tmpDir, ['lean'], SESSION_ID);
		expect(leanOut).toContain('Lean Turbo');
		const out = await handleTurboCommand(tmpDir, ['standard'], SESSION_ID);
		expect(out).toContain('Turbo Mode enabled (standard)');
		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.turboStrategy).toBe('standard');
		expect(session?.leanTurboActive).toBe(false);
	});
});

describe('unknown turbo argument sanitization (#2493 review F-11)', () => {
	test('control characters are stripped from the echoed token', async () => {
		const out = await handleTurboCommand(
			tmpDir,
			['bad\u0000\u001b[31marg'],
			SESSION_ID,
		);
		expect(out).toContain('Unknown turbo argument "bad[31marg"');
		expect(out).not.toContain('\u0000');
		expect(out).not.toContain('\u001b');
		expect(out).toContain('Turbo state is unchanged');
	});
});
