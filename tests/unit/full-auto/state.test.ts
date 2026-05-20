/**
 * Unit tests for src/full-auto/state.ts — durable Full-Auto run state.
 *
 * Uses real fs in os.tmpdir() temp directories to exercise the full
 * persistence path, and asserts the structural shape and counter behavior
 * without mocking validateSwarmPath or filesystem.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	incrementFullAutoCounter,
	isFullAutoRunActive,
	loadFullAutoRunState,
	pauseFullAutoRun,
	recordFullAutoDenial,
	recordFullAutoOversight,
	resetFullAutoDenials,
	saveFullAutoRunState,
	shouldPauseForDenials,
	startFullAutoRun,
	terminateFullAutoRun,
} from '../../../src/full-auto/state';

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-state-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('startFullAutoRun', () => {
	test('creates a running record with default counters', () => {
		const state = startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		expect(state.status).toBe('running');
		expect(state.sessionID).toBe('sess-1');
		expect(state.mode).toBe('supervised');
		expect(state.denialCounters.consecutive).toBe(0);
		expect(state.denialCounters.total).toBe(0);
		expect(state.counters.toolCalls).toBe(0);
	});

	test('persists state to .swarm/full-auto-state.json', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const filePath = path.join(tmpDir, '.swarm', 'full-auto-state.json');
		expect(fs.existsSync(filePath)).toBe(true);
		const persisted = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		expect(persisted.version).toBe(2);
		expect(persisted.sessions['sess-1'].status).toBe('running');
	});

	test('preserves denial total when restarting an existing session', () => {
		const initial = startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		recordFullAutoDenial(tmpDir, 'sess-1', { reason: 'r1' });
		recordFullAutoDenial(tmpDir, 'sess-1', { reason: 'r2' });
		const restarted = startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		expect(restarted.startedAt).toBe(initial.startedAt);
		expect(restarted.denialCounters.total).toBe(2);
		// Consecutive resets on restart so the run can attempt new actions.
		expect(restarted.denialCounters.consecutive).toBe(0);
	});

	test('honors mode from config', () => {
		const state = startFullAutoRun(tmpDir, 'sess-1', {
			enabled: true,
			mode: 'strict',
		});
		expect(state.mode).toBe('strict');
	});
});

describe('pause/terminate', () => {
	test('pauseFullAutoRun sets status=paused with reason', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const paused = pauseFullAutoRun(tmpDir, 'sess-1', 'manual');
		expect(paused?.status).toBe('paused');
		expect(paused?.pauseReason).toBe('manual');
	});

	test('terminateFullAutoRun sets status=terminated with reason', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const term = terminateFullAutoRun(tmpDir, 'sess-1', 'critic ESCALATE');
		expect(term?.status).toBe('terminated');
		expect(term?.terminateReason).toBe('critic ESCALATE');
	});

	test('isFullAutoRunActive reflects status transitions', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		expect(isFullAutoRunActive(tmpDir, 'sess-1')).toBe(true);
		pauseFullAutoRun(tmpDir, 'sess-1', 'x');
		expect(isFullAutoRunActive(tmpDir, 'sess-1')).toBe(false);
	});
});

describe('counters', () => {
	test('incrementFullAutoCounter increments by 1 by default', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const out = incrementFullAutoCounter(tmpDir, 'sess-1', 'toolCalls');
		expect(out?.counters.toolCalls).toBe(1);
		incrementFullAutoCounter(tmpDir, 'sess-1', 'toolCalls');
		const reloaded = loadFullAutoRunState(tmpDir, 'sess-1');
		expect(reloaded?.counters.toolCalls).toBe(2);
	});

	test('returns undefined for unknown session', () => {
		const out = incrementFullAutoCounter(tmpDir, 'nope', 'toolCalls');
		expect(out).toBeUndefined();
	});
});

describe('denials', () => {
	test('recordFullAutoDenial increments both counters', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const after = recordFullAutoDenial(tmpDir, 'sess-1', {
			reason: 'shell_deny',
			tool: 'bash',
		});
		expect(after?.denialCounters.consecutive).toBe(1);
		expect(after?.denialCounters.total).toBe(1);
		expect(after?.denialHistory.length).toBe(1);
	});

	test('resetFullAutoDenials clears consecutive but not total', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		recordFullAutoDenial(tmpDir, 'sess-1', { reason: 'r' });
		recordFullAutoDenial(tmpDir, 'sess-1', { reason: 'r' });
		const after = resetFullAutoDenials(tmpDir, 'sess-1');
		expect(after?.denialCounters.consecutive).toBe(0);
		expect(after?.denialCounters.total).toBe(2);
	});

	test('shouldPauseForDenials triggers at consecutive threshold', () => {
		const state = startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		state.denialCounters.consecutive = 3;
		const decision = shouldPauseForDenials(state, {
			denials: { max_consecutive: 3, max_total: 100, on_limit: 'pause' },
		});
		expect(decision.pause).toBe(true);
		expect(decision.mode).toBe('pause');
	});

	test('shouldPauseForDenials triggers at total threshold', () => {
		const state = startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		state.denialCounters.total = 20;
		const decision = shouldPauseForDenials(state, {
			denials: { max_consecutive: 100, max_total: 20, on_limit: 'terminate' },
		});
		expect(decision.pause).toBe(true);
		expect(decision.mode).toBe('terminate');
	});
});

describe('oversight checkpoints', () => {
	test('recordFullAutoOversight updates last verdict and counter', () => {
		startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		const after = recordFullAutoOversight(
			tmpDir,
			'sess-1',
			'APPROVED',
			'phase',
		);
		expect(after?.lastOversightVerdict).toBe('APPROVED');
		expect(after?.lastOversightReason).toBe('phase');
		expect(after?.counters.oversightChecks).toBe(1);
	});
});

describe('saveFullAutoRunState', () => {
	test('writes state and lets it round-trip via loadFullAutoRunState', () => {
		const state = startFullAutoRun(tmpDir, 'sess-1', { enabled: true });
		state.currentTaskID = 'task-7';
		saveFullAutoRunState(tmpDir, state);
		const loaded = loadFullAutoRunState(tmpDir, 'sess-1');
		expect(loaded?.currentTaskID).toBe('task-7');
	});
});
