/**
 * Fail-open contract for unrecognized event kinds (issue #2029).
 *
 * - `createObservation` on an unrecognized kind classifies it
 *   (`category: 'unrecognized'`) and never throws.
 * - A real `emit()` with an unrecognized kind STILL writes a line and STILL
 *   notifies listeners — nothing is silently dropped.
 * - A circular payload passed to `emit()` does not throw and writes nothing
 *   (matches `src/telemetry.test.ts:137-162`) — and per the ACTUAL current
 *   `emit()` implementation, listeners are NOT notified in that case, because
 *   `JSON.stringify` throws before the listener fan-out loop runs. This test
 *   asserts the real behavior, not an assumption.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createObservation } from '../../../src/observability/observe.js';
import {
	addTelemetryListener,
	emit,
	initTelemetry,
	resetTelemetryForTesting,
	type TelemetryEvent,
} from '../../../src/telemetry.js';

describe('createObservation — fail-open on unrecognized kind', () => {
	test('an unrecognized kind returns category: "unrecognized" and does not throw', () => {
		expect(() =>
			createObservation('totally_not_a_real_kind', { x: 1 }),
		).not.toThrow();
		const event = createObservation('totally_not_a_real_kind', { x: 1 });
		expect(event.category).toBe('unrecognized');
		expect(event.kind).toBe('totally_not_a_real_kind');
	});

	test('an unrecognized kind still projects to a legacy line via toLegacyTelemetryLine-compatible shape', () => {
		const event = createObservation('another_unknown_kind', { sessionId: 's' });
		expect(event.legacy.raw).toEqual({ sessionId: 's' });
		expect(event.legacy.sourceStore).toBe('.swarm/telemetry.jsonl');
	});
});

describe('emit() — unrecognized kind still writes and still notifies listeners', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-failopen-')),
		);
		resetTelemetryForTesting();
	});

	afterEach(() => {
		resetTelemetryForTesting();
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('an unrecognized event kind is still written to telemetry.jsonl', async () => {
		initTelemetry(tmpDir);
		emit('this_kind_does_not_exist_in_the_catalog' as TelemetryEvent, {
			sessionId: 'sess-1',
		});
		resetTelemetryForTesting();

		const file = path.join(tmpDir, '.swarm', 'telemetry.jsonl');
		// Poll briefly for the async stream flush. Bounded by an ATTEMPT COUNT
		// rather than a wall-clock deadline: a raw clock read here would make
		// this file a `scripts/check-test-clock.sh` violation for a loop that has
		// no time-sensitive assertion at all (200 * 25ms = the same 5s ceiling).
		const maxAttempts = 200;
		const pollDelayMs = 25;
		let content = '';
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (fs.existsSync(file)) {
				content = fs.readFileSync(file, 'utf-8');
				if (content.trim() !== '') break;
			}
			await new Promise((r) => setTimeout(r, pollDelayMs));
		}
		expect(content).toContain('this_kind_does_not_exist_in_the_catalog');
		const parsed = JSON.parse(content.trim());
		expect(parsed.event).toBe('this_kind_does_not_exist_in_the_catalog');
		expect(parsed.sessionId).toBe('sess-1');
	});

	test('an unrecognized event kind still fires registered listeners', () => {
		initTelemetry(tmpDir);
		const received: Array<{
			event: TelemetryEvent;
			data: Record<string, unknown>;
		}> = [];
		addTelemetryListener((event, data) => {
			received.push({ event, data });
		});

		emit('this_kind_is_also_unrecognized' as TelemetryEvent, {
			sessionId: 'sess-2',
		});

		expect(received.length).toBe(1);
		expect(received[0].event).toBe('this_kind_is_also_unrecognized');
		expect(received[0].data.sessionId).toBe('sess-2');
	});
});

describe('emit() — circular payload: no throw, writes nothing, listeners NOT notified', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-failopen-circ-')),
		);
		resetTelemetryForTesting();
	});

	afterEach(() => {
		resetTelemetryForTesting();
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test('does not throw', () => {
		initTelemetry(tmpDir);
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;
		expect(() => emit('session_started', circular)).not.toThrow();
	});

	test('writes nothing — matches src/telemetry.test.ts:137-162', () => {
		initTelemetry(tmpDir);
		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;
		emit('session_started', circular);
		resetTelemetryForTesting();

		const file = path.join(tmpDir, '.swarm', 'telemetry.jsonl');
		if (fs.existsSync(file)) {
			expect(fs.readFileSync(file, 'utf-8').trim()).toBe('');
		}
	});

	test('does NOT notify listeners — JSON.stringify throws before the fan-out loop runs (verified against real emit() behavior, not assumed)', () => {
		initTelemetry(tmpDir);
		const received: unknown[] = [];
		addTelemetryListener((event, data) => {
			received.push({ event, data });
		});

		const circular: Record<string, unknown> = { a: 1 };
		circular.self = circular;
		emit('session_started', circular);

		expect(received.length).toBe(0);
	});
});
