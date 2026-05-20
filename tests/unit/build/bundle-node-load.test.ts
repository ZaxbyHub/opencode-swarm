/**
 * Regression test for issue #675.
 *
 * The shipped plugin bundle must evaluate cleanly under Node's default ESM
 * loader. OpenCode's plugin loader does `await import(plugin.entry)`, and on
 * platforms/builds where that resolution goes through Node's loader (e.g.
 * Windows after OpenCode v1.14.19) the bundle must not throw
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME` or any other module-evaluation error.
 *
 * We don't test that the plugin function actually executes under Node — it
 * uses Bun-only runtime APIs at call time. We only test that the module
 * graph can be evaluated to completion and the default export is a
 * function. That's exactly what OpenCode's loader needs.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const BUNDLE = join(REPO_ROOT, 'dist', 'index.js');

async function nodeAvailable(): Promise<boolean> {
	try {
		const proc = Bun.spawn(['node', '--version'], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const code = await proc.exited;
		return code === 0;
	} catch {
		return false;
	}
}

describe('shipped bundle loads under Node', () => {
	test('`node --input-type=module -e "await import(dist/index.js)"` succeeds on all platforms (Linux, macOS, Windows)', async () => {
		if (!existsSync(BUNDLE)) {
			throw new Error(
				`Bundle missing at ${BUNDLE}. Run \`bun run build\` before this test.`,
			);
		}
		if (!(await nodeAvailable())) {
			// Node is normally on $PATH everywhere our CI runs, but if it's
			// genuinely missing this is an environment problem, not a bundle bug.
			console.warn('node not on PATH — skipping cross-runtime load test');
			return;
		}

		// Use file:// URL so Windows paths (with backslashes and a drive letter)
		// load correctly through Node's default ESM resolver.
		const bundleUrl = pathToFileURL(BUNDLE).href;
		// v1 plugin shape: default must be an object with `id` (string) and `server` (function).
		// See issue #675 — a bare-function default falls through to OpenCode's legacy
		// iterator and silently breaks plugin loading.
		const script = `const m = await import(${JSON.stringify(bundleUrl)}); if (typeof m.default !== 'object' || m.default === null) { console.error('default export is not an object:', typeof m.default); process.exit(2); } if (typeof m.default.server !== 'function') { console.error('default.server is not a function:', typeof m.default.server); process.exit(3); } if (m.default.id !== 'opencode-swarm') { console.error('default.id is not opencode-swarm:', m.default.id); process.exit(4); }`;

		const proc = Bun.spawn(['node', '--input-type=module', '-e', script], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const exitCode = await proc.exited;
		const stderr = await new Response(proc.stderr).text();

		expect(
			stderr,
			`stderr should not mention ERR_UNSUPPORTED_ESM_URL_SCHEME but got:\n${stderr}`,
		).not.toContain('ERR_UNSUPPORTED_ESM_URL_SCHEME');
		expect(stderr, `unexpected stderr:\n${stderr}`).not.toContain(
			'__require is not a function',
		);
		expect(exitCode, `node exited ${exitCode}, stderr was:\n${stderr}`).toBe(0);
	}, 30_000);
});
