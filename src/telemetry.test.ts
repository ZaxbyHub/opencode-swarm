import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	addTelemetryListener,
	emit,
	initTelemetry,
	ROTATION_CHECK_INTERVAL,
	resetTelemetryForTesting,
	rotateTelemetryIfNeeded,
	type TelemetryEvent,
	telemetry,
} from './telemetry';

function getTempDir(): string {
	return fs.mkdtempSync(
		path.join(fs.realpathSync(os.tmpdir()), 'telemetry-test-'),
	);
}

function getTelemetryPath(tempDir: string): string {
	return path.join(tempDir, '.swarm', 'telemetry.jsonl');
}

function getRotatedPath(tempDir: string): string {
	return path.join(tempDir, '.swarm', 'telemetry.jsonl.1');
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('telemetry', () => {
	let tempDir: string;

	beforeEach(() => {
		resetTelemetryForTesting();
		tempDir = getTempDir();
	});

	afterEach(() => {
		resetTelemetryForTesting();
		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	describe('initTelemetry', () => {
		test('1. initTelemetry creates .swarm/telemetry.jsonl file and _projectDirectory is set', async () => {
			initTelemetry(tempDir);

			// Wait for WriteStream to flush and file to be created
			await sleep(200);

			const telemetryPath = getTelemetryPath(tempDir);
			expect(fs.existsSync(telemetryPath)).toBe(true);

			// Verify it's a file (not directory)
			const stats = fs.statSync(telemetryPath);
			expect(stats.isFile()).toBe(true);
		});

		test('8. Double init is no-op (call initTelemetry twice, verify no error, file still works)', async () => {
			initTelemetry(tempDir);
			const firstPath = getTelemetryPath(tempDir);

			// Wait for WriteStream to flush
			await sleep(200);

			// Second init should not throw
			expect(() => initTelemetry(tempDir)).not.toThrow();

			// File should still exist and work
			expect(fs.existsSync(firstPath)).toBe(true);

			// Should be able to emit after double init
			emit('session_started', { sessionId: 'test' });
		});
	});

	describe('emit', () => {
		test('2. emit() appends valid JSON lines to the file', async () => {
			initTelemetry(tempDir);

			emit('session_started', { sessionId: 'session-1', agentName: 'coder' });
			emit('gate_passed', {
				sessionId: 'session-1',
				gate: 'crud',
				taskId: '1.1',
			});

			// Wait for async write to complete
			await sleep(100);

			const telemetryPath = getTelemetryPath(tempDir);
			const content = fs.readFileSync(telemetryPath, 'utf-8');
			const lines = content.trim().split('\n');

			expect(lines.length).toBe(2);

			// Parse each line as JSON and verify structure
			for (const line of lines) {
				const parsed = JSON.parse(line);
				expect(parsed).toHaveProperty('timestamp');
				expect(parsed).toHaveProperty('event');
				expect(parsed).toHaveProperty('sessionId');
			}

			// Verify first event
			const firstEvent = JSON.parse(lines[0]);
			expect(firstEvent.event).toBe('session_started');
			expect(firstEvent.agentName).toBe('coder');

			// Verify second event
			const secondEvent = JSON.parse(lines[1]);
			expect(secondEvent.event).toBe('gate_passed');
			expect(secondEvent.gate).toBe('crud');
		});

		test('3. emit() before init is no-op (no error, no file created)', () => {
			// Do not call initTelemetry

			// Should not throw
			expect(() =>
				emit('session_started', { sessionId: 'test' }),
			).not.toThrow();

			const telemetryPath = getTelemetryPath(tempDir);
			expect(fs.existsSync(telemetryPath)).toBe(false);
		});

		test('10. emit() try/catch guarantees no throw (emit with circular object, bad data)', () => {
			initTelemetry(tempDir);

			// Circular reference
			const circular: Record<string, unknown> = { a: 1 };
			circular.self = circular;

			// Should not throw even with circular object
			expect(() =>
				emit('session_started' as TelemetryEvent, circular),
			).not.toThrow();

			// Undefined and function values
			expect(() =>
				emit('session_started' as TelemetryEvent, { fn: () => {} }),
			).not.toThrow();
			expect(() =>
				emit('session_started' as TelemetryEvent, { undef: undefined }),
			).not.toThrow();

			// Symbol and BigInt
			expect(() =>
				emit('session_started' as TelemetryEvent, { sym: Symbol('test') }),
			).not.toThrow();
			expect(() =>
				emit('session_started' as TelemetryEvent, { big: BigInt(123) }),
			).not.toThrow();
		});
	});

	describe('addTelemetryListener', () => {
		test('4. addTelemetryListener receives events (register listener, emit, verify called)', () => {
			initTelemetry(tempDir);

			const receivedEvents: Array<{
				event: TelemetryEvent;
				data: Record<string, unknown>;
			}> = [];

			addTelemetryListener((event, data) => {
				receivedEvents.push({ event, data });
			});

			emit('session_started', { sessionId: 's1', agentName: 'coder' });
			emit('gate_passed', { sessionId: 's1', gate: 'crud', taskId: '1.1' });

			expect(receivedEvents.length).toBe(2);
			expect(receivedEvents[0].event).toBe('session_started');
			expect(receivedEvents[0].data.sessionId).toBe('s1');
			expect(receivedEvents[1].event).toBe('gate_passed');
		});

		test('5. Throwing listener doesnt block other listeners (first throws, second still receives)', () => {
			initTelemetry(tempDir);

			const receivedEvents: TelemetryEvent[] = [];

			addTelemetryListener(() => {
				throw new Error('Listener 1 error');
			});

			addTelemetryListener((event) => {
				receivedEvents.push(event);
			});

			addTelemetryListener(() => {
				throw new Error('Listener 2 error');
			});

			emit('session_started', { sessionId: 's1' });
			emit('gate_passed', { sessionId: 's1', gate: 'crud', taskId: '1.1' });

			// Second and third listeners should still have been called
			expect(receivedEvents.length).toBe(2);
			expect(receivedEvents[0]).toBe('session_started');
			expect(receivedEvents[1]).toBe('gate_passed');
		});
	});

	describe('rotateTelemetryIfNeeded', () => {
		test('6. rotateTelemetryIfNeeded renames file when size exceeds threshold', async () => {
			initTelemetry(tempDir);

			const telemetryPath = getTelemetryPath(tempDir);
			const rotatedPath = getRotatedPath(tempDir);

			// Write enough data to exceed a small threshold (100 bytes)
			const smallThreshold = 100;
			for (let i = 0; i < 10; i++) {
				emit('session_started', {
					sessionId: `session-${i}`,
					agentName: 'coder',
					extra: 'x'.repeat(50),
				});
			}

			await sleep(200);

			const statsBefore = fs.statSync(telemetryPath);
			expect(statsBefore.size).toBeGreaterThan(smallThreshold);

			// Rotate
			rotateTelemetryIfNeeded(smallThreshold);

			// Wait for rotation to complete and new stream to open
			await sleep(200);

			// Old file should be renamed
			expect(fs.existsSync(rotatedPath)).toBe(true);

			// Can still emit to new file
			emit('session_started', { sessionId: 'after-rotate' });
			await sleep(100);

			const content = fs.readFileSync(telemetryPath, 'utf-8');
			expect(content).toContain('after-rotate');
		});

		test('rotateTelemetryIfNeeded does nothing when file is below threshold', async () => {
			initTelemetry(tempDir);

			const telemetryPath = getTelemetryPath(tempDir);
			const rotatedPath = getRotatedPath(tempDir);

			emit('session_started', { sessionId: 'small' });
			await sleep(100);

			const sizeBefore = fs.statSync(telemetryPath).size;

			// Large threshold should prevent rotation
			rotateTelemetryIfNeeded(10 * 1024 * 1024); // 10MB

			expect(fs.existsSync(rotatedPath)).toBe(false);
			const sizeAfter = fs.statSync(telemetryPath).size;
			expect(sizeAfter).toBe(sizeBefore);
		});

		test('rotateTelemetryIfNeeded does nothing when file does not exist', () => {
			// Don't init, so telemetry file doesn't exist
			expect(() => rotateTelemetryIfNeeded(100)).not.toThrow();

			const telemetryPath = getTelemetryPath(tempDir);
			expect(fs.existsSync(telemetryPath)).toBe(false);
		});
	});

	describe('telemetry convenience object', () => {
		test('7. All telemetry.* convenience methods call emit correctly', () => {
			initTelemetry(tempDir);

			const receivedEvents: Array<{
				event: TelemetryEvent;
				data: Record<string, unknown>;
			}> = [];

			addTelemetryListener((event, data) => {
				receivedEvents.push({ event, data });
			});

			// Test all 17 methods
			telemetry.sessionStarted('s1', 'coder');
			telemetry.sessionEnded('s1', 'completed');
			telemetry.agentActivated('s1', 'reviewer', 'coder');
			telemetry.delegationBegin('s1', 'coder', '1.1');
			telemetry.delegationEnd('s1', 'coder', '1.1', 'success');
			telemetry.taskStateChanged('s1', '1.1', 'completed', 'pending');
			telemetry.gatePassed('s1', 'crud', '1.1');
			telemetry.gateFailed('s1', 'crud', '1.1', 'missing_file');
			telemetry.phaseChanged('s1', 1, 2);
			telemetry.budgetUpdated('s1', 75, 'coder');
			telemetry.modelFallback('s1', 'coder', 'gpt-4', 'gpt-3.5', 'cost');
			telemetry.hardLimitHit('s1', 'coder', 'tokens', 100000);
			telemetry.revisionLimitHit('s1', 'coder');
			telemetry.loopDetected('s1', 'coder', 'infinite_loop');
			telemetry.scopeViolation('s1', 'coder', 'src/index.ts', 'unauthorized');
			telemetry.qaSkipViolation('s1', 'coder', 3);
			telemetry.heartbeat('s1');

			expect(receivedEvents.length).toBe(17);

			// Verify each event type
			expect(receivedEvents[0].event).toBe('session_started');
			expect(receivedEvents[1].event).toBe('session_ended');
			expect(receivedEvents[2].event).toBe('agent_activated');
			expect(receivedEvents[3].event).toBe('delegation_begin');
			expect(receivedEvents[4].event).toBe('delegation_end');
			expect(receivedEvents[5].event).toBe('task_state_changed');
			expect(receivedEvents[6].event).toBe('gate_passed');
			expect(receivedEvents[7].event).toBe('gate_failed');
			expect(receivedEvents[8].event).toBe('phase_changed');
			expect(receivedEvents[9].event).toBe('budget_updated');
			expect(receivedEvents[10].event).toBe('model_fallback');
			expect(receivedEvents[11].event).toBe('hard_limit_hit');
			expect(receivedEvents[12].event).toBe('revision_limit_hit');
			expect(receivedEvents[13].event).toBe('loop_detected');
			expect(receivedEvents[14].event).toBe('scope_violation');
			expect(receivedEvents[15].event).toBe('qa_skip_violation');
			expect(receivedEvents[16].event).toBe('heartbeat');

			// Verify data for some methods
			expect(receivedEvents[0].data.sessionId).toBe('s1');
			expect(receivedEvents[0].data.agentName).toBe('coder');
			expect(receivedEvents[4].data.tokens_input).toBe(0);
			expect(receivedEvents[4].data.tokens_output).toBe(0);
			expect(receivedEvents[4].data.tokens_reasoning).toBe(0);
			expect(receivedEvents[4].data.tokens_cache).toBe(0);
			expect(receivedEvents[4].data.cost_usd).toBeNull();
			expect(receivedEvents[4].data.cost_source).toBe('unavailable');
			expect(receivedEvents[10].data.fromModel).toBe('gpt-4');
			expect(receivedEvents[10].data.toModel).toBe('gpt-3.5');
		});
	});

	describe('error handling', () => {
		test('9. WriteStream error handler disables gracefully', async () => {
			initTelemetry(tempDir);
			await sleep(200);

			// Write some data to confirm stream works
			emit('session_started', { sessionId: 'test' });
			await sleep(200);

			// Force a rotation with threshold=0 to trigger stream end + recreate
			// This exercises the stream recreation path in rotateTelemetryIfNeeded
			rotateTelemetryIfNeeded(0);
			await sleep(200);

			// Verify the stream still works after rotation (no-op if telemetry disabled)
			expect(() => emit('session_ended', { sessionId: 'test' })).not.toThrow();
			await sleep(200);
		});
	});
});

describe('emit rotation wiring — regression: rotateTelemetryIfNeeded was never called from production code (#1273)', () => {
	let tempDir: string;

	beforeEach(() => {
		resetTelemetryForTesting();
		tempDir = getTempDir();
	});

	afterEach(() => {
		resetTelemetryForTesting();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	test('emit() calls rotateTelemetryIfNeeded every ROTATION_CHECK_INTERVAL emits', async () => {
		initTelemetry(tempDir);
		await sleep(100);

		// Previous code: rotateTelemetryIfNeeded was never invoked from any
		// production path. Now emit() calls it on a counter throttle.
		let rotationCalls = 0;
		const original = _internals.rotateTelemetryIfNeeded;
		_internals.rotateTelemetryIfNeeded = () => {
			rotationCalls++;
		};

		try {
			// Emit ROTATION_CHECK_INTERVAL - 1 events: rotation should NOT fire yet
			for (let i = 0; i < ROTATION_CHECK_INTERVAL - 1; i++) {
				emit('heartbeat', { sessionId: 'test' });
			}
			expect(rotationCalls).toBe(0);

			// One more emit: rotation should fire exactly once
			emit('heartbeat', { sessionId: 'test' });
			expect(rotationCalls).toBe(1);

			// Another full cycle triggers a second rotation check
			for (let i = 0; i < ROTATION_CHECK_INTERVAL; i++) {
				emit('heartbeat', { sessionId: 'test' });
			}
			expect(rotationCalls).toBe(2);
		} finally {
			_internals.rotateTelemetryIfNeeded = original;
		}
	});

	test('emit() triggers rotateTelemetryIfNeeded() which renames the file and re-opens a stream (wiring verification, requires pre-populated file)', async () => {
		initTelemetry(tempDir);
		await sleep(100);

		const telemetryPath = getTelemetryPath(tempDir);
		const rotatedPath = getRotatedPath(tempDir);

		// Pre-populate the file beyond a small rotation threshold. This is
		// required because Node/Bun WriteStream buffers data in memory and does
		// not flush to disk before rotateTelemetryIfNeeded reads the file size
		// via fs.statSync. Without pre-population, the on-disk size would be
		// smaller than the buffered size and rotation would not fire.
		fs.appendFileSync(telemetryPath, 'x'.repeat(200) + os.EOL);

		// Use a small threshold so the pre-populated data triggers rotation.
		// NOTE: This test cannot directly prove that "stream-driven growth
		// triggers rotation" without changing production code to use a sync
		// write path or awaiting stream flush before the stat check. The
		// pre-population works around WriteStream buffering to verify the
		// wiring: counter-throttle fires, file is renamed, and stream reopens.
		const original = _internals.rotateTelemetryIfNeeded;
		_internals.rotateTelemetryIfNeeded = () => rotateTelemetryIfNeeded(100);

		try {
			// Emit exactly ROTATION_CHECK_INTERVAL events to trigger one rotation
			for (let i = 0; i < ROTATION_CHECK_INTERVAL; i++) {
				emit('heartbeat', { sessionId: 'test' });
			}
			await sleep(200);

			// Old file should have been renamed to .jsonl.1
			expect(fs.existsSync(rotatedPath)).toBe(true);

			// New file should exist and accept subsequent writes
			emit('heartbeat', { sessionId: 'after-rotate' });
			await sleep(100);
			const content = fs.readFileSync(telemetryPath, 'utf-8');
			expect(content).toContain('after-rotate');
		} finally {
			_internals.rotateTelemetryIfNeeded = original;
		}
	});
});
