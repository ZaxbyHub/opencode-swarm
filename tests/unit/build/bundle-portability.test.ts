/**
 * Regression test for issue #675.
 *
 * The published plugin bundle (`dist/index.js`) must be loadable by any
 * conformant ESM host, not only Bun. A bare top-level `import { X } from
 * "bun:..."` is hoisted by the ESM spec and breaks Node-resolved dynamic
 * imports with `ERR_UNSUPPORTED_ESM_URL_SCHEME`, which OpenCode's plugin
 * loader silently swallows — leaving users with the plugin "in plugins" but
 * no agents/commands.
 *
 * This test scans the shipped bundles for any top-level `bun:` static import
 * and fails if one slips back in. Lazy resolution via createRequire is fine
 * (and is what we want); only top-level `import ... from "bun:..."` is
 * forbidden.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const BUNDLES = [
	join(REPO_ROOT, 'dist', 'index.js'),
	join(REPO_ROOT, 'dist', 'cli', 'index.js'),
];

const TOP_LEVEL_BUN_IMPORT_RE = /^import[^;\n]*['"]bun:[^'"\n]+['"]/m;

describe('shipped bundle portability', () => {
	for (const bundlePath of BUNDLES) {
		test(`${bundlePath.replace(REPO_ROOT, '<repo>')} has no top-level bun: imports`, () => {
			if (!existsSync(bundlePath)) {
				throw new Error(
					`Bundle missing at ${bundlePath}. Run \`bun run build\` before this test.`,
				);
			}
			const source = readFileSync(bundlePath, 'utf-8');
			const match = source.match(TOP_LEVEL_BUN_IMPORT_RE);
			expect(
				match,
				`Top-level bun: import detected — bundle is not portable to Node ESM hosts:\n  ${match?.[0]}`,
			).toBeNull();
		});
	}
});
