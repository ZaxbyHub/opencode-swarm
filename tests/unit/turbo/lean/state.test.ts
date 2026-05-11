import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	ensureAgentSession,
	getAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../../src/state';
import {
	emptyRunState,
	isLeanTurboRunActive,
	isStateUnreadable,
	loadLeanTurboRunState,
	pauseLeanTurboRun,
	repairStateUnreadable,
	resetLeanTurboRun,
	saveLeanTurboRunState,
} from '../../../../src/turbo/lean/state';

describe('Lean Turbo Session State', () => {
	const sessionId = 'test-lean-session';

	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	describe('turboStrategy initialization', () => {
		it('initializes turboStrategy to undefined on new session via startAgentSession', () => {
			startAgentSession(sessionId, 'mega_coder');
			const session = getAgentSession(sessionId);

			expect(session).toBeDefined();
			expect(session!.turboStrategy).toBeUndefined();
		});
	});

	describe('leanTurboActive initialization', () => {
		it('initializes leanTurboActive to false on new session via startAgentSession', () => {
			startAgentSession(sessionId, 'mega_coder');
			const session = getAgentSession(sessionId);

			expect(session).toBeDefined();
			expect(session!.leanTurboActive).toBe(false);
		});
	});

	describe('leanTurboCurrentPhase initialization', () => {
		it('initializes leanTurboCurrentPhase to undefined on new session', () => {
			startAgentSession(sessionId, 'mega_coder');
			const session = getAgentSession(sessionId);

			expect(session).toBeDefined();
			expect(session!.leanTurboCurrentPhase).toBeUndefined();
		});
	});

	describe('turboStrategy mutation', () => {
		it('allows setting turboStrategy to "lean"', () => {
			startAgentSession(sessionId, 'mega_coder');
			const session = getAgentSession(sessionId)!;

			session.turboStrategy = 'lean';

			expect(session.turboStrategy).toBe('lean');
		});
	});

	describe('leanTurboActive mutation', () => {
		it('allows setting leanTurboActive to true', () => {
			startAgentSession(sessionId, 'mega_coder');
			const session = getAgentSession(sessionId)!;

			session.leanTurboActive = true;

			expect(session.leanTurboActive).toBe(true);
		});
	});

	describe('leanTurboActive migration safety', () => {
		it('migration safety: leanTurboActive defaults to false when undefined', () => {
			// Simulate an old session without leanTurboActive field
			startAgentSession(sessionId, 'mega_coder');
			const session = getAgentSession(sessionId)!;

			// Manually delete leanTurboActive to simulate old state
			// @ts-expect-error - intentionally removing property to test migration
			delete session.leanTurboActive;

			// Call ensureAgentSession which should migrate the field
			ensureAgentSession(sessionId, 'mega_coder');
			const migratedSession = getAgentSession(sessionId);

			expect(migratedSession).toBeDefined();
			expect(migratedSession!.leanTurboActive).toBe(false);
		});
	});

	describe('turboMode independence', () => {
		it('turboMode remains independent of leanTurboActive', () => {
			startAgentSession(sessionId, 'mega_coder');
			const session = getAgentSession(sessionId)!;

			session.turboMode = true;
			session.leanTurboActive = false;

			expect(session.turboMode).toBe(true);
			expect(session.leanTurboActive).toBe(false);
		});
	});
});

describe('Lean Turbo Durable State', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-turbo-state-'));
		// Create valid initial turbo-state.json to ensure clean state isolation
		const stateFile = path.join(dir, '.swarm', 'turbo-state.json');
		fs.mkdirSync(path.dirname(stateFile), { recursive: true });
		fs.writeFileSync(
			stateFile,
			JSON.stringify({
				version: 1,
				updatedAt: new Date().toISOString(),
				sessions: {},
			}),
			'utf-8',
		);
		// Reset module-level unreadable flag before each durable state test
		repairStateUnreadable(dir);
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('emptyRunState', () => {
		it('emptyRunState creates state with status "idle"', () => {
			const state = emptyRunState('session-1', 4);

			expect(state.status).toBe('idle');
			expect(state.maxParallelCoders).toBe(4);
		});
	});

	describe('save and load round-trip', () => {
		it('saveLeanTurboRunState and loadLeanTurboRunState round-trip', () => {
			const state = emptyRunState('roundtrip-session', 4);
			state.status = 'running';
			saveLeanTurboRunState(dir, state);

			const loaded = loadLeanTurboRunState(dir, 'roundtrip-session');

			expect(loaded).toBeDefined();
			expect(loaded!.status).toBe('running');
			expect(loaded!.sessionID).toBe('roundtrip-session');
		});
	});

	describe('isLeanTurboRunActive', () => {
		it('isLeanTurboRunActive returns true when state is "running"', () => {
			const state = emptyRunState('active-session', 4);
			state.status = 'running';
			saveLeanTurboRunState(dir, state);

			const active = isLeanTurboRunActive(dir, 'active-session');

			expect(active).toBe(true);
		});

		it('isLeanTurboRunActive returns false when state is "idle"', () => {
			const state = emptyRunState('idle-session', 4);
			state.status = 'idle';
			saveLeanTurboRunState(dir, state);

			const active = isLeanTurboRunActive(dir, 'idle-session');

			expect(active).toBe(false);
		});
	});

	describe('pauseLeanTurboRun', () => {
		it('pauseLeanTurboRun sets status to "paused" and records reason', () => {
			const state = emptyRunState('pause-session', 4);
			state.status = 'running';
			saveLeanTurboRunState(dir, state);

			pauseLeanTurboRun(dir, 'pause-session', 'test pause');

			const loaded = loadLeanTurboRunState(dir, 'pause-session');
			expect(loaded).toBeDefined();
			expect(loaded!.status).toBe('paused');
			expect(loaded!.pauseReason).toBe('test pause');
		});
	});

	describe('resetLeanTurboRun', () => {
		it('resetLeanTurboRun removes session entry', () => {
			const state = emptyRunState('reset-session', 4);
			state.status = 'running';
			saveLeanTurboRunState(dir, state);

			resetLeanTurboRun(dir, 'reset-session');

			const loaded = loadLeanTurboRunState(dir, 'reset-session');
			expect(loaded).toBeNull();
		});
	});

	describe('corrupt state handling', () => {
		it('loadLeanTurboRunState returns null when state file is corrupt', () => {
			// Write invalid JSON to turbo-state.json
			const filePath = path.join(dir, '.swarm', 'turbo-state.json');
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, '{ invalid json }', 'utf-8');

			// Trigger readPersisted via loadLeanTurboRunState which sets stateUnreadable flag
			const loaded = loadLeanTurboRunState(dir, 'any-session');

			expect(loaded).toBeNull();
			expect(isStateUnreadable(dir)).toBe(true);
		});

		it('isLeanTurboRunActive returns false when state is unreadable (fail-closed)', () => {
			// Write corrupt state file
			const filePath = path.join(dir, '.swarm', 'turbo-state.json');
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, '{ invalid json }', 'utf-8');

			const active = isLeanTurboRunActive(dir, 'any-session');

			expect(active).toBe(false);
		});

		it('saveLeanTurboRunState throws Error when state file is corrupt (fail-closed)', () => {
			// Write corrupt state file
			const filePath = path.join(dir, '.swarm', 'turbo-state.json');
			expect(isStateUnreadable(dir)).toBe(false); // clean before we break it
			fs.writeFileSync(filePath, '{ invalid json }', 'utf-8');

			const state = emptyRunState('test-session', 4);
			state.status = 'running';

			expect(() => saveLeanTurboRunState(dir, state)).toThrow(Error);
		});

		it('pauseLeanTurboRun throws Error when state file is corrupt (fail-closed)', () => {
			// Write corrupt state file
			const filePath = path.join(dir, '.swarm', 'turbo-state.json');
			expect(isStateUnreadable(dir)).toBe(false); // clean before we break it
			fs.writeFileSync(filePath, '{ invalid json }', 'utf-8');

			expect(() =>
				pauseLeanTurboRun(dir, 'test-session', 'test pause'),
			).toThrow(Error);
		});

		it('resetLeanTurboRun throws Error when state file is corrupt (fail-closed)', () => {
			// Write corrupt state file
			const filePath = path.join(dir, '.swarm', 'turbo-state.json');
			expect(isStateUnreadable(dir)).toBe(false); // clean before we break it
			fs.writeFileSync(filePath, '{ invalid json }', 'utf-8');

			expect(() => resetLeanTurboRun(dir, 'test-session')).toThrow(Error);
		});
	});
});
