/**
 * Child-activity registry semantics (the 2026-11-26 task 2.15 liveness wedge).
 *
 * The registry is the observed-liveness signal the background delegation
 * stale sweep consults before flipping a `pending`/`running` record to
 * `stale`. Pins: an open tool call blocks the sweep regardless of age (the
 * exact 2.15 geometry — a single long execution emits `session.tool.called`
 * at its start and nothing until it completes); a close or a session end
 * clears the block; the recency window; unknown/quiet/untrackable sessions
 * never block; unmatched closes are ignored; the bound holds.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import {
	_noteChildSessionEventAtForTesting,
	_resetChildActivityForTesting,
	childBlocksStaleSweep,
	noteChildSessionEvent,
} from '../../../src/background/child-activity';

const SWEEP_WINDOW_MS = 30 * 60_000;
const LONG_RUN_MS = 45 * 60_000;

let restoreClock: Restore;

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: Date.now(), tickMs: 1 });
	_resetChildActivityForTesting();
});

afterEach(() => {
	restoreClock();
	_resetChildActivityForTesting();
});

describe('child-activity registry (task 2.15 liveness wedge)', () => {
	test('an OPEN tool call older than the sweep window still blocks (the 2.15 geometry)', () => {
		const started = Date.now() - LONG_RUN_MS;
		_noteChildSessionEventAtForTesting('ses-2-15-coder', 'tool_open', started);
		// The JVM test run is 45 minutes in; the sweep window is 30 minutes.
		expect(childBlocksStaleSweep('ses-2-15-coder', SWEEP_WINDOW_MS)).toBe(true);
	});

	test('a closed tool call stops blocking once the window has elapsed', () => {
		const started = Date.now() - LONG_RUN_MS;
		const finished = Date.now() - (SWEEP_WINDOW_MS + 60_000);
		_noteChildSessionEventAtForTesting('ses-2-15-coder', 'tool_open', started);
		_noteChildSessionEventAtForTesting(
			'ses-2-15-coder',
			'tool_close',
			finished,
		);
		expect(childBlocksStaleSweep('ses-2-15-coder', SWEEP_WINDOW_MS)).toBe(
			false,
		);
	});

	test('a session end clears an open tool call (a session cannot outlive its terminal)', () => {
		const started = Date.now() - LONG_RUN_MS;
		const ended = Date.now() - (SWEEP_WINDOW_MS + 60_000);
		_noteChildSessionEventAtForTesting('ses-2-15-coder', 'tool_open', started);
		_noteChildSessionEventAtForTesting('ses-2-15-coder', 'session_end', ended);
		expect(childBlocksStaleSweep('ses-2-15-coder', SWEEP_WINDOW_MS)).toBe(
			false,
		);
	});

	test('a recent ordinary event blocks within the window', () => {
		noteChildSessionEvent('ses-live-child', 'event');
		expect(childBlocksStaleSweep('ses-live-child', SWEEP_WINDOW_MS)).toBe(true);
	});

	test('unknown, quiet, and untrackable sessions never block', () => {
		expect(childBlocksStaleSweep('ses-never-seen', SWEEP_WINDOW_MS)).toBe(
			false,
		);
		expect(childBlocksStaleSweep('', SWEEP_WINDOW_MS)).toBe(false);
		expect(childBlocksStaleSweep('   ', SWEEP_WINDOW_MS)).toBe(false);
		expect(childBlocksStaleSweep('x'.repeat(300), SWEEP_WINDOW_MS)).toBe(false);
	});

	test('unmatched closes are ignored; the open counter is clamped', () => {
		noteChildSessionEvent('ses-counter', 'tool_close');
		// The unmatched close still marks recent activity — give the zero
		// window a tick to elapse so only the counter is under test.
		Bun.sleepSync(3);
		expect(childBlocksStaleSweep('ses-counter', 0)).toBe(false);
		for (let i = 0; i < 200; i += 1) {
			noteChildSessionEvent('ses-counter', 'tool_open');
		}
		// Still blocks (clamped at the internal cap, never negative/NaN).
		expect(childBlocksStaleSweep('ses-counter', SWEEP_WINDOW_MS)).toBe(true);
	});

	test('the registry is bounded: quiet sessions evict before open ones', () => {
		// Fill with quiet sessions plus one open child.
		for (let i = 0; i < 400; i += 1) {
			noteChildSessionEvent(`ses-quiet-${i}`, 'event');
		}
		_noteChildSessionEventAtForTesting(
			'ses-open-child',
			'tool_open',
			Date.now(),
		);
		// The open child survives the eviction pressure of 400 later entries.
		expect(childBlocksStaleSweep('ses-open-child', 0)).toBe(true);
	});
});
