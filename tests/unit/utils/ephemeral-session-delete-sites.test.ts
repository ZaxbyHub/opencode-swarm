/**
 * Source-scan invariant: every ephemeral session teardown must route through the
 * awaited-abort-then-delete helpers (#2123).
 *
 * A raw `session.delete(...)` (or `client.session.delete(...)`) at a call site
 * would reintroduce the FOREIGN KEY constraint race — opencode's async
 * `SessionProcessor.cleanup` final part/message flush would land after the
 * cascade-delete. This test fails if any src/ file outside the two owning
 * helpers reintroduces a direct session-delete call, so a future per-site
 * revert cannot slip through with green tests.
 *
 * Modeled on the established source-scan pattern in
 * `tests/unit/build/bundle-portability.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, test } from 'bun:test';

const SRC_ROOT = join(import.meta.dir, '..', '..', '..', 'src');

/** Files that OWN the session-delete primitive and may call it directly. */
const ALLOWED_OWNERS = new Set(
	['src/utils/ephemeral-session-teardown.ts', 'src/evaluation/ephemeral-agent-dispatcher.ts'].map(
		(p) => p.split('/').join(sep),
	),
);

/** Recursively collect every .ts file under a directory. */
function collectTsFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) collectTsFiles(full, out);
		else if (entry.name.endsWith('.ts')) out.push(full);
	}
	return out;
}

/**
 * Matches a direct session-delete call:
 *   session.delete({...}) | client.session.delete(...) | .delete({ path: { id ... }})
 * The `path: { id` shape is the opencode SDK delete signature and is specific
 * enough to avoid matching unrelated `.delete(` calls (e.g. Map.delete).
 */
const RAW_DELETE_PATTERN = /\.(?:session\.)?delete\(\s*\{\s*path:\s*\{\s*id/;

describe('ephemeral session teardown — no raw session.delete outside the helpers (#2123)', () => {
	test('every session delete call lives in an owning helper module', () => {
		const files = collectTsFiles(SRC_ROOT);
		expect(files.length).toBeGreaterThan(100); // sanity: we actually scanned src/

		const offenders: string[] = [];
		for (const file of files) {
			const rel = file.slice(file.indexOf(`${sep}src${sep}`) + 1);
			if (ALLOWED_OWNERS.has(rel)) continue;
			const src = readFileSync(file, 'utf8');
			// Strip line comments to avoid matching commented-out deletes.
			const stripped = src.replace(/^\s*\/\/.*$/gm, '');
			if (RAW_DELETE_PATTERN.test(stripped)) {
				offenders.push(rel);
			}
		}

		expect(offenders).toEqual([]);
	});
});
