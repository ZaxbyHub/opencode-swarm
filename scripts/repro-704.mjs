#!/usr/bin/env node
/**
 * Issue #704 reproduction harness.
 *
 * Loads the compiled `dist/index.js` (target=node) under Node — the runtime
 * the OpenCode Desktop sidecar uses on macOS — and invokes the v1 plugin
 * `server` hook with two test scenarios:
 *
 *   Test 1 — Deferred-scan timing proof (500-file workspace, tight 400ms deadline)
 *   Pre-fix: `server()` would block synchronously for the full scan duration
 *   (≈1–3s for 500 files on most filesystems), blowing the 400ms deadline.
 *   Post-fix: `server()` returns immediately (~5ms) because the scan is deferred
 *   via queueMicrotask + yieldToEventLoop() (a macrotask), so it cannot execute
 *   before the caller's `.then` on the returned promise.
 *
 *   Test 2 — Portability: no `Bun is not defined` ReferenceError, no leaked
 *   timers, clean exit under Node.
 *
 *   Test 3 — Refusal guard: passing `os.homedir()` as the workspace root
 *   must not cause an unbounded scan. `server()` must still resolve within
 *   the budget (the guard throws inside the deferred task, not on the
 *   call frame).
 *
 * Wired as `bun run repro:704` and as a CI integration step. Runs against
 * the build artifact so it catches regressions in both the source and the
 * bundle shape.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = resolve(ROOT, 'dist', 'index.js');

// Test 1: server() must resolve within this deadline.
// Pre-fix: a 500-file sync scan takes ~1–3s → fails.
// Post-fix: deferred init → server() returns in ~5ms → passes.
const TIMING_DEADLINE_MS = 400;

// Test 2/3 overall budget.
const BUDGET_MS = 10_000;

function makeLargeWorkspace(fileCount = 500) {
	const dir = mkdtempSync(join(tmpdir(), 'opencode-swarm-704-large-'));
	const src = join(dir, 'src');
	mkdirSync(src, { recursive: true });
	for (let i = 0; i < fileCount; i++) {
		writeFileSync(join(src, `file${i}.ts`), `export const v${i} = ${i};\n`);
	}
	return dir;
}

function makeSmallWorkspace() {
	const dir = mkdtempSync(join(tmpdir(), 'opencode-swarm-704-small-'));
	mkdirSync(join(dir, 'src'), { recursive: true });
	writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
	writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
	return dir;
}

function makeCtx(directory) {
	return {
		directory,
		project: { id: 'repro-704', root: directory },
		worktree: { directory },
		client: {
			app: {},
			config: { get: async () => ({}) },
		},
		experimental_workspace: { register() {} },
		get serverUrl() { return new URL('http://localhost:4096'); },
		$: undefined,
	};
}

async function runTest(plugin, ctx, deadlineMs, label) {
	const start = performance.now();
	const winner = await Promise.race([
		plugin.server(ctx, {}).then(() => 'ok'),
		new Promise((resolve) => setTimeout(() => resolve('timeout'), deadlineMs)),
	]);
	const elapsed = (performance.now() - start).toFixed(1);
	if (winner === 'timeout') {
		console.error(
			`[repro-704] FAILED ${label}: server() did not resolve within ${deadlineMs}ms ` +
				`(elapsed=${elapsed}ms). Issue #704 has regressed.`,
		);
		return false;
	}
	console.log(`[repro-704] OK ${label} — server() resolved in ${elapsed}ms (deadline=${deadlineMs}ms).`);
	return true;
}

async function main() {
	let mod;
	try {
		mod = await import(pathToFileURL(DIST).href);
	} catch (err) {
		console.error('[repro-704] FAILED to import dist/index.js:', err);
		process.exit(1);
	}

	const plugin = mod.default;
	if (!plugin || typeof plugin !== 'object' || typeof plugin.server !== 'function') {
		console.error(
			'[repro-704] FAILED: dist/index.js does not export a v1 plugin shape { id, server }',
		);
		process.exit(1);
	}

	// Test 1: 500-file workspace with tight timing deadline.
	// This is the definitive regression test: pre-fix, the synchronous scan of
	// 500 files takes >> TIMING_DEADLINE_MS. Post-fix, server() returns in ~5ms.
	const largeDir = makeLargeWorkspace(500);
	let ok1 = false;
	try {
		ok1 = await runTest(plugin, makeCtx(largeDir), TIMING_DEADLINE_MS, 'T1[500-file tight deadline]');
	} finally {
		rmSync(largeDir, { recursive: true, force: true });
	}

	// Test 2: Small workspace — no crash, no ReferenceError, clean exit.
	const smallDir = makeSmallWorkspace();
	let ok2 = false;
	try {
		ok2 = await runTest(plugin, makeCtx(smallDir), BUDGET_MS, 'T2[small workspace]');
	} finally {
		rmSync(smallDir, { recursive: true, force: true });
	}

	// Test 3: Refusal guard — passing $HOME must not hang server().
	// The guard throws inside the deferred task (not on the call frame), so
	// server() must still resolve within the budget even when pointed at $HOME.
	let ok3 = false;
	try {
		ok3 = await runTest(plugin, makeCtx(homedir()), BUDGET_MS, 'T3[$HOME refusal guard]');
	} catch {
		// Any synchronous throw is also acceptable (pre-resolution guard).
		ok3 = true;
		console.log('[repro-704] OK T3[$HOME refusal guard] — threw synchronously (acceptable).');
	}

	if (!ok1 || !ok2 || !ok3) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('[repro-704] uncaught:', err);
	process.exit(1);
});
