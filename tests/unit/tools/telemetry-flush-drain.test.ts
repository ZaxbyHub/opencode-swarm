/**
 * flushAndDrainTelemetry tests (issue #2030 item 8 + swarm-pr-review F-003).
 *
 * Extracted from tests/unit/tools/telemetry.test.ts to respect the FR-006
 * 500-line cap: that file crossed 500 lines after the flush/drain + race
 * regression tests were added. The telemetry module uses module-level state
 * (a single _writeStream), so each test here reinitializes it against its own
 * temp dir.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	addTelemetryListener,
	emit,
	flushAndDrainTelemetry,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let sharedTempDir: string;

beforeAll(() => {
	sharedTempDir = canonicalMkdtemp('telemetry-flush-');
});

beforeEach(() => {
	resetTelemetryForTesting();
	initTelemetry(sharedTempDir);
});

afterEach(() => {
	resetTelemetryForTesting();
});

afterAll(() => {
	if (sharedTempDir && fs.existsSync(sharedTempDir)) {
		fs.rmSync(sharedTempDir, { recursive: true, force: true });
	}
});

describe('flushAndDrainTelemetry (issue #2030)', () => {
	test('drains buffered records to disk so a subsequent copyFile sees them', async () => {
		const swarmDir = path.join(sharedTempDir, '.swarm');
		const telemetryPath = path.join(swarmDir, 'telemetry.jsonl');

		// Emit several records. The WriteStream buffers in memory, so
		// without a flush these may not yet be on disk.
		emit('heartbeat', { n: 1 });
		emit('heartbeat', { n: 2 });
		emit('heartbeat', { n: 3 });

		// Flush + drain: awaits the stream 'finish' callback, then reopens.
		await flushAndDrainTelemetry();

		// The on-disk file must now contain all three records (the
		// archive-copy path in close.ts reads the file directly via
		// fs.copyFile, so any unflushed buffer would be lost).
		const content = fs.readFileSync(telemetryPath, 'utf-8');
		const lines = content.split('\n').filter((l) => l.trim());
		expect(lines.length).toBe(3);
		expect(lines.every((l) => l.includes('"event":"heartbeat"'))).toBe(true);
	});

	test('subsequent emits after flush continue to write to the file', async () => {
		const swarmDir = path.join(sharedTempDir, '.swarm');
		const telemetryPath = path.join(swarmDir, 'telemetry.jsonl');

		emit('heartbeat', { before: true });
		await flushAndDrainTelemetry();
		// After flush the stream is reopened in append mode, so a further
		// emit must still land on disk after a second flush.
		emit('heartbeat', { after: true });
		await flushAndDrainTelemetry();

		const content = fs.readFileSync(telemetryPath, 'utf-8');
		expect(content).toContain('"before":true');
		expect(content).toContain('"after":true');
	});

	test('is a no-op when telemetry is not initialized', async () => {
		resetTelemetryForTesting();
		// No initTelemetry call — _writeStream is null. Must not throw.
		await flushAndDrainTelemetry();
	});

	test('a racing emit across the flush does not latch _disabled (F-003)', async () => {
		// Regression for swarm-pr-review F-003: if the replacement stream is
		// assigned only inside the end() callback, a concurrent emit() writes
		// to the ending stream, ERR_STREAM_WRITE_AFTER_END fires, and _disabled
		// latches true — killing telemetry for every subsequent session in the
		// server-scoped plugin process. The fix assigns the new stream BEFORE
		// end(). This test races an emit across the flush and asserts the
		// post-flush emit IS delivered (it would be a no-op if _disabled
		// latched) and the buffered tail is retained byte-for-byte.
		const swarmDir = path.join(sharedTempDir, '.swarm');
		const telemetryPath = path.join(swarmDir, 'telemetry.jsonl');

		// Buffer ~10 lines in the WriteStream's in-memory buffer.
		for (let i = 0; i < 10; i++) {
			emit('heartbeat', { n: i });
		}

		// Schedule an emit that races across the flush's await (setImmediate
		// fires on the next macro-task turn, during the awaited end() drain).
		const racingPayload = { race_marker: 'racing-emit' };
		setImmediate(() => emit('heartbeat', racingPayload));

		await flushAndDrainTelemetry();

		// Post-flush emit: must be delivered (proves _disabled did NOT latch).
		const receivedPost: unknown[] = [];
		const listener = (event: string, data: unknown) => {
			if (event === 'heartbeat') receivedPost.push(data);
		};
		addTelemetryListener(listener);
		emit('heartbeat', { post_flush: true });
		// Allow the listener + write to settle.
		await new Promise((r) => setImmediate(r));
		await flushAndDrainTelemetry();
		// (listener is cleared by the next beforeEach's resetTelemetryForTesting.)

		// _disabled latched? post-flush emit would be a silent no-op.
		expect(
			receivedPost.some(
				(d) =>
					d !== null &&
					typeof d === 'object' &&
					(d as { post_flush?: boolean }).post_flush === true,
			),
		).toBe(true);

		// Buffered tail retained byte-for-byte (all 10 pre-flush records + the
		// racing emit + the post-flush emit landed on disk).
		const content = fs.readFileSync(telemetryPath, 'utf-8');
		for (let i = 0; i < 10; i++) {
			expect(content).toContain(`"n":${i}`);
		}
		expect(content).toContain('"race_marker":"racing-emit"');
	});
});
