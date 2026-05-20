/**
 * Bundle plugin-shape regression test.
 *
 * This test simulates OpenCode's actual plugin loader contract from
 * packages/opencode/src/plugin/index.ts:
 *
 *   1. applyPlugin first calls readV1Plugin(mod, spec, "server", "detect").
 *      readV1Plugin returns mod.default if it is a record with at least one
 *      of { id, server, tui } — otherwise it returns undefined.
 *   2. If readV1Plugin returns undefined, applyPlugin falls back to
 *      getLegacyPlugins(mod) which iterates Object.values(mod). Every value
 *      must be either a function OR an object with a function-typed `.server`
 *      method, or a TypeError is thrown.
 *
 * Issue #675 closed three releases (6.86.6, 6.86.7, 6.86.8) where the bundle
 * had default=function (so readV1Plugin in detect mode returned undefined)
 * AND a top-level `deferredWarnings` array re-export (so getLegacyPlugins
 * threw and OpenCode silently dropped the entire plugin).
 *
 * This test passes ONLY when:
 *   (a) mod.default is acceptable to readV1Plugin in detect mode, AND
 *   (b) every Object.values(mod) entry would survive getLegacyPlugins.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const BUNDLE = join(REPO_ROOT, 'dist', 'index.js');

/**
 * Mirror of OpenCode's readV1Plugin behavior in detect mode.
 * See packages/opencode/src/plugin/shared.ts.
 */
function readV1PluginDetect(
	mod: Record<string, unknown>,
): { id?: unknown; server?: unknown; tui?: unknown } | undefined {
	const value = mod.default;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const v = value as Record<string, unknown>;
	if (!('id' in v) && !('server' in v) && !('tui' in v)) {
		return undefined;
	}
	return v as { id?: unknown; server?: unknown; tui?: unknown };
}

/**
 * Mirror of OpenCode's getServerPlugin used by getLegacyPlugins.
 * Returns the plugin function if accepted, undefined to signal a TypeError throw.
 */
function isAcceptableLegacyExport(value: unknown): boolean {
	if (typeof value === 'function') return true;
	if (!value || typeof value !== 'object') return false;
	if (!('server' in value)) return false;
	const server = (value as Record<string, unknown>).server;
	return typeof server === 'function';
}

describe('bundle plugin-shape contract', () => {
	test('mod.default satisfies readV1Plugin in detect mode', async () => {
		if (!existsSync(BUNDLE)) {
			throw new Error(
				`Bundle missing at ${BUNDLE}. Run \`bun run build\` before this test.`,
			);
		}
		const bundleUrl = pathToFileURL(BUNDLE).href;
		const mod = (await import(bundleUrl)) as Record<string, unknown>;

		const v1 = readV1PluginDetect(mod);
		expect(
			v1,
			"mod.default must be an object with at least one of { id, server, tui } so OpenCode's readV1Plugin succeeds in detect mode. A bare-function default fails this contract and falls back to getLegacyPlugins (issue #675).",
		).toBeDefined();

		// For server plugins, verify server is a function and id is a non-empty string.
		if (v1?.server !== undefined) {
			expect(typeof v1.server, 'mod.default.server must be a function').toBe(
				'function',
			);
		}
		if (v1?.id !== undefined) {
			expect(typeof v1.id, 'mod.default.id must be a string').toBe('string');
			expect(
				(v1.id as string).length,
				'mod.default.id must be non-empty',
			).toBeGreaterThan(0);
		}
	}, 5_000);

	test('every Object.values(mod) entry survives getLegacyPlugins', async () => {
		if (!existsSync(BUNDLE)) {
			throw new Error(
				`Bundle missing at ${BUNDLE}. Run \`bun run build\` before this test.`,
			);
		}
		const bundleUrl = pathToFileURL(BUNDLE).href;
		const mod = (await import(bundleUrl)) as Record<string, unknown>;

		// Iterate Object.entries (not Object.values) so we can name the offending key on failure.
		for (const [key, value] of Object.entries(mod)) {
			const accepted = isAcceptableLegacyExport(value);
			const detail =
				typeof value === 'object' && value !== null
					? Array.isArray(value)
						? `array (length ${(value as unknown[]).length})`
						: `object (no server method)`
					: typeof value;
			expect(
				accepted,
				`Export "${key}" is ${detail} — OpenCode's getLegacyPlugins would throw TypeError on this value, silently dropping the plugin (issue #675). All top-level exports must be either functions or objects with a function-typed .server method.`,
			).toBe(true);
		}
	}, 5_000);
});
