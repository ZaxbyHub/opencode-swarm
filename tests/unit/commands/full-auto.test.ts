/**
 * Tests for the /swarm full-auto command (TASK 3 + arbitrary-swarm regression).
 *
 * Focus: durable-state fail-closed semantics. When the durable
 * .swarm/full-auto-state.json write fails for any reason, the command must
 * NOT flip the legacy session.fullAutoMode flag — otherwise the reactive
 * intercept would believe Full-Auto is on while the v2 permission hook
 * sees no durable run (silent fail-open).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleFullAutoCommand } from '../../../src/commands/full-auto';
import {
	isFullAutoRunActive,
	loadFullAutoRunState,
} from '../../../src/full-auto/state';
import { startAgentSession, swarmState } from '../../../src/state';

let tmpDir: string;
const SESSION_ID = 'sess-full-auto-cmd';

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-cmd-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	swarmState.fullAutoEnabledInConfig = true;
	startAgentSession(SESSION_ID, 'architect');
});

afterEach(() => {
	swarmState.agentSessions.delete(SESSION_ID);
	swarmState.fullAutoEnabledInConfig = false;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('handleFullAutoCommand — durable-first / fail-closed', () => {
	test('successful enable creates durable running state and sets session.fullAutoMode=true', async () => {
		const out = await handleFullAutoCommand(tmpDir, ['on'], SESSION_ID);
		expect(out).toContain('Full-Auto Mode enabled');
		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.fullAutoMode).toBe(true);
		expect(isFullAutoRunActive(tmpDir, SESSION_ID)).toBe(true);
	});

	test('successful disable pauses durable state and clears legacy counters', async () => {
		await handleFullAutoCommand(tmpDir, ['on'], SESSION_ID);
		const out = await handleFullAutoCommand(tmpDir, ['off'], SESSION_ID);
		expect(out).toContain('Full-Auto Mode disabled');
		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.fullAutoMode).toBe(false);
		// Durable record exists and is paused.
		expect(loadFullAutoRunState(tmpDir, SESSION_ID)?.status).toBe('paused');
	});

	test('durable write failure causes enable to return an error and NOT flip session.fullAutoMode', async () => {
		// Simulate durable write failure: make .swarm a regular file so any
		// attempt to write inside it must fail. The command should observe the
		// throw, log, and return an error string. session.fullAutoMode must
		// remain false.
		const swarmDir = path.join(tmpDir, '.swarm');
		fs.rmSync(swarmDir, { recursive: true, force: true });
		fs.writeFileSync(swarmDir, 'not-a-directory', 'utf-8');

		const out = await handleFullAutoCommand(tmpDir, ['on'], SESSION_ID);
		expect(out).toMatch(/could NOT be enabled|Error/i);

		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.fullAutoMode).toBe(false);
	});

	test('blocks enable when full_auto.enabled config is not set', async () => {
		swarmState.fullAutoEnabledInConfig = false;
		const out = await handleFullAutoCommand(tmpDir, ['on'], SESSION_ID);
		expect(out).toContain('Error');
		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.fullAutoMode).toBe(false);
	});
});
