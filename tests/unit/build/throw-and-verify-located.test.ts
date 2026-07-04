import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../../');
const BUNDLE = path.join(ROOT, 'dist/index.js');

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
		// Calling with an invalid ctx (no usable directory) forces init to throw,
		// which the wrapper re-throws — proving the try/catch/rethrow scope survived
		// minification and errors propagate to the caller.
		await expect(
			mod.default.server({ directory: null as never }),
		).rejects.toThrow();
	});

	test('minified bundle: a thrown error carries a readable stack with preserved identifiers', async () => {
		const mod = await import(BUNDLE);
		let caught: unknown;
		try {
			await mod.default.server({ directory: null as never });
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
