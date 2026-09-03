/**
 * Self-tests for the test-isolation helper.
 * Proves the composition of env + tmpdir + clock isolates correctly and
 * cleans up fully.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCanonicalPathWithinRoot } from '../../src/utils/path-security.js';
import {
	captureFileBytes,
	collectCleanupError,
	expectFileBytesUnchanged,
	runWithCleanup,
	setupIsolatedState,
	withIsolatedState,
} from './test-isolation.js';

afterEach(() => {
	mock.restore();
});

describe('setupIsolatedState', () => {
	test('returns a temp dir under os.tmpdir() and an isolated config dir', () => {
		const state = setupIsolatedState({ prefix: 'iso-test-' });
		try {
			expect(isCanonicalPathWithinRoot(state.dir, os.tmpdir())).toBe(true);
			expect(fs.existsSync(state.dir)).toBe(true);
			expect(state.configDir).toBeTruthy();
			// Env vars pointed at the isolated config dir.
			expect(process.env.XDG_CONFIG_HOME).toBe(state.configDir);
			expect(process.env.APPDATA).toBe(state.configDir);
		} finally {
			state.cleanup();
		}
	});

	test('cleanup removes the temp dir and restores env', () => {
		let dir: string | undefined;
		let configHomeBefore: string | undefined;
		{
			const state = setupIsolatedState({ prefix: 'iso-cleanup-' });
			dir = state.dir;
			configHomeBefore = process.env.XDG_CONFIG_HOME;
			expect(fs.existsSync(dir)).toBe(true);
			state.cleanup();
		}
		// dir gone
		expect(dir).toBeDefined();
		expect(fs.existsSync(dir as string)).toBe(false);
		// env no longer points at the (now-deleted) config dir
		expect(process.env.XDG_CONFIG_HOME).not.toBe(configHomeBefore);
	});

	test('restoreClock is null when no clock requested', () => {
		const state = setupIsolatedState({});
		try {
			expect(state.restoreClock).toBeNull();
		} finally {
			state.cleanup();
		}
	});

	test('clock: true freezes the clock at the default instant', () => {
		const state = setupIsolatedState({ clock: true });
		try {
			expect(Date.now()).toBe(0);
			expect(Date.now()).toBe(0);
		} finally {
			state.cleanup();
		}
	});

	test('clock: { fixedNow } freezes the clock at the given instant', () => {
		const state = setupIsolatedState({ clock: { fixedNow: 5_555 } });
		try {
			expect(Date.now()).toBe(5_555);
		} finally {
			state.cleanup();
		}
		expect(state.restoreClock).not.toBeNull();
	});

	test('cleanup restores the clock even when clock was requested', () => {
		const frozen = Date.now();
		void frozen;
		{
			const state = setupIsolatedState({ clock: { fixedNow: 1 } });
			expect(Date.now()).toBe(1);
			state.cleanup();
		}
		// Real clock back.
		expect(Date.now()).not.toBe(1);
	});

	test('writing a file under state.dir works and is removed on cleanup', () => {
		let dir: string | undefined;
		{
			const state = setupIsolatedState({ prefix: 'iso-write-' });
			dir = state.dir;
			const f = path.join(state.dir, 'hello.txt');
			fs.writeFileSync(f, 'hi');
			expect(fs.existsSync(f)).toBe(true);
			state.cleanup();
		}
		expect(fs.existsSync(dir as string)).toBe(false);
	});

	test('captureFileBytes and expectFileBytesUnchanged detect silent mutation', () => {
		const state = setupIsolatedState({ prefix: 'iso-bytes-' });
		try {
			const file = path.join(state.dir, 'tracked.json');
			const original = Buffer.from('{"value":1}\n');
			fs.writeFileSync(file, original);
			const snapshot = captureFileBytes(file);
			expect(snapshot).not.toBeNull();
			if (snapshot === null) {
				return;
			}
			fs.writeFileSync(file, Buffer.from('{"value":2}\n'));
			expect(() => expectFileBytesUnchanged(file, snapshot)).toThrow(
				/Tracked file mutated/i,
			);
			fs.writeFileSync(file, snapshot);
		} finally {
			state.cleanup();
		}
	});
});

describe('withIsolatedState', () => {
	test('provides isolated state to fn and cleans up after', async () => {
		let capturedDir: string | undefined;
		const result = await withIsolatedState(
			async (state) => {
				capturedDir = state.dir;
				fs.writeFileSync(path.join(state.dir, 'x'), '1');
				return 42;
			},
			{ prefix: 'iso-with-' },
		);
		expect(result).toBe(42);
		expect(capturedDir).toBeDefined();
		expect(fs.existsSync(capturedDir as string)).toBe(false);
	});

	test('cleans up even when fn throws', async () => {
		let capturedDir: string | undefined;
		await expect(
			withIsolatedState(
				async (state) => {
					capturedDir = state.dir;
					throw new Error('nope');
				},
				{ prefix: 'iso-throw-' },
			),
		).rejects.toThrow('nope');
		expect(capturedDir).toBeDefined();
		expect(fs.existsSync(capturedDir as string)).toBe(false);
	});

	test('clock option freezes time within fn and restores after', async () => {
		const out = await withIsolatedState(
			async () => {
				return [Date.now(), Date.now()];
			},
			{ clock: { fixedNow: 9_999 } },
		);
		expect(out).toEqual([9_999, 9_999]);
		// Restored after.
		expect(Date.now()).not.toBe(9_999);
	});
});

describe('setupIsolatedState — cleanup robustness (F-007)', () => {
	test('cleanup removes the temp dir even when a clock was active', () => {
		// Covers the F-007 concern: all three teardown steps (clock, env, dir)
		// run independently so a failure in one does not skip the dir removal.
		let capturedDir: string | undefined;
		{
			const state = setupIsolatedState({ clock: { fixedNow: 5 } });
			capturedDir = state.dir;
			expect(fs.existsSync(capturedDir)).toBe(true);
			expect(Date.now()).toBe(5);
			state.cleanup();
		}
		expect(capturedDir).toBeDefined();
		// The dir removal (the last step) ran despite the clock being active.
		expect(fs.existsSync(capturedDir as string)).toBe(false);
		// Clock restored.
		expect(Date.now()).not.toBe(5);
	});

	test('cleanup is safe to call when no clock was requested', () => {
		// The clock step is a no-op (restoreClock is null) — env + dir still run.
		let capturedDir: string | undefined;
		{
			const state = setupIsolatedState({ prefix: 'iso-noclock-' });
			capturedDir = state.dir;
			state.cleanup();
		}
		expect(fs.existsSync(capturedDir as string)).toBe(false);
	});

	test('a throwing step does not skip later steps (F-007 error isolation)', () => {
		// Drive the _internals.runCleanup seam directly with a throwing middle
		// (env) step and assert the dir step STILL runs and the first error is
		// re-thrown. This is the actual contract the per-step try/catch exists
		// to enforce (a leak in one step must not skip the temp-dir removal).
		const { _internals } = require('./test-isolation.js');
		let dirRan = false;
		let threw: unknown = null;
		try {
			_internals.runCleanup(
				null,
				() => {
					throw new Error('env boom');
				},
				() => {
					dirRan = true;
				},
			);
		} catch (e) {
			threw = e;
		}
		expect(dirRan).toBe(true); // dir step ran despite env throwing
		expect((threw as Error)?.message).toBe('env boom'); // first error re-thrown
	});
});

describe('captureFileBytes / expectFileBytesUnchanged — absence branches', () => {
	test('captureFileBytes returns null for a file that does not exist', () => {
		const state = setupIsolatedState({ prefix: 'iso-absent-' });
		try {
			expect(captureFileBytes(path.join(state.dir, 'nope.json'))).toBeNull();
		} finally {
			state.cleanup();
		}
	});

	test('a still-absent file matches a null snapshot without throwing', () => {
		const state = setupIsolatedState({ prefix: 'iso-absent-ok-' });
		try {
			const missing = path.join(state.dir, 'nope.json');
			expect(() => expectFileBytesUnchanged(missing, null)).not.toThrow();
		} finally {
			state.cleanup();
		}
	});

	test('a file created after a null snapshot is reported as appeared', () => {
		const state = setupIsolatedState({ prefix: 'iso-appeared-' });
		try {
			const file = path.join(state.dir, 'appeared.json');
			const snapshot = captureFileBytes(file);
			expect(snapshot).toBeNull();
			fs.writeFileSync(file, '{}\n');
			expect(() => expectFileBytesUnchanged(file, snapshot)).toThrow(
				/Tracked file unexpectedly appeared/,
			);
		} finally {
			state.cleanup();
		}
	});

	test('a file deleted after a byte snapshot is reported as deleted', () => {
		const state = setupIsolatedState({ prefix: 'iso-deleted-' });
		try {
			const file = path.join(state.dir, 'deleted.json');
			fs.writeFileSync(file, '{"a":1}\n');
			const snapshot = captureFileBytes(file);
			fs.rmSync(file);
			expect(() => expectFileBytesUnchanged(file, snapshot)).toThrow(
				/Tracked file was deleted/,
			);
		} finally {
			state.cleanup();
		}
	});

	test('an untouched file matches its byte snapshot without throwing', () => {
		const state = setupIsolatedState({ prefix: 'iso-untouched-' });
		try {
			const file = path.join(state.dir, 'stable.json');
			fs.writeFileSync(file, '{"a":1}\n');
			const snapshot = captureFileBytes(file);
			expect(() => expectFileBytesUnchanged(file, snapshot)).not.toThrow();
		} finally {
			state.cleanup();
		}
	});

	test('the mutation message reports byte counts and sha256 digests (F-018)', () => {
		// The default (preview-suppressed) message must still be actionable:
		// asserting only on the leading phrase would pass even if the diagnostic
		// body were empty.
		const state = setupIsolatedState({ prefix: 'iso-diag-' });
		try {
			const file = path.join(state.dir, 'tracked.json');
			fs.writeFileSync(file, '{"value":1}\n');
			const snapshot = captureFileBytes(file);
			fs.writeFileSync(file, '{"value":22}\n');
			let message = '';
			try {
				expectFileBytesUnchanged(file, snapshot);
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).toContain(file);
			expect(message).toMatch(/expected 12 bytes \(sha256:[0-9a-f]{16}\)/);
			expect(message).toMatch(/saw 13 bytes \(sha256:[0-9a-f]{16}\)/);
			expect(message).toContain('SWARM_TEST_FILE_PREVIEW=1');
			// Direct negative assertion for the redaction property (F-016): the
			// hint string above would still be present if the body ALSO leaked
			// the file's content, so assert the content literally is not there.
			expect(message).not.toContain('"value"');
		} finally {
			state.cleanup();
		}
	});

	test('SWARM_TEST_FILE_PREVIEW=1 previews are UTF-8 safe (F-013)', () => {
		// `SHOW_FILE_PREVIEW` is read once at module load, so the flag only takes
		// effect for a process that starts with it set — which is also exactly how
		// a developer uses it. A child process is therefore the honest way to
		// exercise the preview branch; toggling process.env in-process would test
		// nothing (and require_cache surgery leaks across files under bun test).
		const state = setupIsolatedState({ prefix: 'iso-utf8-' });
		try {
			const file = path.join(state.dir, 'utf8.txt');
			// 1 ASCII byte + 40x U+6F22 (3 bytes each). The 96-byte preview window
			// ends 2 bytes into the 32nd character, i.e. mid-sequence.
			fs.writeFileSync(file, `x${'漢'.repeat(40)}`);
			const probe = path.join(state.dir, 'probe.mjs');
			const helperUrl = pathToFileURL(
				path.join(import.meta.dir, 'test-isolation.ts'),
			).href;
			fs.writeFileSync(
				probe,
				[
					`import * as fs from 'node:fs';`,
					`import { captureFileBytes, expectFileBytesUnchanged } from ${JSON.stringify(helperUrl)};`,
					`const file = ${JSON.stringify(file)};`,
					`const snapshot = captureFileBytes(file);`,
					`fs.writeFileSync(file, 'y' + '\\u6f22'.repeat(40));`,
					`try { expectFileBytesUnchanged(file, snapshot); } catch (error) {`,
					`  process.stdout.write(error.message);`,
					`}`,
				].join('\n'),
			);
			const result = Bun.spawnSync([process.execPath, probe], {
				env: { ...process.env, SWARM_TEST_FILE_PREVIEW: '1' },
			});
			const message = result.stdout.toString();
			expect(message).toContain('Tracked file mutated');
			// Preview branch actually taken.
			expect(message).toContain('expected prefix:');
			expect(message).toContain('actual prefix:');
			// The straddling character is dropped, never rendered as U+FFFD.
			expect(message).not.toContain('�');
		} finally {
			state.cleanup();
		}
	});
});

describe('collectCleanupError / runWithCleanup — error primacy (F-001/F-019)', () => {
	test('a thrown falsy value is still reported as thrown', () => {
		// The pre-fix truthiness gate swallowed this entirely.
		const outcome = collectCleanupError(() => {
			throw 0;
		});
		expect(outcome.thrown).toBe(true);
		expect(outcome.error).toBe(0);
	});

	test('later steps run after an earlier throw and the FIRST error is kept', () => {
		let secondRan = false;
		let thirdRan = false;
		const outcome = collectCleanupError(
			() => {
				throw new Error('first');
			},
			() => {
				secondRan = true;
				throw new Error('second');
			},
			() => {
				thirdRan = true;
			},
		);
		expect(secondRan).toBe(true);
		expect(thirdRan).toBe(true);
		expect(outcome.thrown).toBe(true);
		expect((outcome.error as Error).message).toBe('first');
	});

	test('null/undefined steps are skipped', () => {
		let ran = false;
		const outcome = collectCleanupError(null, undefined, () => {
			ran = true;
		});
		expect(ran).toBe(true);
		expect(outcome.thrown).toBe(false);
	});

	test("runWithCleanup: the body's error wins and cleanup still runs", async () => {
		let cleanupRan = false;
		await expect(
			runWithCleanup(
				async () => {
					throw new Error('body');
				},
				() => {
					cleanupRan = true;
					throw new Error('cleanup');
				},
			),
		).rejects.toThrow('body');
		expect(cleanupRan).toBe(true);
	});

	test('runWithCleanup: a cleanup error surfaces when the body succeeded', async () => {
		await expect(
			runWithCleanup(
				async () => 'ok',
				() => {
					throw new Error('cleanup');
				},
			),
		).rejects.toThrow('cleanup');
	});

	test('runWithCleanup returns the body value when nothing throws', async () => {
		let cleanupRan = false;
		const value = await runWithCleanup(
			async () => 'value',
			() => {
				cleanupRan = true;
			},
		);
		expect(value).toBe('value');
		expect(cleanupRan).toBe(true);
	});
});
