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
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
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
 * Reads a file, returning `null` when it does not exist.
 *
 * A single guarded `readFileSync` rather than `existsSync` + `readFileSync`:
 * the two-syscall form has a window in which the file can vanish between the
 * check and the read, which surfaces a raw ENOENT instead of this module's
 * intended diagnostic (PR #2173 F-014). Errors other than ENOENT (EACCES,
 * EISDIR, …) still propagate — a guard must not silently treat those as
 * "absent".
 */
function readFileIfExists(filePath: string): Buffer | null {
	try {
		return fs.readFileSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

/**
 * Captures the exact bytes in a file so tests can assert a later operation did
 * not mutate that file on disk. This is especially important for project-owned
 * tracked files like `.opencode/opencode-swarm.json`.
 */
export function captureFileBytes(filePath: string): Buffer | null {
	return readFileIfExists(filePath);
}

const FILE_PREVIEW_BYTES = 96;

/**
 * Raw file content is NOT included in the failure message by default.
 * `expectFileBytesUnchanged` is a generic exported helper, so a future caller
 * could point it at a tracked file that carries a secret, and the thrown
 * message lands in CI logs (PR #2173 F-016). Byte lengths plus a short SHA-256
 * of each side identify *that* and *how much* changed without disclosing
 * content; set `SWARM_TEST_FILE_PREVIEW=1` to include the byte previews when
 * debugging locally.
 */
const SHOW_FILE_PREVIEW = process.env.SWARM_TEST_FILE_PREVIEW === '1';

function shortDigest(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * Decodes the first `FILE_PREVIEW_BYTES` bytes without mojibake.
 *
 * A plain `subarray(0, N).toString('utf8')` emits U+FFFD when a multi-byte
 * character straddles the cutoff. `StringDecoder` holds back the incomplete
 * trailing sequence instead; the decoder is then discarded, so the partial
 * character is simply dropped (PR #2173 F-013).
 */
function previewBytes(bytes: Buffer): string {
	const decoded = new StringDecoder('utf8').write(
		bytes.subarray(0, FILE_PREVIEW_BYTES),
	);
	return bytes.length > FILE_PREVIEW_BYTES ? `${decoded}…` : decoded;
}

/**
 * Fails if a previously-captured file's bytes changed. Use in afterAll to catch
 * silent mutations that would otherwise leave a dirty working tree.
 */
export function expectFileBytesUnchanged(
	filePath: string,
	originalBytes: Buffer | Uint8Array | null,
): void {
	const current = readFileIfExists(filePath);
	if (originalBytes === null) {
		if (current !== null) {
			throw new Error(`Tracked file unexpectedly appeared: ${filePath}`);
		}
		return;
	}
	if (current === null) {
		throw new Error(`Tracked file was deleted: ${filePath}`);
	}
	const expected = Buffer.from(originalBytes);
	if (!current.equals(expected)) {
		throw new Error(
			`Tracked file mutated: ${filePath}\n` +
				`expected ${expected.length} bytes (sha256:${shortDigest(expected)}), ` +
				`saw ${current.length} bytes (sha256:${shortDigest(current)})` +
				(SHOW_FILE_PREVIEW
					? `\nexpected prefix: ${previewBytes(expected)}\n` +
						`actual prefix: ${previewBytes(current)}`
					: '\n(set SWARM_TEST_FILE_PREVIEW=1 to include byte previews)'),
		);
	}
}

/**
 * Runs every cleanup step even when an earlier one throws, and RETURNS the
 * first thrown value instead of throwing it.
 *
 * Returning is the point: it lets a caller run cleanup inside a `finally`
 * without a literal `throw` there (biome `lint/correctness/noUnsafeFinally`,
 * PR #2173 F-001) and without masking the primary error. The explicit `thrown`
 * flag — rather than a truthiness or `!== undefined` check — means a falsy
 * thrown value (`0`, `''`, `false`, `null`, `undefined`) is still reported
 * instead of silently swallowed (PR #2173 F-019).
 */
export function collectCleanupError(
	...steps: ReadonlyArray<(() => void) | null | undefined>
): { thrown: boolean; error: unknown } {
	let thrown = false;
	let firstError: unknown;
	for (const step of steps) {
		if (!step) continue;
		try {
			step();
		} catch (error) {
			if (!thrown) {
				thrown = true;
				firstError = error;
			}
		}
	}
	return { thrown, error: firstError };
}

/**
 * Runs `body`, then runs every cleanup step. The body's error ALWAYS wins; a
 * cleanup error surfaces only when the body succeeded.
 *
 * There is no `finally` block at all, so masking the primary error is
 * structurally impossible rather than merely avoided by convention
 * (PR #2173 F-001 / F-009).
 */
export async function runWithCleanup<T>(
	body: () => Promise<T> | T,
	...steps: ReadonlyArray<(() => void) | null | undefined>
): Promise<T> {
	let bodyThrew = false;
	let bodyError: unknown;
	let result!: T;
	try {
		result = await body();
	} catch (error) {
		bodyThrew = true;
		bodyError = error;
	}
	const outcome = collectCleanupError(...steps);
	if (bodyThrew) {
		throw bodyError;
	}
	if (outcome.thrown) {
		throw outcome.error;
	}
	return result;
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
		// Signature and throw-first-error contract are unchanged; only the
		// sentinel is upgraded from `!== null` to an explicit flag so a thrown
		// falsy value still surfaces (PR #2173 F-019).
		const outcome = collectCleanupError(
			restoreClock ? () => restoreClock() : null,
			envCleanup,
			dirCleanup,
		);
		if (outcome.thrown) {
			throw outcome.error;
		}
	},
};

/**
 * Run `fn` with fully isolated test state, always cleaning up afterward.
 * Auto-restores env, clock, and removes the temp dir.
 *
 * Routed through `runWithCleanup` rather than a bare `try/finally`: a cleanup
 * throw from that finally would replace `fn`'s error, hiding the real failure
 * behind a teardown error. Biome never flagged that shape because the throw was
 * indirect (inside `cleanup()`), which is exactly why it needed fixing by hand
 * (PR #2173 F-009).
 */
export async function withIsolatedState<T>(
	fn: (state: IsolatedState) => Promise<T> | T,
	options?: IsolatedStateOptions,
): Promise<T> {
	const state = setupIsolatedState(options);
	return runWithCleanup(() => fn(state), state.cleanup);
}
