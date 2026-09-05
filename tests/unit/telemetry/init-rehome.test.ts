/**
 * Telemetry re-home on project-directory change (issue #2472 W9, AC-10).
 *
 * Previous behavior: initTelemetry latched the FIRST project directory for
 * the lifetime of the process — a second server() instance initializing in
 * the same process for another project root never got a telemetry stream, so
 * its `.swarm/telemetry.jsonl` was never created and its events were silently
 * written into (or dropped by) the first project's stream.
 *
 * New contract: initTelemetry(dirA) followed by initTelemetry(dirB) flushes
 * and closes dirA's stream best-effort and re-initializes for dirB exactly
 * as a fresh init does. Same-directory re-init remains an idempotent no-op.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	emit,
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function telemetryPath(dir: string): string {
	return path.join(dir, '.swarm', 'telemetry.jsonl');
}

/** Bounded poll for a file predicate — mirrors the frozen check-c10 harness. */
async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return predicate();
}

async function readIfExists(filePath: string): Promise<string> {
	await waitFor(() => fs.existsSync(filePath));
	if (!fs.existsSync(filePath)) return '';
	try {
		return fs.readFileSync(filePath, 'utf-8');
	} catch {
		return '';
	}
}

describe('telemetry re-home on directory change (#2472 W9)', () => {
	let dirA: string;
	let dirB: string;

	beforeEach(() => {
		resetTelemetryForTesting();
		dirA = canonicalMkdtemp('telemetry-rehome-a-');
		dirB = canonicalMkdtemp('telemetry-rehome-b-');
	});

	afterEach(() => {
		resetTelemetryForTesting();
		for (const dir of [dirA, dirB]) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	test('init A then init B: both telemetry.jsonl files exist and B receives subsequent events', async () => {
		initTelemetry(dirA);
		emit('session_started', { sessionId: 'before-rehome' });
		await waitFor(() => fs.existsSync(telemetryPath(dirA)));

		// Re-home: different project directory in the same process.
		initTelemetry(dirB);
		emit('session_started', { sessionId: 'after-rehome' });

		await waitFor(() => fs.existsSync(telemetryPath(dirB)));

		// Both streams' files exist (B's was previously never created).
		expect(fs.existsSync(telemetryPath(dirA))).toBe(true);
		expect(fs.existsSync(telemetryPath(dirB))).toBe(true);

		// A received only its pre-re-home event — its stream was closed, so
		// the post-re-home event must NOT land in A.
		const contentA = await readIfExists(telemetryPath(dirA));
		expect(contentA).toContain('before-rehome');
		expect(contentA).not.toContain('after-rehome');

		// B receives subsequent events.
		const contentB = await readIfExists(telemetryPath(dirB));
		expect(contentB).toContain('after-rehome');
		expect(contentB).not.toContain('before-rehome');
	});

	test('same-directory re-init stays an idempotent no-op (no re-home churn)', async () => {
		initTelemetry(dirB);
		emit('session_started', { sessionId: 'same-dir-1' });
		await waitFor(() => fs.existsSync(telemetryPath(dirB)));

		expect(() => initTelemetry(dirB)).not.toThrow();
		emit('session_started', { sessionId: 'same-dir-2' });

		const content = await readIfExists(telemetryPath(dirB));
		expect(content).toContain('same-dir-1');
		expect(content).toContain('same-dir-2');
		// No second project ever initialized — dirA was never touched.
		expect(fs.existsSync(telemetryPath(dirA))).toBe(false);
	});

	test('events emitted before any init are dropped without creating a file', () => {
		expect(() =>
			emit('session_started', { sessionId: 'pre-init' }),
		).not.toThrow();
		expect(fs.existsSync(telemetryPath(dirA))).toBe(false);
		expect(fs.existsSync(telemetryPath(dirB))).toBe(false);
	});
});
