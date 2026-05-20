import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Static-analysis purity tests for `src/lang/backends/`.
 *
 * Per AGENTS.md invariant 2 (runtime portability): no top-level `bun:`
 * imports, no `Bun.*` calls outside `src/utils/bun-compat.ts`.
 *
 * Per AGENTS.md invariant 3 (subprocesses): backends never spawn — they
 * return command-arrays only. The single spawn site stays in
 * `src/tools/test-runner.ts` (and the binary-availability helper in
 * `src/build/discovery.ts:isCommandAvailable` which already satisfies all
 * four invariant-3 properties as of Phase 0).
 *
 * These tests fail at PR time if a backend file accidentally pulls in
 * `bun:` or `bunSpawn`/`spawn`/`spawnSync`.
 */

const BACKENDS_DIR = path.join(
	__dirname,
	'..',
	'..',
	'..',
	'src',
	'lang',
	'backends',
);

function listBackendFiles(): string[] {
	return fs
		.readdirSync(BACKENDS_DIR)
		.filter((f) => f.endsWith('.ts'))
		.map((f) => path.join(BACKENDS_DIR, f));
}

describe('src/lang/backends/* purity (invariants 2 + 3)', () => {
	test('directory exists and has at least one backend', () => {
		const files = listBackendFiles();
		expect(files.length).toBeGreaterThan(0);
	});

	test('no file imports from "bun:..." (invariant 2 — runtime portability)', () => {
		for (const f of listBackendFiles()) {
			const src = fs.readFileSync(f, 'utf-8');
			// Match any import statement whose source starts with `bun:`.
			expect(src).not.toMatch(/from\s+['"]bun:[^'"]+['"]/);
			expect(src).not.toMatch(/import\s*\(\s*['"]bun:/);
		}
	});

	test('no file references the global `Bun.*` API (invariant 2)', () => {
		for (const f of listBackendFiles()) {
			const src = fs.readFileSync(f, 'utf-8');
			// Reject `Bun.foo` patterns. Allow comments and strings to mention
			// `Bun` for documentation purposes — strip line comments first.
			const stripped = src
				.replace(/\/\/[^\n]*/g, '')
				.replace(/\/\*[\s\S]*?\*\//g, '');
			expect(stripped).not.toMatch(/\bBun\.[a-zA-Z]/);
		}
	});

	test('no file imports a spawn primitive (invariant 3 — backends return arrays only)', () => {
		// Backends never spawn. Allowed: importing `isCommandAvailable` from
		// `../../build/discovery` (which itself satisfies invariant 3 — see
		// Phase 0 commit).
		for (const f of listBackendFiles()) {
			const src = fs.readFileSync(f, 'utf-8');
			expect(src).not.toMatch(/import\s+.*bunSpawn(?:Sync)?\s+from/);
			expect(src).not.toMatch(
				/import\s+.*\bspawn(?:Sync)?\b.*from\s+['"]node:child_process['"]/,
			);
			// Direct `bunSpawn(` or `spawnSync(` usage (defensive — would catch
			// inline shadowing too).
			const stripped = src
				.replace(/\/\/[^\n]*/g, '')
				.replace(/\/\*[\s\S]*?\*\//g, '');
			expect(stripped).not.toMatch(/\bbunSpawn(?:Sync)?\s*\(/);
			expect(stripped).not.toMatch(/\bspawn(?:Sync)?\s*\(/);
		}
	});
});
