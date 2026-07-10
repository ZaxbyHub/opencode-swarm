/**
 * Unified test-state isolation helper for opencode-swarm.
 *
 * Composes the repo's existing isolation primitives into one call so a test
 * gets: an isolated config/HOME environment + a safe temp working dir + a
 * deterministic clock — the three things tests most often need together to be
 * stable under coverage instrumentation and across platforms (issue #1782,
 * root-cause classes 1 & 2).
 *
 * This helper does NOT replace the individual primitives — it composes them.
 * Use `createIsolatedTestEnv`, `createSafeTestDir`, or `freezeClock` directly
 * when you only need one.
 */
import { createIsolatedTestEnv } from './isolated-test-env.js';
import { createSafeTestDir } from './safe-test-dir.js';
import {
	type FreezeClockOptions,
	freezeClock,
	type Restore,
} from './test-clock.js';

export interface IsolatedStateOptions {
	/** Directory prefix for the temp working dir. */
	prefix?: string;
	/** Clock options. Pass `true` for default freeze, or a full options object. */
	clock?: true | FreezeClockOptions;
}

export interface IsolatedState {
	/** The realpath-canonicalized temp working directory (under os.tmpdir()). */
	dir: string;
	/** The isolated config dir (XDG_CONFIG_HOME / APPDATA / HOME pointed here). */
	configDir: string;
	/** Restore the clock. Only present if a clock was requested. */
	restoreClock: Restore | null;
	/** Tear everything down: restore env, restore clock, remove temp dir. */
	cleanup: () => void;
}

/**
 * Set up fully isolated test state: temp working dir + isolated config env +
 * (optionally) a frozen deterministic clock.
 *
 * The caller MUST call `cleanup()` — typically `afterEach(state.cleanup)` or
 * in a `try/finally`. `withIsolatedState` is the auto-cleanup convenience.
 */
export function setupIsolatedState(
	options: IsolatedStateOptions = {},
): IsolatedState {
	const { prefix, clock } = options;

	const safeDir = createSafeTestDir(prefix);
	const env = createIsolatedTestEnv();

	let restoreClock: Restore | null = null;
	if (clock) {
		const clockOpts: FreezeClockOptions = clock === true ? {} : clock;
		restoreClock = freezeClock(clockOpts);
	}

	// cleanup runs each teardown step independently so a throw in one (e.g. the
	// clock restore) does not skip the env/dir teardown — which would leak a
	// temp dir (PR review F-007). The first thrown error is re-thrown after all
	// steps have been attempted. Steps are routed through `_internals.runCleanup`
	// so a test can inject a throwing step to prove the error-isolation contract.
	const cleanup = (): void => {
		_internals.runCleanup(
			restoreClock,
			() => env.cleanup(),
			() => safeDir.cleanup(),
		);
	};

	return {
		dir: safeDir.dir,
		configDir: env.configDir,
		restoreClock,
		cleanup,
	};
}

/**
 * Test-only DI seam (AGENTS.md invariant 7). Tests inject throwing steps to
 * prove the cleanup error-isolation contract (F-007) without needing mock.module
 * (which leaks across files in Bun's shared test-runner process).
 */
export const _internals: {
	runCleanup: (
		restoreClock: Restore | null,
		envCleanup: () => void,
		dirCleanup: () => void,
	) => void;
} = {
	runCleanup(restoreClock, envCleanup, dirCleanup) {
		let firstError: unknown = null;
		try {
			restoreClock?.();
		} catch (e) {
			firstError = e;
		}
		try {
			envCleanup();
		} catch (e) {
			firstError = firstError ?? e;
		}
		try {
			dirCleanup();
		} catch (e) {
			firstError = firstError ?? e;
		}
		if (firstError !== null) {
			throw firstError;
		}
	},
};

/**
 * Run `fn` with fully isolated test state, always cleaning up afterward.
 * Auto-restores env, clock, and removes the temp dir via try/finally.
 */
export async function withIsolatedState<T>(
	fn: (state: IsolatedState) => Promise<T> | T,
	options?: IsolatedStateOptions,
): Promise<T> {
	const state = setupIsolatedState(options);
	try {
		return await fn(state);
	} finally {
		state.cleanup();
	}
}
