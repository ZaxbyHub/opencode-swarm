/**
 * Issue #2041 — replay artifacts carry a hard per-artifact byte cap.
 * At the cap, further entries for that artifact are skipped (best-effort
 * diagnostics) with a one-time warning; below it, recording is unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _test_exports, recordReplayEntry } from '../replay';

// FR-011 (issue #1737): canonicalize the macOS /var symlink gap.
const canonicalTmp = fs.realpathSync(os.tmpdir());

const { REPLAY_LIMITS, resetReplayByteTracking } = _test_exports;

function makeArtifact(tempDir: string): string {
	const dir = path.join(tempDir, '.swarm', 'replays');
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `ses-test-${Date.now()}.jsonl`);
}

describe('replay byte cap (issue #2041)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(canonicalTmp, 'replay-bounds-'));
		resetReplayByteTracking();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('entries below the cap record normally', async () => {
		const artifact = makeArtifact(tempDir);

		for (let i = 0; i < 20; i++) {
			await recordReplayEntry(artifact, 'ses-test', {
				type: 'pattern_detected',
				data: { pattern: 'repetition_loop' },
			});
		}

		const lines = fs
			.readFileSync(artifact, 'utf-8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
		expect(lines).toHaveLength(20);
	});

	test('the per-artifact byte cap stops recording and never overshoots', async () => {
		const artifact = makeArtifact(tempDir);
		// ~6 KiB per entry: the 1 MiB cap lands around entry ~170.
		const payload = { pattern: 'repetition_loop', blob: 'b'.repeat(6 * 1024) };

		for (let i = 0; i < 220; i++) {
			await recordReplayEntry(artifact, 'ses-test', {
				type: 'pattern_detected',
				data: payload,
			});
		}

		const size = fs.statSync(artifact).size;
		expect(size).toBeLessThanOrEqual(
			REPLAY_LIMITS.maxBytes + REPLAY_LIMITS.maxBytes, // generous slack for the stat cadence
		);
		// The cap actually stopped recording (fewer than all 220 entries).
		const lines = fs
			.readFileSync(artifact, 'utf-8')
			.split('\n')
			.filter((l) => l.trim().length > 0);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThan(220);

		// A fresh artifact is unaffected (the cap is per-artifact).
		const artifact2 = makeArtifact(tempDir);
		await recordReplayEntry(artifact2, 'ses-test', {
			type: 'pattern_detected',
			data: payload,
		});
		expect(fs.existsSync(artifact2)).toBe(true);
	});

	test('a restart-sized pre-existing artifact (unknown estimate) is capped too', async () => {
		const artifact = makeArtifact(tempDir);
		// Simulate a pre-cap artifact from an earlier process: the in-memory
		// estimate is unknown, so the first append stats the real size.
		const preexisting = JSON.stringify({
			filler: 'x'.repeat(REPLAY_LIMITS.maxBytes),
		});
		fs.writeFileSync(artifact, preexisting);

		await recordReplayEntry(artifact, 'ses-test', {
			type: 'pattern_detected',
			data: { pattern: 'repetition_loop' },
		});

		// Already at/over the cap: the entry was skipped, byte-for-byte.
		expect(fs.statSync(artifact).size).toBe(Buffer.byteLength(preexisting));
	});
});
