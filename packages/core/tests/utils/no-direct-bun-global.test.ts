/**
 * Source-scan guardrail for direct `Bun.*` primitive usage (issue #3151).
 *
 * The plugin must function under Node hosts (OpenCode Desktop sidecar), where
 * the `Bun` global does not exist. Every `Bun.spawn` / `Bun.spawnSync` /
 * `Bun.write` / `Bun.file` / `Bun.hash` call in plugin source therefore has to
 * route through the runtime-portability shim in
 * `packages/core/src/utils/bun-compat.ts` (exported from the core barrel).
 *
 * This test scans every `.ts` file under `packages/core/src` and
 * `packages/opencode/src` and fails on any direct reference that survives
 * comment stripping. The compat module itself is the single sanctioned
 * exception.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Sites that could not be routed through the compat shim, with a reason.
 * The goal is an EMPTY list — every entry is tracked debt, not an
 * endorsement. File paths are relative to the repository root with
 * forward slashes (e.g. "packages/core/src/tools/lint.ts").
 */
const ALLOWED_DIRECT_BUN_SITES: ReadonlyArray<{ file: string; reason: string }> =
	[];

/** The one module allowed to touch `Bun.*` directly: the shim itself. */
const COMPAT_MODULE = 'packages/core/src/utils/bun-compat.ts';

const DIRECT_BUN_CALL = /\bBun\s*\.\s*(spawn|spawnSync|write|file|hash)\b/;

/** Root package directories scanned by this guardrail. */
const SCAN_ROOTS = [
	'packages/core/src',
	'packages/opencode/src',
] as const;

/**
 * Reads a file's source text.
 *
 * `bun test` runs every test file in ONE shared process, and sibling test
 * files exist that register `vi.mock('node:fs', ...)` factories (which do
 * not spread the real exports — e.g. knowledge-migrator.test.ts). That mock
 * can leak into this file's `node:fs` binding mid-suite, making
 * `readFileSync` return `undefined` for arbitrary paths. When the ambient
 * read is tampered with, fall back to the runtime-native reader so the
 * guardrail keeps scanning instead of crashing with a confusing TypeError.
 */
async function readSourceText(file: string): Promise<string> {
	const viaFs = fs.readFileSync(file, 'utf-8');
	if (typeof viaFs === 'string') return viaFs;
	return Bun.file(file).text();
}

/** Repo root = four levels above this test file (tests/utils -> core -> packages -> root). */
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');

function toRepoRelative(absolutePath: string): string {
	return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

/**
 * Strips comments so documentation prose (e.g. "routes Bun.write through the
 * shim") does not trip the scan. Simple by design:
 *   - full-line `//` comments
 *   - `/* ... *​/` block comments (dotall, non-greedy)
 * Inline trailing `// code // comment` text is intentionally NOT stripped —
 * a real call followed by a comment would then hide, and a comment that
 * mentions Bun.write mid-line is rare enough to be worth rewriting when
 * flagged.
 */
function stripComments(source: string): string {
	return source
		.replace(/^[ \t]*\/\/.*$/gm, '')
		.replace(/\/\*[\s\S]*?\*\//g, '');
}

function collectTypeScriptFiles(rootDir: string): string[] {
	const out: string[] = [];
	const stack: string[] = [rootDir];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === 'dist') continue;
				stack.push(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
			if (entry.name.endsWith('.test.ts')) continue;
			out.push(full);
		}
	}
	return out;
}

describe('no direct Bun.* global usage in plugin source', () => {
	test('every Bun.* call site routes through the bun-compat shim', async () => {
		const violations: string[] = [];
		let scanned = 0;

		for (const relativeRoot of SCAN_ROOTS) {
			const rootDir = path.join(REPO_ROOT, relativeRoot);
			for (const file of collectTypeScriptFiles(rootDir)) {
				const repoRelative = toRepoRelative(file);
				if (repoRelative === COMPAT_MODULE) continue;

				const allowed = ALLOWED_DIRECT_BUN_SITES.find(
					(entry) => entry.file === repoRelative,
				);
				if (allowed) continue;

				const source = await readSourceText(file);
				scanned++;
				if (DIRECT_BUN_CALL.test(stripComments(source))) {
					violations.push(
						`${repoRelative}: direct Bun.spawn/spawnSync/write/file/hash reference — route through packages/core/src/utils/bun-compat.ts`,
					);
				}
			}
		}

		// Sanity: the scan must actually see the trees it guards. If the layout
		// moves, a zero-file scan would silently pass forever.
		expect(scanned).toBeGreaterThan(100);

		expect(violations).toEqual([]);
	});

	test('allowlist entries reference real files (keeps the list honest)', () => {
		for (const entry of ALLOWED_DIRECT_BUN_SITES) {
			expect(
				fs.existsSync(path.join(REPO_ROOT, entry.file)),
				`allowlist entry does not exist: ${entry.file}`,
			).toBe(true);
			expect(entry.reason.length).toBeGreaterThan(0);
		}
	});
});
