/**
 * Tests for /swarm turbo epic on/off/toggle branches (M3.5).
 * File: tests/unit/commands/turbo-epic.test.ts
 *
 * Covers:
 *  - /swarm turbo epic on → enables BOTH Lean Turbo and Epic Mode (single
 *    unified toggle UX).
 *  - /swarm turbo epic off → disables both.
 *  - /swarm turbo epic (bare) → toggles based on current epic-active state.
 *  - In-memory session flag (`session.epicModeActive`) is set/cleared in
 *    lockstep with the durable `.swarm/epic-state.json`.
 *
 * Uses real tmpdir + real state modules (no mocks needed since state.ts
 * does real filesystem I/O). Matches the existing turbo-lean.test.ts
 * approach for consistency.
 */
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleTurboCommand } from '../../../src/commands/turbo';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { isEpicModeActive } from '../../../src/turbo/epic/state';

const mockLoadPluginConfigWithMeta = mock(() => ({
	config: { turbo: { strategy: 'lean' as const } },
	meta: { path: '/tmp/test' },
}));

mock.module('../../../src/config', () => ({
	loadPluginConfigWithMeta: mockLoadPluginConfigWithMeta,
	// Gate tools transitively reachable from the turbo-epic graph read user
	// gate overrides through this seam (issue #2524).
	loadGateOverrides: () => undefined,
}));

const SESSION_ID = 'sess-turbo-epic';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-epic-cmd-')),
	);
	resetSwarmState();
	startAgentSession(SESSION_ID, 'architect');
});

afterEach(() => {
	resetSwarmState();
	closeAllProjectDbs();
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

afterAll(() => {
	// Required by `scripts/check-mock-cleanup.sh` — restore module mocks so
	// they don't leak into other test files when Bun shares the test process.
	mock.restore();
});

describe('/swarm turbo epic on', () => {
	test('enables Lean Turbo AND Epic Mode together', async () => {
		const out = await handleTurboCommand(tmpDir, ['epic', 'on'], SESSION_ID);
		expect(out).toContain('Epic Mode enabled');
		expect(out.toLowerCase()).toContain('lean turbo');

		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.turboMode).toBe(true);
		expect(session?.turboStrategy).toBe('lean');
		expect(session?.leanTurboActive).toBe(true);
		expect(session?.epicModeActive).toBe(true);

		// Durable mirror also set.
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(true);
	});

	test('writes .swarm/epic-state.json on enable', async () => {
		await handleTurboCommand(tmpDir, ['epic', 'on'], SESSION_ID);
		const stateFile = path.join(tmpDir, '.swarm', 'epic-state.json');
		expect(fs.existsSync(stateFile)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
		expect(parsed.sessions[SESSION_ID].active).toBe(true);
	});
});

describe('/swarm turbo epic off', () => {
	test('disables both Epic Mode and Lean Turbo', async () => {
		// Enable both first.
		await handleTurboCommand(tmpDir, ['epic', 'on'], SESSION_ID);
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(true);

		const out = await handleTurboCommand(tmpDir, ['epic', 'off'], SESSION_ID);
		expect(out).toContain('Epic Mode disabled');

		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.epicModeActive).toBe(false);
		expect(session?.turboMode).toBe(false);
		expect(session?.leanTurboActive).toBe(false);

		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(false);
	});

	test('off when nothing was on returns disabled state cleanly', async () => {
		const out = await handleTurboCommand(tmpDir, ['epic', 'off'], SESSION_ID);
		expect(out).toContain('Epic Mode disabled');
		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.epicModeActive).toBe(false);
	});
});

describe('/swarm turbo epic (toggle)', () => {
	test('toggles from off → on', async () => {
		const out = await handleTurboCommand(tmpDir, ['epic'], SESSION_ID);
		expect(out).toContain('Epic Mode enabled');
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(true);
	});

	test('toggles from on → off', async () => {
		await handleTurboCommand(tmpDir, ['epic', 'on'], SESSION_ID);
		const out = await handleTurboCommand(tmpDir, ['epic'], SESSION_ID);
		expect(out).toContain('Epic Mode disabled');
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(false);
	});

	test('two toggles round-trip back to the original state', async () => {
		await handleTurboCommand(tmpDir, ['epic'], SESSION_ID);
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(true);
		await handleTurboCommand(tmpDir, ['epic'], SESSION_ID);
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(false);
	});
});

describe('/swarm turbo epic — cross-clear: disabling lean disables epic too', () => {
	test('/swarm turbo off after epic on clears BOTH flags', async () => {
		await handleTurboCommand(tmpDir, ['epic', 'on'], SESSION_ID);
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(true);

		const out = await handleTurboCommand(tmpDir, ['off'], SESSION_ID);
		expect(out).toContain('Turbo Mode disabled');

		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.epicModeActive).toBe(false);
		expect(session?.turboMode).toBe(false);
		expect(session?.leanTurboActive).toBe(false);
		// Durable epic state cross-cleared too.
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(false);
	});

	test('/swarm turbo lean off after epic on clears BOTH flags', async () => {
		await handleTurboCommand(tmpDir, ['epic', 'on'], SESSION_ID);
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(true);

		await handleTurboCommand(tmpDir, ['lean', 'off'], SESSION_ID);

		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.epicModeActive).toBe(false);
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(false);
	});

	test('bare /swarm turbo (toggle off) after epic on clears BOTH flags', async () => {
		await handleTurboCommand(tmpDir, ['epic', 'on'], SESSION_ID);
		await handleTurboCommand(tmpDir, [], SESSION_ID); // toggle

		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.epicModeActive).toBe(false);
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(false);
	});
});

describe('/swarm turbo epic — lean failure aborts epic activation', () => {
	test('if Lean Turbo durable write fails, epic is NOT enabled', async () => {
		// Sabotage the durable write: pre-create .swarm/turbo-state.json as
		// a non-empty DIRECTORY so saveLeanTurboRunState's tmp+rename fails
		// with ENOTEMPTY / EISDIR.
		const swarmDir = path.join(tmpDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const blocker = path.join(swarmDir, 'turbo-state.json');
		fs.mkdirSync(blocker);
		fs.writeFileSync(path.join(blocker, 'x'), 'block', 'utf-8');

		const out = await handleTurboCommand(tmpDir, ['epic', 'on'], SESSION_ID);
		expect(out).toMatch(/(could NOT be enabled|NOT enabled)/i);

		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.epicModeActive).toBe(false);
		expect(session?.leanTurboActive).toBe(false);
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(false);
	});
});

describe('/swarm turbo epic — composition with existing /swarm turbo', () => {
	test('does not break /swarm turbo lean on (existing path)', async () => {
		const out = await handleTurboCommand(tmpDir, ['lean', 'on'], SESSION_ID);
		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.leanTurboActive).toBe(true);
		// Epic should NOT have been activated by the lean-only path.
		expect(session?.epicModeActive).toBe(false);
		expect(isEpicModeActive(tmpDir, SESSION_ID)).toBe(false);
		// And the lean-on ack is still returned.
		expect(out.toLowerCase()).toMatch(/lean/);
	});

	test('does not break /swarm turbo standard on (existing path)', async () => {
		const out = await handleTurboCommand(
			tmpDir,
			['standard', 'on'],
			SESSION_ID,
		);
		expect(out).toContain('Turbo Mode enabled');
		const session = swarmState.agentSessions.get(SESSION_ID);
		expect(session?.epicModeActive).toBe(false);
	});
});
