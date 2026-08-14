/**
 * Self-tests for the test-isolation helper.
 * Proves the composition of env + tmpdir + clock isolates correctly and
 * cleans up fully.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	captureFileBytes,
	expectFileBytesUnchanged,
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
			const tmpBase = fs.realpathSync(os.tmpdir());
			expect(state.dir.startsWith(tmpBase)).toBe(true);
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
