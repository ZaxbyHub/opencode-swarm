/**
 * Shared fixtures for the `src/index.ts` command-registration test files.
 *
 * `tests/unit/index-commands*.test.ts` were split out of a single 600+ line
 * file to stay under the FR-006 500-line cap enforced by
 * `scripts/check-test-file-cap.ts`. Every one of them boots the real plugin via
 * `OpenCodeSwarm.server()`, so they all need the same fixtures and guards.
 *
 * Following this repository's `tests/helpers/**` convention, nothing here
 * registers a `bun:test` hook. Each helper returns plain functions and the
 * importing test file wires them into its own `beforeAll` / `beforeEach` /
 * `afterEach` / `afterAll`.
 */
import * as path from 'node:path';
import { overrideIndexInternalsForTest } from '../../src/index.js';
import { createIsolatedTestEnv } from './isolated-test-env.js';
import { createSafeTestDir } from './safe-test-dir.js';
import {
	captureFileBytes,
	collectCleanupError,
	expectFileBytesUnchanged,
} from './test-isolation.js';

/**
 * Minimal stand-in for `@opencode-ai/plugin`'s plugin input. The command
 * registration path only reads `directory` / `worktree`, so the rest is inert.
 */
export interface MockPluginInput {
	client: any;
	project: any;
	directory: string;
	worktree: string;
	serverUrl: URL;
	$: any;
}

/**
 * Builds a FRESH mock plugin input. Each test file must own its own instance:
 * the object is mutated per test (its `directory`/`worktree` are repointed at
 * that test's temp dir), so a shared module-level instance would let one file's
 * teardown invalidate another file's paths.
 */
export function createMockPluginInput(): MockPluginInput {
	return {
		client: {} as any,
		project: {} as any,
		directory: '',
		worktree: '',
		serverUrl: new URL('http://localhost:3000'),
		$: {} as any,
	};
}

/**
 * Per-test isolation: an isolated config/HOME env plus a safe temp working dir,
 * with `pluginInput` repointed at that dir.
 *
 * Wire it up as `beforeEach(iso.setUp); afterEach(iso.tearDown);`.
 */
export function createIndexCommandsIsolation(pluginInput: MockPluginInput): {
	setUp: () => void;
	tearDown: () => void;
} {
	let envCleanup = () => {};
	let tempDirCleanup = () => {};

	const setUp = (): void => {
		envCleanup = () => {};
		tempDirCleanup = () => {};
		let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
		let safeDir: ReturnType<typeof createSafeTestDir> | undefined;
		try {
			isolatedEnv = createIsolatedTestEnv();
			safeDir = createSafeTestDir();
			pluginInput.directory = safeDir.dir;
			pluginInput.worktree = safeDir.dir;
			envCleanup = isolatedEnv.cleanup;
			tempDirCleanup = safeDir.cleanup;
		} catch (error) {
			// Every partial-setup teardown step still runs, but the SETUP error is
			// the primary failure and always wins — a cleanup throw must never mask
			// it (PR #2173 F-009). `collectCleanupError` returns rather than throws,
			// which is what makes "always rethrow `error`" expressible here.
			collectCleanupError(
				() => safeDir?.cleanup(),
				() => isolatedEnv?.cleanup(),
			);
			throw error;
		}
	};

	const tearDown = (): void => {
		// Both steps always run; the first thrown value surfaces. The explicit
		// `thrown` flag (not a truthiness check) keeps a falsy thrown value from
		// being swallowed (PR #2173 F-019).
		const outcome = collectCleanupError(
			() => envCleanup(),
			() => tempDirCleanup(),
		);
		if (outcome.thrown) {
			throw outcome.error;
		}
	};

	return { setUp, tearDown };
}

/** Project-owned tracked config that booting the plugin must never rewrite. */
const TRACKED_PROJECT_CONFIG_PATH = path.join(
	import.meta.dir,
	'../../.opencode/opencode-swarm.json',
);

/**
 * File-scoped guards for any test file that boots `OpenCodeSwarm.server()`.
 *
 * 1. Neutralizes `schedulePostResolutionTasks`. `server()` queues background
 *    work (init orphan recovery, bundled-skill sync, repo-graph init) on an
 *    unref'd `setTimeout(0)`. That timer fires AFTER the synchronous `afterEach`
 *    has already deleted the test's temp dir, and the tasks then RECREATE it —
 *    leaving a permanent orphan under `os.tmpdir()` (PR #2173 F-006). The
 *    existing `overrideIndexInternalsForTest` seam is the supported way to stop
 *    that (precedent: `tests/unit/index.test.ts`).
 * 2. Asserts the tracked project config is byte-identical afterwards.
 *
 * Deliberately file-scoped (`beforeAll`/`afterAll`) rather than per-test: the
 * per-test `tearDown` can itself throw, and a restore sequenced after that throw
 * would never run — leaking the override into every subsequent test file, since
 * Bun runs test files sequentially in one process.
 *
 * Wire it up as `beforeAll(guards.setUpAll); afterAll(guards.tearDownAll);`.
 */
export function createIndexCommandsModuleGuards(): {
	setUpAll: () => void;
	tearDownAll: () => void;
} {
	let restoreIndexInternals: () => void = () => {};
	let trackedProjectConfigBefore: Buffer | null = null;

	const setUpAll = (): void => {
		restoreIndexInternals = overrideIndexInternalsForTest({
			schedulePostResolutionTasks: () => {},
		});
		trackedProjectConfigBefore = captureFileBytes(TRACKED_PROJECT_CONFIG_PATH);
	};

	const tearDownAll = (): void => {
		// Restore FIRST, before the byte assertion: if that assertion throws, the
		// override must already be off so it cannot leak into the next test file.
		restoreIndexInternals();
		restoreIndexInternals = () => {};
		expectFileBytesUnchanged(
			TRACKED_PROJECT_CONFIG_PATH,
			trackedProjectConfigBefore,
		);
	};

	return { setUpAll, tearDownAll };
}
