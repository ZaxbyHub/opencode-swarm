import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	_internals,
	complexity_hotspots,
} from '../../../src/tools/complexity-hotspots';

// Regression coverage for #2236 Sweep A, FIX 1: `getGitChurn` must surface a
// `bunSpawn` process-creation failure as a loud `error` field, not as a false
// "ran fine, found nothing" success.
//
// The bun-compat lane (#2236 F0-CORE) normalizes Bun's spawn path so process-
// creation failures no longer throw synchronously — they are described by a
// `spawnError` value on the returned subprocess, matching the Node fallback
// path's existing documented contract. This test drives that exact shape
// through the `_internals.bunSpawn` DI seam (not `mock.module`, and not a
// real bad `cwd`, which throws pre-merge and returns `spawnError` post-merge
// — either way a real spawn would be runtime-dependent here).
//
// The fix is deliberately scoped to `spawnError` only, NOT a general
// non-zero-exit check: `git log` legitimately exits non-zero (128) with
// empty, non-erroring output on a repo with no commits yet — verified
// empirically (`git init` + `git log` -> exit 128, no stdout). Treating every
// non-zero exit as a hard failure would turn that benign case into a false
// error, so the second test below pins that a bare non-zero exit with no
// `spawnError` still produces a clean empty result.

describe('complexity_hotspots — spawn failure surfaces as a loud error (#2236 FIX 1)', () => {
	const originalBunSpawn = _internals.bunSpawn;
	let tempDir: string;

	afterEach(() => {
		_internals.bunSpawn = originalBunSpawn;
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function getMockContext(directory: string): ToolContext {
		return {
			sessionID: 'test-session',
			messageID: 'test-message',
			agent: 'test-agent',
			directory,
			worktree: directory,
			abort: new AbortController().signal,
			metadata: () => ({}),
			ask: async () => undefined,
		} as ToolContext;
	}

	it('spawnError set (process never started) is reported as an error, not empty hotspots', async () => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'complexity-hotspots-spawn-')),
		);

		_internals.bunSpawn = (() => ({
			stdout: { text: async () => '' },
			stderr: { text: async () => '' },
			// exited still resolves — the Node fallback contract resolves the
			// exit promise to 1 on a process-creation failure rather than
			// rejecting it.
			exited: Promise.resolve(1),
			exitCode: null,
			spawnError: new Error('spawn git ENOENT'),
			kill() {},
		})) as typeof _internals.bunSpawn;

		const result = await complexity_hotspots.execute(
			{},
			getMockContext(tempDir),
		);
		const parsed = JSON.parse(result);

		// The bug this guards against: a spawn failure silently producing
		// `{hotspots: [], analyzedFiles: 0}` with NO error field — a false
		// "ran fine, found nothing." The fix must surface a loud error instead.
		expect(parsed.error).toBeDefined();
		expect(parsed.error).toContain('analysis failed');
		expect(parsed.error).toContain('spawn git ENOENT');
		expect(parsed.hotspots).toEqual([]);
		expect(parsed.analyzedFiles).toBe(0);
	});

	it('non-zero git log exit (e.g. empty repo, exit 128) with no spawnError does NOT throw — stays a clean empty result', async () => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'complexity-hotspots-spawn-')),
		);

		_internals.bunSpawn = (() => ({
			stdout: { text: async () => '' },
			stderr: {
				text: async () =>
					"fatal: your current branch 'main' does not have any commits yet",
			},
			exited: Promise.resolve(128),
			exitCode: 128,
			spawnError: null,
			kill() {},
		})) as typeof _internals.bunSpawn;

		const result = await complexity_hotspots.execute(
			{},
			getMockContext(tempDir),
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.hotspots).toEqual([]);
		expect(parsed.analyzedFiles).toBe(0);
	});
});
