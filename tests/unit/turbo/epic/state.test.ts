/**
 * Tests for Epic Mode durable state (`.swarm/epic-state.json`).
 * File: tests/unit/turbo/epic/state.test.ts
 *
 * Covers:
 *  - Seed-on-first-read creates the file with an empty `sessions` map.
 *  - enable / disable round-trip preserves the timestamps.
 *  - Atomic write leaves no `.tmp.*` leftovers.
 *  - Per-directory fail-closed on a malformed JSON file (and repair).
 *  - Reset clears the session entry.
 *  - recordEpicDecision merges into the existing session entry.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../../src/db/project-db';
import {
	disableEpicMode,
	emptyPersisted,
	enableEpicMode,
	isEpicModeActive,
	isEpicModeActiveForProject,
	isStateUnreadable,
	loadEpicSessionState,
	recordEpicDecision,
	repairStateUnreadable,
	resetEpicSession,
	saveEpicSessionState,
} from '../../../../src/turbo/epic/state';

let dir: string;

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'epic-state-')));
});

afterEach(() => {
	// Reset the fail-closed marker for this dir so each test starts clean.
	repairStateUnreadable(dir);
	closeAllProjectDbs();
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe('epic state — seed and shape', () => {
	test('first read seeds an empty persisted file', () => {
		expect(fs.existsSync(path.join(dir, '.swarm', 'epic-state.json'))).toBe(
			false,
		);
		const state = loadEpicSessionState(dir, 'session-A');
		expect(state).toBeNull();
		const filePath = path.join(dir, '.swarm', 'epic-state.json');
		expect(fs.existsSync(filePath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		expect(parsed.version).toBe(1);
		expect(parsed.sessions).toEqual({});
	});

	test('emptyPersisted is the canonical seed shape', () => {
		const p = emptyPersisted();
		expect(p.version).toBe(1);
		expect(p.sessions).toEqual({});
		expect(typeof p.updatedAt).toBe('string');
	});
});

describe('epic state — enable / disable round-trip', () => {
	test('enable sets active=true and records enabledAt', () => {
		enableEpicMode(dir, 'sess-1');
		const state = loadEpicSessionState(dir, 'sess-1');
		expect(state).not.toBeNull();
		if (!state) return;
		expect(state.active).toBe(true);
		expect(state.enabledAt).toBeDefined();
		expect(state.disabledAt).toBeUndefined();
		expect(isEpicModeActive(dir, 'sess-1')).toBe(true);
	});

	test('disable sets active=false and records disabledAt', () => {
		enableEpicMode(dir, 'sess-1');
		disableEpicMode(dir, 'sess-1');
		const state = loadEpicSessionState(dir, 'sess-1');
		expect(state).not.toBeNull();
		if (!state) return;
		expect(state.active).toBe(false);
		expect(state.disabledAt).toBeDefined();
		expect(isEpicModeActive(dir, 'sess-1')).toBe(false);
	});

	test('disable without prior enable creates an inactive record', () => {
		disableEpicMode(dir, 'sess-fresh');
		const state = loadEpicSessionState(dir, 'sess-fresh');
		expect(state).not.toBeNull();
		if (!state) return;
		expect(state.active).toBe(false);
		expect(state.disabledAt).toBeDefined();
	});

	test('repeated authoritative reads do not archive unchanged projections', () => {
		enableEpicMode(dir, 'stable-projection');
		const swarmDir = path.join(dir, '.swarm');
		const importedCount = () =>
			fs
				.readdirSync(swarmDir)
				.filter((name) => name.startsWith('epic-state.json.imported')).length;
		const before = importedCount();

		expect(loadEpicSessionState(dir, 'stable-projection')?.active).toBe(true);
		expect(loadEpicSessionState(dir, 'stable-projection')?.active).toBe(true);
		expect(importedCount()).toBe(before);
	});

	test('multiple sessions persist independently in the same file', () => {
		enableEpicMode(dir, 'sess-A');
		enableEpicMode(dir, 'sess-B');
		disableEpicMode(dir, 'sess-A');
		const sA = loadEpicSessionState(dir, 'sess-A');
		const sB = loadEpicSessionState(dir, 'sess-B');
		expect(sA?.active).toBe(false);
		expect(sB?.active).toBe(true);
	});
});

describe('epic state — atomic write hygiene', () => {
	test('no .tmp.* file remains after a successful write', () => {
		enableEpicMode(dir, 'sess-1');
		const swarmDir = path.join(dir, '.swarm');
		const leftovers = fs
			.readdirSync(swarmDir)
			.filter((f) => f.startsWith('epic-state.json.tmp.'));
		expect(leftovers).toEqual([]);
	});

	test('saveEpicSessionState updates the same file on the second write', () => {
		saveEpicSessionState(dir, {
			sessionID: 'sess-1',
			active: true,
			enabledAt: '2025-01-01T00:00:00Z',
		});
		saveEpicSessionState(dir, {
			sessionID: 'sess-1',
			active: false,
			enabledAt: '2025-01-01T00:00:00Z',
			disabledAt: '2025-01-02T00:00:00Z',
		});
		const state = loadEpicSessionState(dir, 'sess-1');
		expect(state?.disabledAt).toBe('2025-01-02T00:00:00Z');
		expect(state?.active).toBe(false);
	});
});

describe('epic state — fail-closed on corrupt file', () => {
	test('malformed JSON sets isStateUnreadable; repair clears it', () => {
		// Pre-populate a malformed file.
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'epic-state.json'),
			'{ this is not json',
			'utf-8',
		);
		const state = loadEpicSessionState(dir, 'sess-1');
		expect(state).toBeNull();
		expect(isStateUnreadable(dir)).toBe(true);

		// Replace with a valid shape and call repair.
		fs.writeFileSync(
			path.join(dir, '.swarm', 'epic-state.json'),
			JSON.stringify({
				version: 1,
				updatedAt: '2025-01-01T00:00:00Z',
				sessions: {},
			}),
			'utf-8',
		);
		repairStateUnreadable(dir);
		expect(isStateUnreadable(dir)).toBe(false);
	});

	test('wrong version is treated as malformed', () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'epic-state.json'),
			JSON.stringify({ version: 99, sessions: {} }),
			'utf-8',
		);
		expect(loadEpicSessionState(dir, 'sess-1')).toBeNull();
		expect(isStateUnreadable(dir)).toBe(true);
	});
});

describe('epic state — reset + decision recording', () => {
	test('resetEpicSession removes the session entry', () => {
		enableEpicMode(dir, 'sess-1');
		expect(loadEpicSessionState(dir, 'sess-1')).not.toBeNull();
		resetEpicSession(dir, 'sess-1');
		expect(loadEpicSessionState(dir, 'sess-1')).toBeNull();
	});

	test('recordEpicDecision merges into an existing entry without losing other fields', () => {
		enableEpicMode(dir, 'sess-1');
		const before = loadEpicSessionState(dir, 'sess-1');
		expect(before?.active).toBe(true);
		recordEpicDecision(dir, 'sess-1', {
			decidedAt: '2025-01-01T00:00:00Z',
			phase: 1,
			decision: 'promote',
			p: 0.12,
			blockingReasons: [],
		});
		const after = loadEpicSessionState(dir, 'sess-1');
		expect(after?.active).toBe(true); // not clobbered
		expect(after?.lastDecision?.decision).toBe('promote');
		expect(after?.lastDecision?.p).toBe(0.12);
	});

	test('recordEpicDecision throws when no session entry exists (no phantom state)', () => {
		expect(() =>
			recordEpicDecision(dir, 'sess-never-enabled', {
				decidedAt: '2025-01-01T00:00:00Z',
				decision: 'demote',
				p: 0.5,
				blockingReasons: ['p exceeds threshold'],
			}),
		).toThrow(/no session entry exists/i);
		// And the file should not have gained a phantom entry.
		expect(loadEpicSessionState(dir, 'sess-never-enabled')).toBeNull();
	});
});

describe('isEpicModeActiveForProject — project-scoped Epic check', () => {
	test('fails closed when the project root cannot be opened as a directory', () => {
		const fileRoot = path.join(dir, 'not-a-directory');
		fs.writeFileSync(fileRoot, 'occupied');

		expect(isEpicModeActiveForProject(fileRoot)).toBe(false);
	});

	test('fails closed when an existing project database cannot be opened', () => {
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(path.join(swarmDir, 'swarm.db'), 'not a sqlite database');

		expect(isEpicModeActiveForProject(dir)).toBe(false);
	});

	test('fails closed for traversal-style directory spellings', () => {
		expect(
			isEpicModeActiveForProject(path.join('..', '..', 'not-a-project')),
		).toBe(false);
	});

	test('returns true when ANY session is active, regardless of which', () => {
		// Architect's session enabled Epic; sub-agent sessions never toggle it.
		// The project-scoped check must answer "is the project under Epic"
		// from the sub-agent's perspective — that's the whole reason this
		// function exists (Rule 2's auto-commit fires from sub-agent sessions
		// after council/reviewer completion).
		enableEpicMode(dir, 'architect-session');
		expect(isEpicModeActiveForProject(dir)).toBe(true);
		// And `isEpicModeActive` from a DIFFERENT session correctly returns
		// false — proving the two functions are not collapsing into the same
		// answer.
		expect(isEpicModeActive(dir, 'coder-subagent-session')).toBe(false);
	});

	test('returns false when all sessions are inactive', () => {
		enableEpicMode(dir, 'sess-A');
		disableEpicMode(dir, 'sess-A');
		expect(isEpicModeActiveForProject(dir)).toBe(false);
	});

	test('returns false when no state file has ever been written', () => {
		// Note: this still seeds the empty file (existing readPersisted
		// behavior). The contract is the return value, not the absence of
		// side effects.
		expect(isEpicModeActiveForProject(dir)).toBe(false);
	});

	test('fail-closed: unreadable state file returns false (matches module default)', () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'epic-state.json'),
			'{ not valid json',
		);
		// Trigger the unreadable marker via any read.
		expect(loadEpicSessionState(dir, 'whatever')).toBeNull();
		expect(isStateUnreadable(dir)).toBe(true);
		expect(isEpicModeActiveForProject(dir)).toBe(false);
	});

	test('mixed sessions — at least one active is sufficient', () => {
		enableEpicMode(dir, 'sess-active');
		// Another session toggled off — the project should still read active.
		enableEpicMode(dir, 'sess-off');
		disableEpicMode(dir, 'sess-off');
		expect(isEpicModeActiveForProject(dir)).toBe(true);
	});
});
