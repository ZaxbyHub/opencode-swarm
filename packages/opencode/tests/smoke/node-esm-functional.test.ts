import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Node-host smoke for the 8.x plugin entry (issues #3151, critic F7).
 *
 * CI runs under bun, which can never reproduce the Node-host failure class
 * that shipped in 8.0.x-beta (the bundle emitted `var __require =
 * import.meta.require` under `--target bun`, crashing module evaluation under
 * Node; and direct `Bun.*` calls throw ReferenceError under Node). These
 * tests spawn the REAL node binary against the BUILT artifact:
 *
 *  1. import the bundle and assert the dual-shape default export;
 *  2. boot the plugin (`default.server({directory})`) in a temp project and
 *     assert the v1 hook map returns — under Node this exercises the init
 *     path including the snapshot reader that silently degraded at base;
 *  3. run one real write+read cycle through the compat layer (bunWrite /
 *     bunFile re-exported from the bundle's core barrel surface);
 *  4. run one real spawn through `bunSpawnSync` (FB-012) — executes the
 *     shim's Node fallback branch, which is dead code when CI runs bun.
 *
 * The `dist` build must exist; these tests fail (not skip) when it is stale
 * or missing so CI cannot silently lose the Node gate.
 */

const PKG_DIR = path.resolve(import.meta.dir, '../..');
const DIST_ENTRY = path.join(PKG_DIR, 'dist', 'index.js');
const REPO_ROOT = path.resolve(PKG_DIR, '../..');

function runNode(script: string): { status: number | null; stdout: string; stderr: string } {
	const res = spawnSync(process.execPath.includes('bun') ? 'node' : process.execPath, [
		'--input-type=module',
		'--eval',
		script,
	], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		timeout: 120_000,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, NODE_NO_WARNINGS: '1' },
	});
	return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('node-host smoke (issue #3151, critic F7)', () => {
	test('dist exists and default export is the dual-shape object', () => {
		const res = runNode(`
const m = await import(${JSON.stringify(pathToFileURL(DIST_ENTRY).href)});
const d = m.default;
if (typeof d !== 'object' || d === null) { console.log('SHAPE_FAIL typeof ' + typeof d); process.exit(1); }
if (d.id !== 'opencode-swarm') { console.log('SHAPE_FAIL id ' + d.id); process.exit(1); }
if (typeof d.server !== 'function') { console.log('SHAPE_FAIL server ' + typeof d.server); process.exit(1); }
if (typeof d.setup !== 'function') { console.log('SHAPE_FAIL setup ' + typeof d.setup); process.exit(1); }
console.log('SHAPE_OK');
`);
		expect(res.stderr).toBe('');
		expect(res.stdout).toContain('SHAPE_OK');
		expect(res.status).toBe(0);
	});

	test('plugin boots under node and returns the v1 hook map', () => {
		const tmp = mkdtempSync(path.join(tmpdir(), 'ocswarm-node-smoke-'));
		try {
			const res = runNode(`
const { pathToFileURL } = await import('node:url');
const path = await import('node:path');
const m = await import(${JSON.stringify(pathToFileURL(DIST_ENTRY).href)});
const hooks = await m.default.server({ directory: ${JSON.stringify(tmp)} });
const keys = Object.keys(hooks ?? {}).sort();
const required = ['agent', 'config', 'tool'];
const missing = required.filter((k) => !(k in (hooks ?? {})));
console.log('BOOT_KEYS=' + keys.join(','));
if (missing.length > 0) { console.log('BOOT_FAIL missing ' + missing.join(',')); process.exit(1); }
console.log('BOOT_OK');
`);
			expect(res.stdout).toContain('BOOT_OK');
			expect(res.stdout).toContain('BOOT_KEYS=');
			// The 8.x factory logs startup progress on stderr by design
			// (pre-existing behavior); only a FATAL init failure fails this leg.
			expect(res.stderr).not.toContain('FATAL');
			expect(res.status).toBe(0);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('compat write+read cycle works under node', () => {
		const res = runNode(`
const { pathToFileURL } = await import('node:url');
const os = await import('node:os');
const path = await import('node:path');
const m = await import(${JSON.stringify(pathToFileURL(DIST_ENTRY).href)});
if (typeof m.bunWrite !== 'function' || typeof m.bunFile !== 'function') {
	console.log('COMPAT_FAIL exports missing');
	process.exit(1);
}
const target = path.join(os.tmpdir(), 'ocswarm-node-compat-' + Date.now() + '.txt');
await m.bunWrite(target, 'compat-roundtrip');
const text = await m.bunFile(target).text();
if (text !== 'compat-roundtrip') { console.log('COMPAT_FAIL readback ' + text); process.exit(1); }
const { rmSync } = await import('node:fs');
rmSync(target, { force: true });
console.log('COMPAT_OK');
`);
		expect(res.stderr).toBe('');
		expect(res.stdout).toContain('COMPAT_OK');
		expect(res.status).toBe(0);
	});

	// FB-012 (PR #3163 feedback): execute the shim's REAL spawn path under
	// Node. CI runs bun, where the Node fallback branch of bunSpawnSync is
	// dead code; a win32 .cmd/.bat or portability regression in that branch
	// can only be caught by spawning node itself. `['node','--version']`
	// resolves on all three CI OSes without depending on npm/git presence.
	test('compat bunSpawnSync spawns a real child under node', () => {
		const res = runNode(`
const { pathToFileURL } = await import('node:url');
const m = await import(${JSON.stringify(pathToFileURL(DIST_ENTRY).href)});
if (typeof m.bunSpawnSync !== 'function') {
	console.log('COMPAT_FAIL bunSpawnSync export missing: ' + typeof m.bunSpawnSync);
	process.exit(1);
}
const r = m.bunSpawnSync(['node', '--version']);
console.log('SPAWN_EXIT=' + r.exitCode + ' STDOUT=' + new TextDecoder().decode(r.stdout).trim());
if (r.exitCode !== 0) { console.log('COMPAT_FAIL exit ' + r.exitCode); process.exit(1); }
if (!new TextDecoder().decode(r.stdout).trim()) { console.log('COMPAT_FAIL empty stdout'); process.exit(1); }
console.log('SPAWN_OK');
`);
		expect(res.stderr).toBe('');
		expect(res.stdout).toContain('SPAWN_OK');
		// The version output must actually contain a digit (e.g. v22.x.y).
		expect(/STDOUT=v?\d/.test(res.stdout)).toBe(true);
		expect(res.status).toBe(0);
	});
});
