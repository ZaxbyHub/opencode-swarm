#!/usr/bin/env node
/**
 * Issue #2487 parity-harness driver — SQLite close/reopen + restart parity
 * for the observability sink, plan-ledger SQLite backend, and coordination
 * store, under REAL Node (`node:sqlite` via src/db/sqlite-loader.ts).
 *
 * Wired as `bun run repro:2487` (bun builds the entry -> node runs this
 * driver) and as a CI smoke step on Linux/macOS/Windows next to repro:1873.
 * Requires a Node with flag-free `node:sqlite` (Node 22.13+; CI smoke pins
 * node 22).
 */

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(ROOT, 'dist-build-test', 'repro-2487');
const ENTRY = resolve(OUT_DIR, 'repro-2487-parity-entry.js');

function fail(message) {
	console.error(`[repro-2487] ${message}`);
	process.exit(1);
}

if (!existsSync(ENTRY)) {
	fail(
		`entry bundle missing: ${ENTRY} — build it first (bun run repro:2487 does this)`,
	);
}

try {
	// Importing runs the entry's top-level `await main()`: any parity-check
	// failure throws (or sets process.exitCode) inside the entry, so the catch
	// below is the only failure surface. (The old `mod === undefined` guard
	// was dead code — a module namespace object is never nullish.)
	await import(pathToFileURL(ENTRY).href);
} catch (error) {
	fail(`entry failed to run under Node: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	// The build output is git-ignored scratch; remove it so concurrent or
	// repeated runs cannot observe a stale bundle.
	try {
		rmSync(OUT_DIR, { recursive: true, force: true });
	} catch {
		// best-effort cleanup only
	}
}
