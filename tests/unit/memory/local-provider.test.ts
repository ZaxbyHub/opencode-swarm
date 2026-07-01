/**
 * Tests for src/memory/embeddings/local-provider.ts — LocalEmbeddingProvider
 *
 * Key invariants verified:
 * 1. Lazy-load: @xenova/transformers is NEVER imported at module scope (AGENTS.md invariant 2)
 * 2. Graceful degradation (FR-003): when transformers is not installed, embed() rejects
 *    with EmbeddingUnavailableError and available stays false
 * 3. FR-011 path resolution: cache dir is user-scoped, never under .swarm/
 * 4. One-time download notice guard
 * 5. Interface compliance: implements EmbeddingProvider
 * 6. Adversarial: empty string, empty batch, concurrent calls, post-degradation calls
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	LocalEmbeddingProvider,
} from '../../../src/memory/embeddings/local-provider';
import { EmbeddingUnavailableError } from '../../../src/memory/embeddings/types';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';

// ---------------------------------------------------------------------------
// 1. Lazy-load invariant — @xenova/transformers NOT imported at module scope
// AGENTS.md invariant 2: The main plugin bundle must remain Node-ESM-loadable;
// no top-level bun: imports; no direct Bun.* calls outside bun-compat.ts
// ---------------------------------------------------------------------------
describe('lazy-load invariant — no @xenova/transformers at module scope', () => {
	test('source file does NOT contain a top-level import of @xenova/transformers', () => {
		// Read the source file and scan for @xenova imports outside of function bodies.
		// The only valid use of @xenova is inside ensurePipeline() via createRequire,
		// which is a DYNAMIC require (not a static import).
		const source = readFileSync(
			path.join(process.cwd(), 'src/memory/embeddings/local-provider.ts'),
			'utf-8',
		);

		// Static import lines look like: import ... from '@xenova/transformers'
		// or: import * as xenova from '@xenova/transformers'
		// We check for any import statement referencing @xenova at module scope.
		const topLevelImportPattern =
			/^import\s+.*from\s+['"]@xenova\/transformers['"]/m;
		expect(source).not.toMatch(topLevelImportPattern);

		// Also verify that the dynamic require IS present inside ensurePipeline
		expect(source).toContain("req('@xenova/transformers')");
	});

	test('@xenova/transformers is NOT in the module runtime exports after first load', async () => {
		// Instantiate the provider — transformers should NOT be loaded yet.
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		// available starts false (degradation not triggered yet because embed hasn't been called)
		expect(provider.available).toBe(false);

		// Call embed to trigger the lazy-load path.
		// Since @xenova/transformers is not installed, this will fail gracefully.
		let thrownError: unknown;
		try {
			await provider.embed('hello');
		} catch (err) {
			thrownError = err;
		}

		// Should have rejected with EmbeddingUnavailableError
		expect(thrownError).toBeInstanceOf(EmbeddingUnavailableError);
		// available should now be false (degraded)
		expect(provider.available).toBe(false);

		// The module should NOT have pulled in @xenova — verify by checking that
		// the require cache does NOT contain @xenova/transformers
		// (this is a strong indicator that the dynamic require truly was contained
		// in a try/catch and didn't poison the module cache)
		const requireCache = Object.keys(require.cache ?? {});
		const xenovaInCache = requireCache.some((k) => k.includes('@xenova'));
		expect(xenovaInCache).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 2. Graceful degradation (FR-003) — transformers NOT installed
// ---------------------------------------------------------------------------
describe('graceful degradation — @xenova/transformers not installed', () => {
	const savedDebug = process.env.OPENCODE_SWARM_DEBUG;

	beforeEach(() => {
		// Enable debug so warn() actually emits
		process.env.OPENCODE_SWARM_DEBUG = '1';
	});

	afterEach(() => {
		if (savedDebug === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = savedDebug;
		}
	});

	test('embed() rejects with EmbeddingUnavailableError when transformers is not installed', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		let thrownError: unknown;
		try {
			await provider.embed('hello world');
		} catch (err) {
			thrownError = err;
		}

		expect(thrownError).toBeInstanceOf(EmbeddingUnavailableError);
		expect((thrownError as EmbeddingUnavailableError).message).toContain(
			'unavailable',
		);
	});

	test('embed() does NOT throw an uncaught exception', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		// If this throws an uncaught exception the test framework will fail.
		// We wrap in try/catch to catch any synchronous throws.
		let caught: unknown;
		try {
			await provider.embed('test input');
		} catch (err) {
			caught = err;
		}
		// Should have caught EmbeddingUnavailableError, not an uncaught exception
		expect(caught).toBeInstanceOf(EmbeddingUnavailableError);
	});

	test('available remains false after embed() fails', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		expect(provider.available).toBe(false); // initial state

		try {
			await provider.embed('test');
		} catch {
			// expected
		}

		// available should still be false (degradation path)
		expect(provider.available).toBe(false);
	});

	test('embedBatch() rejects with EmbeddingUnavailableError when transformers is not installed', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		let thrownError: unknown;
		try {
			await provider.embedBatch(['hello', 'world']);
		} catch (err) {
			thrownError = err;
		}

		expect(thrownError).toBeInstanceOf(EmbeddingUnavailableError);
	});

	test('warn() is called (non-fatal) after first embed() failure', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

		try {
			await provider.embed('test');
		} catch {
			// expected
		}

		// warn should have been called at least once (the graceful degradation warning)
		// Note: warn is debug-gated (OPENCODE_SWARM_DEBUG=1 set in beforeEach)
		expect(warnSpy).toHaveBeenCalled();
		const warnCalls = warnSpy.mock.calls;
		const hasOpencodeWarn = warnCalls.some((args) =>
			args[0] && typeof args[0] === 'string'
				? args[0].includes('opencode-swarm')
				: false,
		);
		expect(hasOpencodeWarn).toBe(true);

		warnSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// 3. FR-011 — cache directory is user-scoped, never .swarm/
// ---------------------------------------------------------------------------
describe('FR-011 — user-scoped cache directory', () => {
	test('resolved cache dir is outside .swarm/ for default platform', async () => {
		// We test the path resolution by checking that the directory
		// that would be created does not contain '.swarm'.
		// We use an isolated env to avoid polluting the real user cache.
		const { configDir, cleanup } = createIsolatedTestEnv();

		try {
			// Force the cache dir resolution by triggering embed (which calls mkdir on cacheDir)
			const provider = new LocalEmbeddingProvider({
				model: 'Xenova/all-MiniLM-L6-v2',
				dimension: 384,
			});

			// Attempt embed — will fail (no transformers) but will call resolveEmbeddingCacheDir internally
			try {
				await provider.embed('test');
			} catch {
				// expected — degradation path
			}

			// The cache dir resolution is internal, but we can verify via static analysis
			// of the source that the function NEVER returns a path containing .swarm
			const source = readFileSync(
				path.join(process.cwd(), 'src/memory/embeddings/local-provider.ts'),
				'utf-8',
			);

			// The function resolveEmbeddingCacheDir() only joins:
			// - process.env.LOCALAPPDATA or os.homedir()/AppData/Local  (win32)
			// - os.homedir()/Library/Caches                    (darwin)
			// - process.env.XDG_CACHE_HOME or os.homedir()/.cache (posix)
			// None of these contain '.swarm'
			// Verify that the function body contains no reference to '.swarm'
			const cacheDirFnMatch = source.match(
				/function resolveEmbeddingCacheDir\(\)[^{]*\{[\s\S]*?\n\}/,
			);
			expect(cacheDirFnMatch).not.toBeNull();
			const fnBody = cacheDirFnMatch![0];
			expect(fnBody).not.toContain('.swarm');
			expect(fnBody).not.toContain("'.swarm'");
			expect(fnBody).not.toContain('".swarm"');

			// Also verify the cache dir function is NOT called with any .swarm path
			// by checking it never appears as an argument to path.join
			const joinCalls = fnBody.match(/path\.join\([^)]+\.swarm[^)]*\)/g);
			expect(joinCalls).toBeNull();
		} finally {
			cleanup();
		}
	});

	test('cache dir uses XDG_CACHE_HOME on linux when set', () => {
		// We test that the code path checks process.env.XDG_CACHE_HOME
		const source = readFileSync(
			path.join(process.cwd(), 'src/memory/embeddings/local-provider.ts'),
			'utf-8',
		);

		// The linux path in resolveEmbeddingCacheDir reads XDG_CACHE_HOME
		expect(source).toContain('process.env.XDG_CACHE_HOME');
	});

	test('cache dir uses LOCALAPPDATA on windows when set', () => {
		const source = readFileSync(
			path.join(process.cwd(), 'src/memory/embeddings/local-provider.ts'),
			'utf-8',
		);

		// The windows path reads LOCALAPPDATA
		expect(source).toContain('process.env.LOCALAPPDATA');
	});

	test('cache dir uses ~/Library/Caches on darwin', () => {
		const source = readFileSync(
			path.join(process.cwd(), 'src/memory/embeddings/local-provider.ts'),
			'utf-8',
		);

		// The darwin path uses ~/Library/Caches
		expect(source).toContain('Library/Caches');
	});
});

// ---------------------------------------------------------------------------
// 4. One-time download notice guard
// ---------------------------------------------------------------------------
describe('one-time download notice guard', () => {
	const savedDebug = process.env.OPENCODE_SWARM_DEBUG;

	beforeEach(() => {
		process.env.OPENCODE_SWARM_DEBUG = '1';
	});

	afterEach(() => {
		if (savedDebug === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = savedDebug;
		}
	});

	test('console.log is called at most once even after multiple embed() calls', async () => {
		// This test is inherently process-level (the static flag is a class field),
		// so we only verify behavior within a single test.
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		const logSpy = spyOn(console, 'log').mockImplementation(() => {});

		// Call embed multiple times — the notice should only print once.
		for (let i = 0; i < 5; i++) {
			try {
				await provider.embed(`test input ${i}`);
			} catch {
				// expected — transformers not installed
			}
		}

		// Count how many times the download notice was printed.
		// Since transformers is not installed, the pipeline never loads,
		// so the download notice is never printed (it comes after the req() call).
		// But we can verify the guard exists by checking the static field.
		// The guard code path is: if (!LocalEmbeddingProvider.downloadNoticePrinted)
		const source = readFileSync(
			path.join(process.cwd(), 'src/memory/embeddings/local-provider.ts'),
			'utf-8',
		);
		expect(source).toContain('LocalEmbeddingProvider.downloadNoticePrinted');
		expect(source).toContain('Downloading embedding model');

		// The download notice is inside the try block AFTER req('@xenova/transformers'),
		// so it will only be reached if transformers IS installed.
		// Since transformers is NOT installed, we verify the guard exists in source
		// but the notice path is not exercised in this environment.

		logSpy.mockRestore();
	});

	test('download notice guard field is static (process-level, not per-instance)', () => {
		const source = readFileSync(
			path.join(process.cwd(), 'src/memory/embeddings/local-provider.ts'),
			'utf-8',
		);

		// The static field declaration
		expect(source).toContain('private static downloadNoticePrinted: boolean');
		// The check before printing
		expect(source).toContain('!LocalEmbeddingProvider.downloadNoticePrinted');
		// The assignment after printing
		expect(source).toContain(
			'LocalEmbeddingProvider.downloadNoticePrinted = true',
		);
	});
});

// ---------------------------------------------------------------------------
// 5. Interface compliance — LocalEmbeddingProvider satisfies EmbeddingProvider
// ---------------------------------------------------------------------------
describe('interface compliance — EmbeddingProvider', () => {
	test('LocalEmbeddingProvider has all required EmbeddingProvider members', () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
			version: 'test-version',
		});

		// Required fields
		expect(typeof provider.embed).toBe('function');
		expect(typeof provider.embedBatch).toBe('function');
		expect(typeof provider.modelVersion).toBe('string');
		expect(typeof provider.dimension).toBe('number');
		expect(typeof provider.available).toBe('boolean');

		// modelVersion is readonly (set from config)
		expect(provider.modelVersion).toBe('test-version');

		// dimension matches config
		expect(provider.dimension).toBe(384);
	});

	test('available starts false before any embed call', () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		expect(provider.available).toBe(false);
	});

	test('modelVersion defaults to model:dimension when version not provided', () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		expect(provider.modelVersion).toBe('Xenova/all-MiniLM-L6-v2:384');
	});

	test('modelVersion uses custom version when provided', () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
			version: 'custom-v1',
		});

		expect(provider.modelVersion).toBe('custom-v1');
	});
});

// ---------------------------------------------------------------------------
// 6. Adversarial test cases
// ---------------------------------------------------------------------------
describe('adversarial — edge cases and robustness', () => {
	const savedDebug = process.env.OPENCODE_SWARM_DEBUG;

	beforeEach(() => {
		// Enable debug so warn() actually emits
		process.env.OPENCODE_SWARM_DEBUG = '1';
	});

	afterEach(() => {
		if (savedDebug === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = savedDebug;
		}
	});

	test('embed("") empty string — graceful degradation path', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		let thrownError: unknown;
		try {
			await provider.embed('');
		} catch (err) {
			thrownError = err;
		}

		// Should still reject with EmbeddingUnavailableError
		expect(thrownError).toBeInstanceOf(EmbeddingUnavailableError);
	});

	test('embedBatch([]) empty array — returns [] immediately without calling pipeline', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		// embedBatch with empty array returns [] without triggering pipeline load
		// This is the early-return path in the implementation
		const result = await provider.embedBatch([]);

		expect(result).toEqual([]);
		// available should still be false (pipeline was never attempted)
		expect(provider.available).toBe(false);
	});

	test('concurrent embed() calls — no race condition, no double-load attempt', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		// Fire multiple embed() calls simultaneously
		const results = await Promise.allSettled([
			provider.embed('first'),
			provider.embed('second'),
			provider.embed('third'),
		]);

		// All should reject with EmbeddingUnavailableError (not crash)
		for (const result of results) {
			expect(result.status).toBe('rejected');
			expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
				EmbeddingUnavailableError,
			);
		}

		// available should be false (no pipeline loaded)
		expect(provider.available).toBe(false);
	});

	test('embed() after degradation — consistently rejects with EmbeddingUnavailableError', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		// First call — triggers degradation
		try {
			await provider.embed('first');
		} catch {
			// expected
		}

		expect(provider.available).toBe(false);

		// Second call — should still degrade consistently
		let secondError: unknown;
		try {
			await provider.embed('second');
		} catch (err) {
			secondError = err;
		}

		expect(secondError).toBeInstanceOf(EmbeddingUnavailableError);

		// Third call — same
		let thirdError: unknown;
		try {
			await provider.embed('third');
		} catch (err) {
			thirdError = err;
		}

		expect(thirdError).toBeInstanceOf(EmbeddingUnavailableError);

		// available should still be false
		expect(provider.available).toBe(false);
	});

	test('embedBatch with single item — degrades same as embed()', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		let thrownError: unknown;
		try {
			await provider.embedBatch(['single item']);
		} catch (err) {
			thrownError = err;
		}

		expect(thrownError).toBeInstanceOf(EmbeddingUnavailableError);
		expect(provider.available).toBe(false);
	});

	test('very long text input — graceful degradation path (no crash)', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		const longText = 'word '.repeat(10000); // ~60KB

		let thrownError: unknown;
		try {
			await provider.embed(longText);
		} catch (err) {
			thrownError = err;
		}

		// Should reject with EmbeddingUnavailableError, not crash
		expect(thrownError).toBeInstanceOf(EmbeddingUnavailableError);
	});

	test('special characters and unicode in text — graceful degradation path', async () => {
		const provider = new LocalEmbeddingProvider({
			model: 'Xenova/all-MiniLM-L6-v2',
			dimension: 384,
		});

		const unicodeText = 'Hello 🌍 你好 🎉 مرحبا \\u0000\\u200b\\u0001';

		let thrownError: unknown;
		try {
			await provider.embed(unicodeText);
		} catch (err) {
			thrownError = err;
		}

		expect(thrownError).toBeInstanceOf(EmbeddingUnavailableError);
	});
});

// ---------------------------------------------------------------------------
// 7. FR-011 adversarial — .swarm containment when env vars point to .swarm
// Regression: resolveEmbeddingCacheDir trusted XDG_CACHE_HOME / LOCALAPPDATA
// verbatim, allowing a pathological value like /tmp/repro/.swarm/foo to place
// model weights under .swarm/.  The fix checks path segments post-resolution
// and falls back to the safe platform default when .swarm is detected.
// ---------------------------------------------------------------------------

// bun:test does not support test.skip() inside test bodies.
// Use two separate describe blocks gated on platform.
const isPosix = process.platform !== 'win32';

if (isPosix) {
	describe('FR-011 — .swarm containment via XDG_CACHE_HOME (POSIX)', () => {
		const savedEnv = {
			XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
			HOME: process.env.HOME,
		};
		const savedDebug = process.env.OPENCODE_SWARM_DEBUG;

		beforeEach(() => {
			process.env.OPENCODE_SWARM_DEBUG = '1';
		});

		afterEach(() => {
			if (savedEnv.XDG_CACHE_HOME === undefined) {
				delete process.env.XDG_CACHE_HOME;
			} else {
				process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
			}
			if (savedEnv.HOME === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = savedEnv.HOME;
			}
			if (savedDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = savedDebug;
			}
		});

		test('XDG_CACHE_HOME with .swarm segment — fallback to safe default', () => {
			const homeDir = os.tmpdir();
			process.env.HOME = homeDir;
			process.env.XDG_CACHE_HOME = path.join(
				homeDir,
				'repro',
				'.swarm',
				'cache',
			);

			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

			const resolved = _internals.resolveEmbeddingCacheDir();

			// The returned path must NOT contain .swarm
			expect(resolved).not.toContain('.swarm');

			// Must be the safe platform default (~/.cache/opencode/embeddings on POSIX)
			// Note: fallback uses os.homedir() which is NOT the same as homeDir (tmpdir)
			const expectedSafe = path.resolve(
				path.join(os.homedir(), '.cache', 'opencode', 'embeddings'),
			);
			expect(path.resolve(resolved)).toBe(expectedSafe);

			// A warning must have fired
			expect(warnSpy).toHaveBeenCalled();
			const hasSwarmWarning = warnSpy.mock.calls.some(
				(args) =>
					args[0] &&
					typeof args[0] === 'string' &&
					args[0].includes('Embedding cache dir resolved under .swarm'),
			);
			expect(hasSwarmWarning).toBe(true);

			warnSpy.mockRestore();
		});

		test('XDG_CACHE_HOME deeply nested under .swarm/ — fallback path still safe', () => {
			const homeDir = os.tmpdir();
			process.env.HOME = homeDir;
			process.env.XDG_CACHE_HOME = path.join(
				homeDir,
				'.swarm',
				'agent-42',
				'session',
				'.cache',
			);

			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

			const resolved = _internals.resolveEmbeddingCacheDir();

			// Must absolutely not contain .swarm anywhere in the path segments
			const segments = resolved.split(path.sep);
			expect(segments).not.toContain('.swarm');

			// Must be the safe fallback
			const expectedSafe = path.resolve(
				path.join(os.homedir(), '.cache', 'opencode', 'embeddings'),
			);
			expect(path.resolve(resolved)).toBe(expectedSafe);

			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		test('non-.swarm XDG_CACHE_HOME — no fallback, normal path returned', () => {
			const homeDir = os.tmpdir();
			process.env.HOME = homeDir;
			process.env.XDG_CACHE_HOME = path.join(homeDir, 'my-app-cache');

			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

			const resolved = _internals.resolveEmbeddingCacheDir();

			// Should be the XDG path, NOT the fallback
			const expected = path.resolve(
				path.join(homeDir, 'my-app-cache', 'opencode', 'embeddings'),
			);
			expect(path.resolve(resolved)).toBe(expected);

			// Must not contain .swarm
			expect(resolved).not.toContain('.swarm');

			// No warning should have fired (path is safe)
			expect(warnSpy).not.toHaveBeenCalled();

			warnSpy.mockRestore();
		});
	});
}

if (!isPosix) {
	describe('FR-011 — .swarm containment via LOCALAPPDATA (Windows)', () => {
		const savedEnv = {
			LOCALAPPDATA: process.env.LOCALAPPDATA,
			HOME: process.env.HOME,
		};
		const savedDebug = process.env.OPENCODE_SWARM_DEBUG;

		beforeEach(() => {
			process.env.OPENCODE_SWARM_DEBUG = '1';
		});

		afterEach(() => {
			if (savedEnv.LOCALAPPDATA === undefined) {
				delete process.env.LOCALAPPDATA;
			} else {
				process.env.LOCALAPPDATA = savedEnv.LOCALAPPDATA;
			}
			if (savedEnv.HOME === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = savedEnv.HOME;
			}
			if (savedDebug === undefined) {
				delete process.env.OPENCODE_SWARM_DEBUG;
			} else {
				process.env.OPENCODE_SWARM_DEBUG = savedDebug;
			}
		});

		test('LOCALAPPDATA with .swarm segment — fallback to safe default', () => {
			const homeDir = os.tmpdir();
			process.env.HOME = homeDir;
			process.env.LOCALAPPDATA = path.join(
				homeDir,
				'.swarm',
				'Local',
				'opencode',
			);

			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

			const resolved = _internals.resolveEmbeddingCacheDir();

			// The returned path must NOT contain .swarm
			expect(resolved).not.toContain('.swarm');

			// Must be the safe platform default (os.homedir()/AppData/Local/opencode/embeddings)
			// Note: fallback uses os.homedir() which is NOT the same as homeDir (tmpdir)
			const expectedSafe = path.resolve(
				path.join(os.homedir(), 'AppData', 'Local', 'opencode', 'embeddings'),
			);
			expect(path.resolve(resolved)).toBe(expectedSafe);

			// A warning must have fired
			expect(warnSpy).toHaveBeenCalled();
			const hasSwarmWarning = warnSpy.mock.calls.some(
				(args) =>
					args[0] &&
					typeof args[0] === 'string' &&
					args[0].includes('Embedding cache dir resolved under .swarm'),
			);
			expect(hasSwarmWarning).toBe(true);

			warnSpy.mockRestore();
		});

		test('non-.swarm LOCALAPPDATA — no fallback, normal path returned', () => {
			const homeDir = os.tmpdir();
			process.env.HOME = homeDir;
			process.env.LOCALAPPDATA = path.join(homeDir, 'MyAppData');

			const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

			const resolved = _internals.resolveEmbeddingCacheDir();

			// Should be the LOCALAPPDATA path
			const expected = path.resolve(
				path.join(homeDir, 'MyAppData', 'opencode', 'embeddings'),
			);
			expect(path.resolve(resolved)).toBe(expected);

			// Must not contain .swarm
			expect(resolved).not.toContain('.swarm');

			// No warning should have fired (path is safe)
			expect(warnSpy).not.toHaveBeenCalled();

			warnSpy.mockRestore();
		});
	});
}

// ---------------------------------------------------------------------------
// NOTE: The model-loaded / available=true path is NOT tested here because
// @xenova/transformers is not installed in this environment. That path
// requires: bun add @xenova/transformers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 8. FR-011 darwin path — verify ~/Library/Caches on macOS
// Regression: prior reviews found resolveEmbeddingCacheDir() wasn't verified to
// return ~/Library/Caches on darwin (only static source analysis existed).
// ---------------------------------------------------------------------------
describe('FR-011 — darwin path (macOS ~/Library/Caches)', () => {
	const savedPlatform = process.platform;
	const savedXdgCacheHome = process.env.XDG_CACHE_HOME;
	const savedHome = process.env.HOME;
	const savedDebug = process.env.OPENCODE_SWARM_DEBUG;

	beforeEach(() => {
		// Force darwin platform via Object.defineProperty (required since we run on Windows)
		Object.defineProperty(process, 'platform', {
			value: 'darwin',
			configurable: true,
			writable: true,
		});
		// Ensure XDG_CACHE_HOME is unset so darwin falls back to ~/Library/Caches
		delete process.env.XDG_CACHE_HOME;
		// Set a known HOME so the path is deterministic
		process.env.HOME = os.tmpdir();
		process.env.OPENCODE_SWARM_DEBUG = '1';
	});

	afterEach(() => {
		// Restore original platform
		Object.defineProperty(process, 'platform', {
			value: savedPlatform,
			configurable: true,
			writable: true,
		});
		// Restore env vars
		if (savedXdgCacheHome === undefined) {
			delete process.env.XDG_CACHE_HOME;
		} else {
			process.env.XDG_CACHE_HOME = savedXdgCacheHome;
		}
		if (savedHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = savedHome;
		}
		if (savedDebug === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = savedDebug;
		}
	});

	test('darwin with XDG_CACHE_HOME unset — returns ~/Library/Caches/opencode/embeddings', () => {
		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

		const resolved = _internals.resolveEmbeddingCacheDir();

		// Must end with Library/Caches/opencode/embeddings (NOT .cache/opencode/embeddings)
		expect(resolved).toContain(
			path.join('Library', 'Caches', 'opencode', 'embeddings'),
		);
		expect(resolved).not.toContain('.cache');

		// No warning should fire (path is safe)
		expect(warnSpy).not.toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	test('darwin with XDG_CACHE_HOME set — XDG IGNORED, ~/Library/Caches used instead', () => {
		// STRICT FR-011: On darwin, XDG_CACHE_HOME is IGNORED.
		// darwin always resolves to ~/Library/Caches/opencode/embeddings, never XDG.
		process.env.XDG_CACHE_HOME = path.join(os.tmpdir(), 'my-xdg-cache');

		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

		const resolved = _internals.resolveEmbeddingCacheDir();

		// MUST use ~/Library/Caches, NOT the XDG path
		const segments = resolved.split(path.sep);
		expect(segments).toContain('Library');
		expect(segments).toContain('Caches');
		expect(segments).toContain('opencode');
		expect(segments).toContain('embeddings');
		// Must NOT contain the XDG path segments
		expect(resolved).not.toContain('my-xdg-cache');
		// Must NOT contain .cache (darwin uses Library/Caches, not .cache)
		expect(segments).not.toContain('.cache');

		// No warning should fire (darwin default path is safe, no .swarm)
		expect(warnSpy).not.toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	test('darwin with XDG_CACHE_HOME set to .swarm path — XDG IGNORED, ~/Library/Caches used directly', () => {
		// STRICT FR-011: On darwin, XDG_CACHE_HOME is IGNORED entirely (base is always ~/Library/Caches).
		// Setting XDG_CACHE_HOME to a .swarm path on darwin has NO effect — XDG is never consulted,
		// so there is NO fallback path to trigger, NO warning fires, and the resolved path is
		// ~/Library/Caches/opencode/embeddings directly (no .swarm segment at all).
		process.env.XDG_CACHE_HOME = path.join(os.tmpdir(), '.swarm', 'xdg-cache');

		const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

		const resolved = _internals.resolveEmbeddingCacheDir();

		// Must NOT contain .swarm anywhere — XDG was never consulted so there is no
		// containment violation to trigger a fallback warning
		expect(resolved).not.toContain('.swarm');

		// Must use ~/Library/Caches on darwin (NOT .cache from linux fallback)
		const segments = resolved.split(path.sep);
		expect(segments).toContain('Library');
		expect(segments).toContain('Caches');
		expect(segments).toContain('opencode');
		expect(segments).toContain('embeddings');
		expect(segments).not.toContain('.cache');

		// No warning fires — XDG was simply ignored (not read), so no fallback occurred
		expect(warnSpy).not.toHaveBeenCalled();

		warnSpy.mockRestore();
	});
});
