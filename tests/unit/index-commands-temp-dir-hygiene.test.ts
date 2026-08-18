/**
 * Orphan-hygiene guard for the `OpenCodeSwarm.server()` boot fixtures (PR #2173
 * F-006).
 *
 * `OpenCodeSwarm.server()` queues background work (init orphan recovery,
 * bundled-skill sync, repo-graph init) onto an unref'd `setTimeout(0)`. That
 * timer fires AFTER the synchronous `afterEach` has already removed the test's
 * temp working dir — and the tasks then RECREATE it, leaving a permanent orphan
 * in the system temp directory on every run.
 *
 * `createIndexCommandsModuleGuards()` stubs that scheduler, which is what
 * prevents the orphan. Nothing asserted it: reverting the stub left every other
 * test in the suite green while quietly littering the system temp directory.
 * This file is that missing assertion.
 *
 * ## Two orphan prefixes, two guards
 *
 * The class has two halves, and an earlier revision of this file covered only
 * the first:
 *
 *   1. `swarm-safe-test-*` — `createSafeTestDir()`, the working dir used by the
 *      `tests/unit/index-commands*.test.ts` fixture. Covered IN-PROCESS below
 *      by driving that exact fixture.
 *   2. `swarm-test-*` — `createIsolatedTestEnv()` plus the bare
 *      `mkdtemp` call against the system temp directory used by
 *      `tests/unit/index.test.ts` and
 *      `tests/unit/index-task-42-commands.test.ts`. Those two files carry their
 *      own `beforeAll(moduleGuards.setUpAll)` wiring, and an in-process test
 *      CANNOT observe whether another file wired it — deleting the wiring from
 *      both files left the suite at 19 pass / 0 fail while producing 7
 *      `swarm-test-*` orphans and re-creating
 *      `~/.cache/opencode-swarm/version-check.json`.
 *
 * Half 2 is therefore guarded BEHAVIOURALLY, by running those two files in a
 * child `bun test` process whose `TMPDIR` and `XDG_*` roots point into a
 * sandbox this test owns. Any orphan or cache write the child produces lands in
 * the sandbox where it can be counted exactly — no snapshot/diff race against
 * whatever else is running, and no litter left behind either way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenCodeSwarm from '../../src/index';
import {
	createIndexCommandsIsolation,
	createIndexCommandsModuleGuards,
	createMockPluginInput,
} from '../helpers/index-commands-shared.js';
import { createSafeTestDir } from '../helpers/safe-test-dir.js';
import { runWithCleanup } from '../helpers/test-isolation.js';
import { canonicalTmpDir } from '../helpers/tmpdir.js';

/**
 * Every temp-dir prefix this repository's boot fixtures create directly under
 * the system temp directory: `createSafeTestDir()` uses the first,
 * `createIsolatedTestEnv()` and the two `mkdtemp` call sites use the second.
 */
const SWARM_TEMP_DIR_PREFIXES = ['swarm-safe-test-', 'swarm-test-'] as const;

/**
 * Long enough for the unref'd `setTimeout(0)` post-resolution queue to fire if
 * the scheduler was NOT stubbed. Without this wait the test would pass either
 * way, because the recreate happens on a later macrotask turn.
 */
const POST_RESOLUTION_SETTLE_MS = 250;

/** Repo root, from `tests/unit/` up two levels. */
const REPO_ROOT = path.resolve(import.meta.dir, '../..');

/**
 * The boot fixtures that own their own `createIndexCommandsModuleGuards()`
 * wiring, and are consequently invisible to any in-process assertion here.
 */
const GUARDED_BOOT_FIXTURES = [
	path.join('tests', 'unit', 'index.test.ts'),
	path.join('tests', 'unit', 'index-task-42-commands.test.ts'),
] as const;

/** Cache directory `src/services/version-check.ts` writes under XDG_CACHE_HOME. */
const VERSION_CHECK_CACHE_DIR = 'opencode-swarm';

/** Ceiling for the child `bun test` run (it takes ~3s locally). */
const CHILD_RUN_TIMEOUT_MS = 180_000;

const mockPluginInput = createMockPluginInput();
const isolation = createIndexCommandsIsolation(mockPluginInput);
const moduleGuards = createIndexCommandsModuleGuards();

beforeAll(moduleGuards.setUpAll);
afterAll(moduleGuards.tearDownAll);

/** True when `entry` is a temp dir created by one of this repo's boot fixtures. */
function isSwarmTempEntry(entry: string): boolean {
	return SWARM_TEMP_DIR_PREFIXES.some((prefix) => entry.startsWith(prefix));
}

/** Fixture-created entries directly under `dir` ("absent" reads as "empty"). */
function swarmTempEntries(dir: string): Set<string> {
	try {
		return new Set(fs.readdirSync(dir).filter(isSwarmTempEntry));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
		throw error;
	}
}

describe('index-commands temp-dir hygiene (PR #2173 F-006)', () => {
	it('booting the plugin leaves no swarm-safe-test-* / swarm-test-* orphan behind', async () => {
		// Snapshot-and-diff rather than an absolute count: `bun test` runs files
		// sequentially in one process, but nothing forbids another fixture holding
		// a temp dir open across this window, and an absolute count would blame it.
		//
		// `canonicalTmpDir()` is the realpath-resolved form of the SAME directory
		// the fixtures write into (macOS `/var` -> `/private/var`), so listing it
		// still sees entries the fixtures created through the unresolved path.
		const before = swarmTempEntries(canonicalTmpDir());

		isolation.setUp();
		// `runWithCleanup` rather than try/finally: the body's error always wins
		// and `tearDown` still runs, with no `throw` inside a `finally` block
		// (biome lint/correctness/noUnsafeFinally).
		await runWithCleanup(
			() => OpenCodeSwarm.server(mockPluginInput),
			isolation.tearDown,
		);

		await new Promise((resolve) => {
			setTimeout(resolve, POST_RESOLUTION_SETTLE_MS);
		});

		const leaked = [...swarmTempEntries(canonicalTmpDir())].filter(
			(entry) => !before.has(entry),
		);
		expect(leaked).toEqual([]);
	});
});

describe('index.test.ts / index-task-42-commands.test.ts temp-dir hygiene (PR #2173 F-006)', () => {
	it('wires the post-resolution scheduler guard into both files', () => {
		// Fast, precise companion to the behavioural guard below: it names the
		// exact wiring whose removal was proven to be a silent, zero-failure
		// regression. The child-process test is the real proof; this one exists so
		// the failure message points straight at the missing lines.
		const unwired = GUARDED_BOOT_FIXTURES.filter((relativePath) => {
			const source = fs.readFileSync(
				path.join(REPO_ROOT, relativePath),
				'utf8',
			);
			return !(
				/createIndexCommandsModuleGuards\s*\(\s*\)/.test(source) &&
				/beforeAll\s*\(\s*moduleGuards\.setUpAll\s*\)/.test(source) &&
				/afterAll\s*\(\s*moduleGuards\.tearDownAll\s*\)/.test(source)
			);
		});
		expect(unwired).toEqual([]);
	});

	it(
		'running both files in a sandboxed child process leaves no tmp orphan and no cache write',
		async () => {
			const sandbox = createSafeTestDir('swarm-hygiene-sandbox-');
			try {
				// Dedicated roots so the child's leaks are attributable EXACTLY, with no
				// diffing against a shared /tmp: `TMPDIR` is what the runtime resolves
				// the system temp dir from on POSIX (verified on Bun 1.3.11), while
				// `TMP`/`TEMP` cover Windows.
				const tmpRoot = path.join(sandbox.dir, 'tmp');
				const cacheRoot = path.join(sandbox.dir, 'cache');
				const configRoot = path.join(sandbox.dir, 'config');
				const dataRoot = path.join(sandbox.dir, 'data');
				for (const dir of [tmpRoot, cacheRoot, configRoot, dataRoot]) {
					fs.mkdirSync(dir, { recursive: true });
				}

				// `HOME`/`USERPROFILE` are deliberately left alone: `os.homedir()`
				// ignores them under Bun (see tests/helpers/isolated-test-env.ts), and
				// repointing HOME risks breaking the child's own Bun resolution. Every
				// path this guard checks is XDG- or TMPDIR-derived.
				const result = Bun.spawnSync({
					cmd: [process.execPath, 'test', ...GUARDED_BOOT_FIXTURES],
					cwd: REPO_ROOT,
					env: {
						...process.env,
						TMPDIR: tmpRoot,
						TMP: tmpRoot,
						TEMP: tmpRoot,
						XDG_CACHE_HOME: cacheRoot,
						XDG_CONFIG_HOME: configRoot,
						XDG_DATA_HOME: dataRoot,
						APPDATA: configRoot,
						LOCALAPPDATA: cacheRoot,
					},
					stdout: 'pipe',
					stderr: 'pipe',
				});

				// Non-vacuity: if the child did not actually run those files green, the
				// orphan assertions below would pass for the wrong reason.
				if (result.exitCode !== 0) {
					const output =
						`${result.stdout.toString()}\n${result.stderr.toString()}`.slice(
							-2000,
						);
					throw new Error(
						`child \`bun test ${GUARDED_BOOT_FIXTURES.join(' ')}\` exited ` +
							`${result.exitCode}; the orphan assertions below would be ` +
							`vacuous. Tail of child output:\n${output}`,
					);
				}
				expect(result.exitCode).toBe(0);

				// The scheduler stub is the ONLY thing standing between these fixtures
				// and 7 `swarm-test-*` orphans; remove it from either file and this list
				// is non-empty.
				expect(fs.readdirSync(tmpRoot).filter(isSwarmTempEntry)).toEqual([]);

				// F-007: the same unstubbed queue re-creates
				// `<XDG_CACHE_HOME>/opencode-swarm/version-check.json` after the per-test
				// env restore has already put the outer cache root back.
				expect(
					fs.existsSync(path.join(cacheRoot, VERSION_CHECK_CACHE_DIR)),
				).toBe(false);
			} finally {
				sandbox.cleanup();
			}
		},
		CHILD_RUN_TIMEOUT_MS,
	);
});
