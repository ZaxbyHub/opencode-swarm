/**
 * Parity test for `getSafeDefaultConfigLoadResult` (issue #1782).
 *
 * The factory is used as the fallback when the bounded init-path config read
 * times out (src/index.ts). It MUST produce a coherent shape the init path
 * can destructure when no config file is available — otherwise init would
 * silently crash or use a different "default" config than the loader's own
 * default path.
 *
 * Part of the test-stability sprint — see
 * `docs/audits/test-stability-audit.md`.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	getSafeDefaultConfigLoadResult,
	loadPluginConfigWithMeta,
} from '../../../src/config/loader';

describe('getSafeDefaultConfigLoadResult (issue #1782 safe-default factory)', () => {
	describe('parity with no-config-file loader output', () => {
		test('classification fields match a "no file found" load', () => {
			// Use a directory with no project-level config; a fresh mkdtempSync
			// guarantees no `.opencode/opencode-swarm.json` exists in it.
			const tmp = fs.mkdtempSync(
				path.join(os.tmpdir(), 'safe-default-parity-'),
			);
			try {
				loadPluginConfigWithMeta(tmp); // touch the loader
				const fromFactory = getSafeDefaultConfigLoadResult();

				// Classification fields — the init-path consumers of these
				// (src/index.ts) only read `config` and `loadedFromFile`, but
				// the full set must be coherent for fail-closed consumers
				// that may consult `configHadErrors` in the future.
				expect(fromFactory.loadedFromFile).toBe(false);
				expect(fromFactory.configHadErrors).toBe(false);
				expect(fromFactory.recovery).toBe('none');
				expect(fromFactory.removedKeys).toEqual([]);
				expect(fromFactory.warnings).toEqual([]);

				// The factory's shape must be a valid PluginConfig the init
				// path can destructure (non-null config with the core fields).
				expect(fromFactory.config).toBeTruthy();
				expect(typeof fromFactory.config).toBe('object');
				// init-path guardrails read uses `config.guardrails ?? {}`
				// (src/index.ts) so undefined is acceptable.
				// `quiet` schema default is `true` (src/config/schema.ts:2848).
				expect(fromFactory.config.quiet).toBe(true);
				expect(fromFactory.config.full_auto).toBeTruthy();
				expect(fromFactory.config.full_auto?.enabled).toBe(false);
			} finally {
				fs.rmSync(tmp, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 50,
				});
			}
		});

		test('returns a non-null config the init path can destructure', () => {
			const result = getSafeDefaultConfigLoadResult();
			expect(result).toBeTruthy();
			expect(result.config).toBeTruthy();
			expect(result.config.full_auto).toBeTruthy();
			expect(result.config.full_auto?.enabled).toBe(false);
			// `quiet` schema default is `true` (src/config/schema.ts:2848).
			expect(result.config.quiet).toBe(true);
		});

		test('is referentially stable — calling twice returns equivalent shape', () => {
			// Init may call this only once, but the factory must not return
			// shared mutable state that could leak across sessions.
			const a = getSafeDefaultConfigLoadResult();
			const b = getSafeDefaultConfigLoadResult();
			expect(a.config).not.toBe(b.config); // different references
			expect(a.config.full_auto).toEqual(b.config.full_auto); // same shape
			expect(a.config.quiet).toBe(b.config.quiet);
		});
	});
});
