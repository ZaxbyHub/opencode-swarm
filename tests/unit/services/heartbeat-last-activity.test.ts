import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	getLastHeartbeat,
	initTelemetry,
	resetHeartbeatTrackingForTesting,
	resetTelemetryForTesting,
	startHeartbeatTracking,
	stopHeartbeatTracking,
	_internals as telemetryInternals,
} from '../../../src/telemetry';

describe('heartbeat last-activity tracking (FR-010)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-test-'));
		resetTelemetryForTesting();
		initTelemetry(tempDir);
	});

	afterEach(() => {
		resetTelemetryForTesting();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('startHeartbeatTracking is idempotent', () => {
		startHeartbeatTracking();
		startHeartbeatTracking();
		telemetryInternals.emit('heartbeat', { sessionId: 's1' });
		const ts = getLastHeartbeat('s1');
		expect(ts).toBeDefined();
		expect(typeof ts).toBe('number');
	});

	test('getLastHeartbeat returns timestamp after heartbeat emission', () => {
		startHeartbeatTracking();
		const before = Date.now();
		telemetryInternals.emit('heartbeat', { sessionId: 's-timestamp' });
		const after = Date.now();
		const ts = getLastHeartbeat('s-timestamp');
		expect(ts).toBeDefined();
		expect(ts! >= before).toBe(true);
		expect(ts! <= after + 1).toBe(true);
	});

	test('getLastHeartbeat returns undefined for unknown sessionId', () => {
		startHeartbeatTracking();
		expect(getLastHeartbeat('nonexistent-session')).toBeUndefined();
	});

	test('bounded FIFO eviction at 500 entries', () => {
		startHeartbeatTracking();
		for (let i = 0; i < 501; i++) {
			telemetryInternals.emit('heartbeat', { sessionId: `evict-sess-${i}` });
		}
		expect(getLastHeartbeat('evict-sess-0')).toBeUndefined();
		expect(getLastHeartbeat('evict-sess-500')).toBeDefined();
		expect(getLastHeartbeat('evict-sess-250')).toBeDefined();
	});

	test('stopHeartbeatTracking allows re-registration', () => {
		startHeartbeatTracking();
		telemetryInternals.emit('heartbeat', { sessionId: 's-stop' });
		expect(getLastHeartbeat('s-stop')).toBeDefined();
		stopHeartbeatTracking();
		resetHeartbeatTrackingForTesting();
		startHeartbeatTracking();
		telemetryInternals.emit('heartbeat', { sessionId: 's-stop-new' });
		const ts = getLastHeartbeat('s-stop-new');
		expect(ts).toBeDefined();
		expect(typeof ts).toBe('number');
	});

	test('start/stop cycles do not accumulate listeners on _listeners', () => {
		// Hermes-pr-review found: prior to fix, start/stop/start would push a second
		// listener onto _listeners because addTelemetryListener is push-only. After
		// the fix, the listener count stays at exactly 1 through any number of cycles.
		expect(telemetryInternals.heartbeatListenerCount()).toBe(0);

		for (let i = 0; i < 3; i++) {
			startHeartbeatTracking();
			expect(telemetryInternals.heartbeatListenerCount()).toBe(1);
			stopHeartbeatTracking();
			expect(telemetryInternals.heartbeatListenerCount()).toBe(0);
		}

		// Idempotent start: calling start twice without stop should not double the listener.
		startHeartbeatTracking();
		startHeartbeatTracking();
		expect(telemetryInternals.heartbeatListenerCount()).toBe(1);
		stopHeartbeatTracking();
	});

	test('different sessionIds are tracked independently', () => {
		startHeartbeatTracking();
		telemetryInternals.emit('heartbeat', { sessionId: 'sessionA' });
		const tsA = getLastHeartbeat('sessionA');
		expect(tsA).toBeDefined();
		telemetryInternals.emit('heartbeat', { sessionId: 'sessionB' });
		const tsB = getLastHeartbeat('sessionB');
		expect(tsB).toBeDefined();
		expect(typeof tsA).toBe('number');
		expect(typeof tsB).toBe('number');
	});

	test('non-heartbeat events are ignored', () => {
		startHeartbeatTracking();
		telemetryInternals.emit('session_started', { sessionId: 's-other' });
		expect(getLastHeartbeat('s-other')).toBeUndefined();
		telemetryInternals.emit('heartbeat', { sessionId: 's-other' });
		expect(getLastHeartbeat('s-other')).toBeDefined();
	});

	test('heartbeat without sessionId is ignored', () => {
		startHeartbeatTracking();
		telemetryInternals.emit('heartbeat', {} as Record<string, unknown>);
		expect(getLastHeartbeat('')).toBeUndefined();
	});
});
