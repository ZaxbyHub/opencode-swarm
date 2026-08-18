import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';

const ROOT = path.resolve(import.meta.dir, '../../../');
const BUNDLE = path.join(ROOT, 'dist/index.js');

/**
 * Issue #2010 isolation for a boot of the BUILT bundle.
 *
 * `server()` here runs against a bare `mkdtemp` directory with no project
 * config, which is the exact shape that makes config-doctor fall back to — and
 * REWRITE — the developer's real `~/.config/opencode/opencode-swarm.json`. Two
 * independent guards, both applied to the bundle's own module instance:
 *
 *   1. `createIsolatedTestEnv()` repoints `XDG_CONFIG_HOME` (and friends) into a
 *      temp root, so "the user's global config" IS a temp root.
 *   2. `overrideIndexInternalsForTest` — re-exported by `dist/index.js`, so the
 *      seam IS reachable for a bundle import; it stubs the post-resolution queue
 *      that is config-doctor's only caller and that would otherwise recreate
 *      this test's temp dir after teardown as a permanent orphan in the
 *      system temp directory.
 *
 * File-scoped (`beforeAll`/`afterAll`) rather than per-test, matching
 * `tests/helpers/index-commands-shared.ts`: Bun runs test files sequentially in
 * one process, so a restore skipped by a throwing per-test teardown would leak
 * the override into every later file.
 */
let restoreIsolatedEnv: () => void = () => {};
let restoreBundleInternals: () => void = () => {};

beforeAll(async () => {
	restoreIsolatedEnv = createIsolatedTestEnv().cleanup;
	const mod = await import(BUNDLE);
	restoreBundleInternals = mod.overrideIndexInternalsForTest({
		schedulePostResolutionTasks: () => {},
	});
});

afterAll(() => {
	// Restore the module seam FIRST: if the env teardown throws, the override
	// must already be off so it cannot leak into the next test file.
	restoreBundleInternals();
	restoreBundleInternals = () => {};
	restoreIsolatedEnv();
	restoreIsolatedEnv = () => {};
});

// FR-007.1 throw-and-verify-located release gate.
// Verifies the BUILT minified bundle (dist/index.js, built with
// --minify-whitespace --minify-syntax, NO --minify-identifiers) runs correctly
// and propagates errors — de-risking --minify-syntax scope/correctness
// (esbuild #648 precedent). Identifier names are preserved, so function names
// remain readable in stack traces.
describe('throw-and-verify-located release gate (FR-007.1)', () => {
	test('minified bundle: server() runs and returns a plugin with a config hook', async () => {
		const mod = await import(BUNDLE);
		expect(mod.default).toEqual(
			expect.objectContaining({ id: 'opencode-swarm' }),
		);
		expect(typeof mod.default.server).toBe('function');

		// Positive runtime-integrity: server() with a real temp directory must
		// execute the bundled init path and return the plugin object. If
		// --minify-syntax had broken scope/control-flow, this would fail.
		const dir = mkdtempSync(path.join(os.tmpdir(), 'ocsm-tv-'));
		try {
			const plugin = await mod.default.server({ directory: dir });
			expect(plugin).toEqual(
				expect.objectContaining({ config: expect.any(Function) }),
			);
			// config() requires a valid config object for a real project; for this
			// release-gate test we only need to prove the hook survived minification.
			expect(typeof plugin.config).toBe('function');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('minified bundle: server() re-throws when initialization fails (error propagation intact)', async () => {
		const mod = await import(BUNDLE);
		// server() wraps init in try/catch and re-throws (src/index.ts OpenCodeSwarm).
		// Passing `null` as the entire ctx (not `{ directory: null }`) forces a
		// synchronous TypeError when `ctx.directory` is accessed — BEFORE any of
		// the parallel init I/O's `.catch` fallbacks are constructed, so it is
		// not swallowed. This proves the wrapper's try/catch/rethrow scope
		// survived minification and errors propagate to the caller.
		//
		// (Pre-#1782, `{ directory: null }` was used as the trigger, but the
		// parallel init I/O now wraps config/snapshot/git-exclude reads in
		// `.catch` fallbacks that swallow the resulting rejection. A `null` ctx
		// throws synchronously before that wrapper exists.)
		await expect(mod.default.server(null as never)).rejects.toThrow();
	});

	test('minified bundle: a thrown error carries a readable stack with preserved identifiers', async () => {
		const mod = await import(BUNDLE);
		let caught: unknown;
		try {
			await mod.default.server(null as never);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		// Assertion 1: a bundled frame with file:line:col (FR-007.1 "reported file/line").
		// Assertion 2: a preserved function identifier — path-only matches cannot satisfy this,
		// which proves --minify-identifiers was NOT enabled (the runtime complement to the
		// distContains grep assertions).
		const stack = (caught as Error).stack ?? '';
		expect(stack).toMatch(/dist[\\/]index\.js:\d+:\d+/);
		expect(stack).toMatch(/\binitializeOpenCodeSwarm\b/);
	});
});
