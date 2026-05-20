/**
 * Tests for the /swarm turbo command (lean turbo mode).
 *
 * Covers: backward-compatibility toggle, lean turbo enable/disable,
 * durable-state fail-closed semantics, status reporting, and
 * resetSwarmState lean-field cleanup.
 *
 * Strategy: uses real tmpDir + real lean state functions throughout.
 * Test 8 triggers a fail-closed by corrupting the turbo-state.json.
 * Test 7 verifies durable state write by directly reading back with leanState.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleTurboCommand } from '../../../src/commands/turbo';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import * as leanState from '../../../src/turbo/lean/state';

const mockLoadPluginConfigWithMeta = mock(() => ({
	config: {},
	meta: { path: '/tmp/test' },
}));

mock.module('../../../src/config', () => ({
	loadPluginConfigWithMeta: mockLoadPluginConfigWithMeta,
}));

const SESSION_ID = 'sess-turbo-lean';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-lean-cmd-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	startAgentSession(SESSION_ID, 'architect');
	// Reset the module-level stateUnreadable flag between tests so a corrupted
	// state file in one test doesn't affect subsequent tests
	leanState.repairStateUnreadable(tmpDir);
});

afterEach(() => {
	mock.restore();
	swarmState.agentSessions.delete(SESSION_ID);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ---------------------------------------------------------------------------
// BACKWARD COMPATIBILITY
// ---------------------------------------------------------------------------
describe('backward compatibility — toggle and explicit on/off', () => {
	test('existing toggle (no args): off→standard on', async () => {
		const out = await handleTurboCommand(tmpDir, [], SESSION_ID);
		expect(out).toContain('Turbo Mode enabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboMode).toBe(true);
		expect(session.turboStrategy).toBe('standard');
		expect(session.leanTurboActive).toBe(false);
	});

	test('existing toggle (no args): standard on→off', async () => {
		// Pre-enable standard turbo
		const session0 = swarmState.agentSessions.get(SESSION_ID)!;
		session0.turboMode = true;
		session0.turboStrategy = 'standard';

		const out = await handleTurboCommand(tmpDir, [], SESSION_ID);
		expect(out).toContain('Turbo Mode disabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboMode).toBe(false);
	});

	test('lean active (no args): lean on→off', async () => {
		// Pre-enable lean turbo
		const session0 = swarmState.agentSessions.get(SESSION_ID)!;
		session0.turboMode = true;
		session0.turboStrategy = 'lean';
		session0.leanTurboActive = true;

		const out = await handleTurboCommand(tmpDir, [], SESSION_ID);
		expect(out).toContain('Turbo Mode disabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboMode).toBe(false);
		expect(session.leanTurboActive).toBe(false);
	});

	test('turbo on: enables standard', async () => {
		const out = await handleTurboCommand(tmpDir, ['on'], SESSION_ID);
		expect(out).toContain('Turbo Mode enabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboMode).toBe(true);
		expect(session.turboStrategy).toBe('standard');
	});

	test('turbo off: disables', async () => {
		// Pre-enable
		const session0 = swarmState.agentSessions.get(SESSION_ID)!;
		session0.turboMode = true;
		session0.turboStrategy = 'standard';

		const out = await handleTurboCommand(tmpDir, ['off'], SESSION_ID);
		expect(out).toContain('Turbo Mode disabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboMode).toBe(false);
	});

	test('unknown arg with turbo off: toggles on (backward compat)', async () => {
		const out = await handleTurboCommand(tmpDir, ['bogus'], SESSION_ID);
		expect(out).toContain('Turbo Mode enabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboMode).toBe(true);
		expect(session.turboStrategy).toBe('standard');
	});

	test('unknown arg with turbo on: toggles off (backward compat)', async () => {
		const session0 = swarmState.agentSessions.get(SESSION_ID)!;
		session0.turboMode = true;
		session0.turboStrategy = 'standard';

		const out = await handleTurboCommand(tmpDir, ['bogus'], SESSION_ID);
		expect(out).toContain('Turbo Mode disabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboMode).toBe(false);
	});

	test('turbo lean (no sub-arg) with lean inactive: enables lean', async () => {
		// Mirror the 'turbo lean on' pattern: write durable state first so lean activation succeeds
		const runState = leanState.emptyRunState(SESSION_ID, 4);
		runState.status = 'running';
		runState.phase = 0;
		runState.lanes = [];
		runState.degradedTasks = [];
		leanState.saveLeanTurboRunState(tmpDir, runState);

		const out = await handleTurboCommand(tmpDir, ['lean'], SESSION_ID);
		expect(out).toContain('Lean Turbo enabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboStrategy).toBe('lean');
		expect(session.leanTurboActive).toBe(true);
		expect(session.turboMode).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// SUBCOMMANDS
// ---------------------------------------------------------------------------
describe('subcommands — standard / lean / status', () => {
	test('turbo standard on: sets standard strategy', async () => {
		const out = await handleTurboCommand(
			tmpDir,
			['standard', 'on'],
			SESSION_ID,
		);
		expect(out).toContain('Turbo Mode enabled (standard)');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboStrategy).toBe('standard');
		expect(session.leanTurboActive).toBe(false);
	});

	test('turbo lean on: sets lean strategy and writes durable state', async () => {
		const out = await handleTurboCommand(tmpDir, ['lean', 'on'], SESSION_ID);
		expect(out).toContain('Lean Turbo enabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboMode).toBe(true);
		expect(session.turboStrategy).toBe('lean');
		expect(session.leanTurboActive).toBe(true);

		// Verify durable state was written
		const durableState = leanState.loadLeanTurboRunState(tmpDir, SESSION_ID);
		expect(durableState).not.toBeNull();
		expect(durableState?.status).toBe('running');
		expect(durableState?.strategy).toBe('lean');
	});

	test('lean on fails safely if durable state write fails', async () => {
		// Corrupt the turbo-state.json file so readPersisted returns null,
		// causing saveLeanTurboRunState to throw before session flags are flipped
		const stateFile = path.join(tmpDir, '.swarm', 'turbo-state.json');
		fs.writeFileSync(stateFile, '{ "malformed": true }', 'utf-8');

		const out = await handleTurboCommand(tmpDir, ['lean', 'on'], SESSION_ID);
		expect(out).toContain('Error: Lean Turbo could NOT be enabled');

		const session = swarmState.agentSessions.get(SESSION_ID)!;
		// Session flags must NOT be flipped when durable write fails (fail-closed)
		expect(session.turboMode).toBe(false);
		expect(session.turboStrategy).toBeUndefined();
		expect(session.leanTurboActive).toBe(false);
	});

	test('turbo lean off: disables turbo', async () => {
		// Pre-enable lean turbo
		const session0 = swarmState.agentSessions.get(SESSION_ID)!;
		session0.turboMode = true;
		session0.turboStrategy = 'lean';
		session0.leanTurboActive = true;

		const out = await handleTurboCommand(tmpDir, ['lean', 'off'], SESSION_ID);
		expect(out).toContain('Turbo Mode disabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboMode).toBe(false);
		expect(session.leanTurboActive).toBe(false);
	});

	test('turbo status: off reports correctly', async () => {
		const out = await handleTurboCommand(tmpDir, ['status'], SESSION_ID);
		expect(out).toContain('Turbo: off');
	});

	test('turbo status: standard active reports correctly', async () => {
		const session0 = swarmState.agentSessions.get(SESSION_ID)!;
		session0.turboMode = true;
		session0.turboStrategy = 'standard';

		const out = await handleTurboCommand(tmpDir, ['status'], SESSION_ID);
		expect(out).toContain('standard');
		expect(out).toContain('turboMode=true');
	});

	test('turbo standard off: disables turbo', async () => {
		// Pre-enable standard turbo
		const session0 = swarmState.agentSessions.get(SESSION_ID)!;
		session0.turboMode = true;
		session0.turboStrategy = 'standard';

		const out = await handleTurboCommand(
			tmpDir,
			['standard', 'off'],
			SESSION_ID,
		);
		expect(out).toContain('Turbo Mode disabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboMode).toBe(false);
		expect(session.leanTurboActive).toBe(false);
	});

	test('turbo status: lean active reports correctly', async () => {
		// Pre-enable lean and write durable state so status has something to read
		const session0 = swarmState.agentSessions.get(SESSION_ID)!;
		session0.turboMode = true;
		session0.turboStrategy = 'lean';
		session0.leanTurboActive = true;
		session0.fullAutoMode = false;

		// Write a valid durable state so status has full details to report
		const runState = leanState.emptyRunState(SESSION_ID, 4);
		runState.status = 'running';
		runState.phase = 1;
		runState.lanes = [];
		runState.degradedTasks = [];
		leanState.saveLeanTurboRunState(tmpDir, runState);

		const out = await handleTurboCommand(tmpDir, ['status'], SESSION_ID);
		expect(out).toContain('lean');
		expect(out).toContain('turboMode=true');
		expect(out).toContain('leanTurboActive=true');
	});

	test('config strategy lean makes /swarm turbo on enable lean', async () => {
		mockLoadPluginConfigWithMeta.mockReturnValueOnce({
			config: {
				turbo: {
					strategy: 'lean',
					lean: {
						max_parallel_coders: 2,
						require_declared_scope: true,
						conflict_policy: 'serialize',
						degrade_on_risk: true,
						phase_reviewer: true,
						phase_critic: true,
						integrated_diff_required: true,
					},
				},
			},
			meta: { path: '/tmp/test' },
		});

		const out = await handleTurboCommand(tmpDir, ['on'], SESSION_ID);
		expect(out).toContain('Lean Turbo enabled');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboStrategy).toBe('lean');
		expect(session.leanTurboActive).toBe(true);
		expect(session.turboMode).toBe(true);
	});

	test('explicit standard on overrides config strategy lean for that session', async () => {
		mockLoadPluginConfigWithMeta.mockReturnValueOnce({
			config: {
				turbo: {
					strategy: 'lean',
					lean: {
						max_parallel_coders: 2,
						require_declared_scope: true,
						conflict_policy: 'serialize',
						degrade_on_risk: true,
						phase_reviewer: true,
						phase_critic: true,
						integrated_diff_required: true,
					},
				},
			},
			meta: { path: '/tmp/test' },
		});

		const out = await handleTurboCommand(
			tmpDir,
			['standard', 'on'],
			SESSION_ID,
		);
		expect(out).toContain('Turbo Mode enabled (standard)');
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		expect(session.turboStrategy).toBe('standard');
		expect(session.leanTurboActive).toBe(false);
		expect(session.turboMode).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// CARRY-FORWARD FROM PHASE 2 COUNCIL
// ---------------------------------------------------------------------------
describe('resetSwarmState clears lean fields', () => {
	test('resetSwarmState clears lean fields', async () => {
		// Start a session and enable lean turbo
		startAgentSession(SESSION_ID, 'architect');
		const session0 = swarmState.agentSessions.get(SESSION_ID)!;
		session0.turboMode = true;
		session0.turboStrategy = 'lean';
		session0.leanTurboActive = true;
		session0.leanTurboCurrentPhase = 3;

		// Reset all swarm state
		resetSwarmState();

		// Start a new session for the same sessionID
		startAgentSession(SESSION_ID, 'architect');
		const session1 = swarmState.agentSessions.get(SESSION_ID)!;

		// Lean fields must be reset to defaults (not persist from previous session)
		expect(session1.turboMode).toBe(false);
		expect(session1.turboStrategy).toBeUndefined();
		expect(session1.leanTurboActive).toBe(false);
		expect(session1.leanTurboCurrentPhase).toBeUndefined();
	});
});
