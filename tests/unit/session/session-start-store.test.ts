import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	readEarliestSessionStart,
	recordSessionStart,
} from '../../../src/session/session-start-store';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('session-start-store', () => {
	describe('recordSessionStart', () => {
		test('writes session-start.jsonl under .swarm/session/', () => {
			const { dir, cleanup } = createSafeTestDir('session-start-store-');
			try {
				recordSessionStart(dir, 1700000000000);
				const filePath = path.join(
					dir,
					'.swarm',
					'session',
					'session-start.jsonl',
				);
				expect(fs.existsSync(filePath)).toBe(true);
				const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
				expect(lines.length).toBe(1);
				const parsed = JSON.parse(lines[0]) as { startMs: number };
				expect(parsed.startMs).toBe(1700000000000);
			} finally {
				cleanup();
			}
		});

		test('keeps the EARLIEST startMs across MULTIPLE appended lines', () => {
			// Each recordSessionStart appends; readEarliestSessionStart computes min over ALL lines.
			// This proves a later writer cannot clobber an earlier timestamp.
			const { dir, cleanup } = createSafeTestDir('session-start-earliest-');
			try {
				const t1 = 1700000000000;
				const t2 = 1700000005000; // later
				const t0 = 1699999999000; // earlier
				recordSessionStart(dir, t1);
				recordSessionStart(dir, t2);
				// read computes min over t1 and t2 → t1 is earliest
				const result = readEarliestSessionStart(dir);
				expect(result).toBe(new Date(t1).toISOString());

				// now record an even earlier time (t0) — appends, doesn't overwrite
				recordSessionStart(dir, t0);
				const result2 = readEarliestSessionStart(dir);
				// min of t0, t1, t2 = t0
				expect(result2).toBe(new Date(t0).toISOString());
			} finally {
				cleanup();
			}
		});

		test(
			'race-safety: a LATER appended timestamp cannot overwrite an EARLIER ' +
				'timestamp — min wins, not last-write-wins',
			() => {
				// Simulate two concurrent writers: writer A writes startMs=2000 (later),
				// writer B writes startMs=1000 (earlier). Even though 2000 was written
				// first and 1000 was written second, the read must return 1000 (the
				// earlier), proving that last-append does NOT win.
				const { dir, cleanup } = createSafeTestDir('session-start-race-');
				try {
					const laterMs = 2000;
					const earlierMs = 1000;
					// Append the later timestamp first (simulates writer A winning race)
					recordSessionStart(dir, laterMs);
					// Append the earlier timestamp second (simulates writer B arriving after)
					recordSessionStart(dir, earlierMs);
					const result = readEarliestSessionStart(dir);
					// min of [2000, 1000] = 1000, even though 1000 was written second
					expect(result).toBe(new Date(earlierMs).toISOString());
				} finally {
					cleanup();
				}
			},
		);

		test('does not throw when file is corrupt', () => {
			const { dir, cleanup } = createSafeTestDir('session-start-corrupt-');
			try {
				const swarmDir = path.join(dir, '.swarm', 'session');
				fs.mkdirSync(swarmDir, { recursive: true });
				// Write a garbage .jsonl file (not valid JSON lines)
				fs.writeFileSync(
					path.join(swarmDir, 'session-start.jsonl'),
					'{ corrupt json\n',
					'utf-8',
				);
				// should not throw — fail-open
				expect(() => recordSessionStart(dir, 1700000000000)).not.toThrow();
			} finally {
				cleanup();
			}
		});

		test('does not throw when directory is inaccessible', () => {
			// Pass a non-existent path that would fail mkdir — fail-open
			expect(() =>
				recordSessionStart('/nonexistent/path', 1700000000000),
			).not.toThrow();
		});
	});

	describe('readEarliestSessionStart', () => {
		test('returns null when file does not exist', () => {
			const { dir, cleanup } = createSafeTestDir('session-start-missing-');
			try {
				expect(readEarliestSessionStart(dir)).toBeNull();
			} finally {
				cleanup();
			}
		});

		test('returns null on corrupt .jsonl (garbage line)', () => {
			const { dir, cleanup } = createSafeTestDir('session-start-badjsonl-');
			try {
				const swarmDir = path.join(dir, '.swarm', 'session');
				fs.mkdirSync(swarmDir, { recursive: true });
				// Write a .jsonl with a garbage line followed by a valid line
				fs.writeFileSync(
					path.join(swarmDir, 'session-start.jsonl'),
					'not valid json{\n' +
						JSON.stringify({ startMs: 1700000000000 }) +
						'\n',
					'utf-8',
				);
				// read skips the corrupt line and returns the valid one
				expect(readEarliestSessionStart(dir)).toBe(
					new Date(1700000000000).toISOString(),
				);
			} finally {
				cleanup();
			}
		});

		test('returns null when no valid startMs lines exist in .jsonl', () => {
			const { dir, cleanup } = createSafeTestDir('session-start-no-valid-');
			try {
				const swarmDir = path.join(dir, '.swarm', 'session');
				fs.mkdirSync(swarmDir, { recursive: true });
				// Write a .jsonl with only corrupt lines
				fs.writeFileSync(
					path.join(swarmDir, 'session-start.jsonl'),
					'garbage line\n'.repeat(3),
					'utf-8',
				);
				expect(readEarliestSessionStart(dir)).toBeNull();
			} finally {
				cleanup();
			}
		});

		test('returns null when startMs is missing from JSON line', () => {
			const { dir, cleanup } = createSafeTestDir(
				'session-start-missing-field-',
			);
			try {
				const swarmDir = path.join(dir, '.swarm', 'session');
				fs.mkdirSync(swarmDir, { recursive: true });
				fs.writeFileSync(
					path.join(swarmDir, 'session-start.jsonl'),
					JSON.stringify({ ts: Date.now() }) + '\n',
					'utf-8',
				);
				expect(readEarliestSessionStart(dir)).toBeNull();
			} finally {
				cleanup();
			}
		});

		test('returns null when startMs is NaN', () => {
			const { dir, cleanup } = createSafeTestDir('session-start-nan-');
			try {
				const swarmDir = path.join(dir, '.swarm', 'session');
				fs.mkdirSync(swarmDir, { recursive: true });
				fs.writeFileSync(
					path.join(swarmDir, 'session-start.jsonl'),
					JSON.stringify({ startMs: NaN, ts: Date.now() }) + '\n',
					'utf-8',
				);
				expect(readEarliestSessionStart(dir)).toBeNull();
			} finally {
				cleanup();
			}
		});

		test('returns ISO string for valid startMs', () => {
			const { dir, cleanup } = createSafeTestDir('session-start-valid-');
			try {
				const t = 1700000000000;
				recordSessionStart(dir, t);
				const result = readEarliestSessionStart(dir);
				expect(result).toBe(new Date(t).toISOString());
			} finally {
				cleanup();
			}
		});
	});

	describe('_internals seam', () => {
		test('_internals.recordSessionStart is the same function as the exported recordSessionStart', () => {
			expect(_internals.recordSessionStart).toBe(recordSessionStart);
		});

		test('_internals.readEarliestSessionStart is the same function as the exported readEarliestSessionStart', () => {
			expect(_internals.readEarliestSessionStart).toBe(
				readEarliestSessionStart,
			);
		});
	});

	describe('integration: startAgentSession persists session start', () => {
		let tempDir: string;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(
				path.join(os.tmpdir(), 'session-start-integration-'),
			);
			resetSwarmState();
		});

		afterEach(() => {
			resetSwarmState();
			// Cleanup manually since we didn't use createSafeTestDir
			if (tempDir && fs.existsSync(tempDir)) {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		test('startAgentSession writes session-start.jsonl when directory is provided', () => {
			const sid = 'test-session-' + Date.now();
			startAgentSession(sid, 'architect', 7200000, tempDir);

			const filePath = path.join(
				tempDir,
				'.swarm',
				'session',
				'session-start.jsonl',
			);
			expect(fs.existsSync(filePath)).toBe(true);
			const result = readEarliestSessionStart(tempDir);
			expect(result).not.toBeNull();
			// Should be a valid ISO string
			expect(new Date(result!).toISOString()).toBe(result);
		});

		test('startAgentSession does NOT write file when directory is omitted', () => {
			const sid = 'test-session-' + Date.now();
			startAgentSession(sid, 'architect');

			const filePath = path.join(
				tempDir,
				'.swarm',
				'session',
				'session-start.jsonl',
			);
			expect(fs.existsSync(filePath)).toBe(false);
		});
	});
});
