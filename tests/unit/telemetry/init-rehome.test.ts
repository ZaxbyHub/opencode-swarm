/**
 * Telemetry re-home on project-directory change (issue #2472 W9, AC-10).
 *
 * Previous behavior: initTelemetry latched the FIRST project directory for
 * the lifetime of the process — a second server() instance initializing in
 * the same process for another project root never got a telemetry stream, so
 * its `.swarm/telemetry.jsonl` was never created and its events were silently
 * written into (or dropped by) the first project's stream.
 *
 * New contract: initTelemetry(dirA) followed by initTelemetry(dirB)
 * re-initializes for dirB exactly as a fresh init does, publishes the NEW
 * stream BEFORE closing the old one (no `_writeStream === null` drop window;
 * PR #2588 finding 6 / PRR-019), retains the old stream when the new one
 * cannot be created (fail-open ownership retention), and detects
 * same-directory inits through canonical project-root identity. Same-directory
 * re-init remains an idempotent no-op.
 *
 * Ownership: last-init-wins — the newest successful init owns the single live
 * stream for the process; per-event project routing is out of scope (#2472).
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
	// performance.now polling deadline — the sanctioned test-clock pattern for
	// polling waits (not clock-dependent logic).
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
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

/**
 * Poll until the file exists AND contains `marker` (append streams settle
 * asynchronously), then return its content. Returns the last-read content
 * when the deadline passes so the caller's `toContain` failure is informative.
 */
async function waitForContent(
	filePath: string,
	marker: string,
	timeoutMs = 2000,
): Promise<string> {
	await waitFor(() => {
		try {
			return fs.readFileSync(filePath, 'utf-8').includes(marker);
		} catch {
			return false;
		}
	}, timeoutMs);
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

	test('failed new-stream creation retains the previous project\u2019s stream (fail-open ownership retention)', async () => {
		initTelemetry(dirA);
		emit('session_started', { sessionId: 'fail-rehome-a1' });
		await waitFor(() => fs.existsSync(telemetryPath(dirA)));

		// A regular file as the project root: `mkdir <file>/.swarm` fails
		// synchronously (ENOTDIR), so NEW-stream creation throws mid-re-home.
		const notAProject = path.join(dirA, 'not-a-project.txt');
		fs.writeFileSync(notAProject, 'not a directory');
		expect(() => initTelemetry(notAProject)).not.toThrow();

		// The old stream was RETAINED (not closed, telemetry not disabled):
		// post-failure events keep flowing into project A's file.
		emit('session_started', { sessionId: 'fail-rehome-a2' });
		const contentA = await waitForContent(
			telemetryPath(dirA),
			'fail-rehome-a2',
		);
		expect(contentA).toContain('fail-rehome-a1');
		expect(contentA).toContain('fail-rehome-a2');

		// Ownership contract: a later SUCCESSFUL init still re-homes.
		initTelemetry(dirB);
		emit('session_started', { sessionId: 'fail-rehome-b1' });
		await waitFor(() => fs.existsSync(telemetryPath(dirB)));
		const contentB = await waitForContent(
			telemetryPath(dirB),
			'fail-rehome-b1',
		);
		expect(contentB).toContain('fail-rehome-b1');
		expect(contentB).not.toContain('fail-rehome-a2');
	});

	test('windows case-variant spelling of the same root keeps the stream destination (canonical same-directory check)', async () => {
		if (process.platform !== 'win32') return;
		initTelemetry(dirA);
		emit('session_started', { sessionId: 'case-fold-1' });
		await waitFor(() => fs.existsSync(telemetryPath(dirA)));

		// Windows filesystems are case-insensitive and the same-directory
		// check canonicalizes through canonical-root (case-folded): the
		// differently-cased spelling is the SAME root, so this must be an
		// idempotent no-op, never a churn/throw.
		expect(() => initTelemetry(dirA.toUpperCase())).not.toThrow();
		emit('session_started', { sessionId: 'case-fold-2' });

		const content = await waitForContent(telemetryPath(dirA), 'case-fold-2');
		expect(content).toContain('case-fold-1');
		expect(content).toContain('case-fold-2');
	});
});
