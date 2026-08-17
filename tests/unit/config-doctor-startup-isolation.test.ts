/**
 * ARMED regression test for issue #2010: booting the plugin must never write
 * into the developer's checkout.
 *
 * Why this file exists separately from the byte-guard added to
 * `tests/unit/index-commands.test.ts` / `src/commands/registration-parity.test.ts`:
 * that guard is DISARMED by default. The startup config-doctor autofix path in
 * `src/index.ts` requires ALL THREE of
 *   - `automation.mode !== 'manual'`
 *   - `automation.capabilities.config_doctor_on_startup === true`
 *   - `automation.capabilities.config_doctor_autofix === true`
 * and every one of those defaults to off, so a plain `server()` boot never
 * reaches the code that rewrites a config file. The byte guard therefore passes
 * identically whether the isolation fix is correct or fully reverted.
 *
 * This test ARMS the mechanism so the guard actually bites: it enables the
 * autofix capabilities and plants a deterministic auto-fixable defect, then
 * proves the resulting writes land in an isolated temp dir and NOT in the repo.
 *
 * The arming config is written to the isolated USER config
 * (`$XDG_CONFIG_HOME/opencode/opencode-swarm.json`) rather than the temp
 * project config. That is strictly stronger: `src/config/loader.ts` reads the
 * user config regardless of the `directory` argument, so if someone reverts the
 * `directory` isolation back to `process.cwd()`, the arming still applies and
 * the assertions below fire.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import OpenCodeSwarm, { overrideIndexInternalsForTest } from '../../src/index';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env.js';
import { createSafeTestDir } from '../helpers/safe-test-dir.js';
import {
	captureFileBytes,
	expectFileBytesUnchanged,
	runWithCleanup,
} from '../helpers/test-isolation.js';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const TRACKED_PROJECT_CONFIG = path.join(
	REPO_ROOT,
	'.opencode',
	'opencode-swarm.json',
);
const REPO_SWARM_DIR = path.join(REPO_ROOT, '.swarm');

/** Config-doctor's own artifacts — the only entries this test may attribute. */
function isConfigDoctorArtifact(entry: string): boolean {
	return entry.startsWith('config-backup-') || entry === 'config-doctor.json';
}

/** Directory listing that treats "absent" as "empty" instead of throwing. */
function listDir(dir: string): string[] {
	try {
		return fs.readdirSync(dir).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

const STARTER_PROJECT_CONFIG = '{}\n';

/** Prefix of this test's own temp working dir, asserted clean at the end. */
const ARM_DIR_PREFIX = 'swarm-doctor-arm-';

/** Poll interval for {@link waitForBackgroundWritesToSettle}. */
const SETTLE_POLL_MS = 25;

/** Consecutive identical polls that count as "the background work has stopped". */
const SETTLE_STABLE_POLLS = 4;

/** Hard ceiling on the settle wait, well inside this test's 30s budget. */
const SETTLE_TIMEOUT_MS = 8_000;

/**
 * Short grace period AFTER cleanup, before the orphan assertion. Only a
 * backstop: if {@link waitForBackgroundWritesToSettle} did its job there is
 * nothing left to fire. It exists so a REGRESSION of the leak is caught rather
 * than racing past the end of the test.
 */
const POST_CLEANUP_GRACE_MS = 250;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** `swarm-doctor-arm-*` entries directly under `os.tmpdir()`. */
function armDirEntries(): Set<string> {
	return new Set(
		fs.readdirSync(os.tmpdir()).filter((e) => e.startsWith(ARM_DIR_PREFIX)),
	);
}

/** Recursive `path -> size` snapshot of `roots`; missing roots read as empty. */
function treeSignature(roots: readonly string[]): string {
	const lines: string[] = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // Raced away or never existed — both read as "nothing here".
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				lines.push(`d ${full}`);
				walk(full);
				continue;
			}
			try {
				lines.push(`f ${full} ${fs.statSync(full).size}`);
			} catch {
				lines.push(`f ${full} ?`);
			}
		}
	};
	for (const root of roots) walk(root);
	return lines.join('\n');
}

/**
 * Waits for the post-resolution tasks that `void` their own promise to finish.
 *
 * `await Promise.all(scheduled.map((task) => Promise.resolve(task())))` is a
 * no-op for two of them: `src/index.ts:791-796` (`void runInitOrphanRecovery`)
 * and `src/index.ts:822-836` (`void withTimeout(syncBundledProjectSkillsIfMissingAsync)`)
 * return `undefined`, so `Promise.resolve(undefined)` settles immediately while
 * their writes are still in flight. They then land AFTER `safeDir.cleanup()`,
 * RE-CREATING the temp dir — one permanent `/tmp/swarm-doctor-arm-*` orphan per
 * co-resident run (it only escaped notice when the file ran alone, because the
 * process exited first; CI always runs it co-resident).
 *
 * `overrideIndexInternalsForTest` exposes no seam for either task, so there is
 * no handle to await. This waits on their OBSERVABLE effect instead of on a
 * guessed delay: it requires both tasks' artifacts to appear AND the tree to
 * stop changing for {@link SETTLE_STABLE_POLLS} polls. That is condition-driven
 * (it returns as soon as the writes actually stop — typically well under a
 * second — rather than always sleeping a fixed interval) and hard-bounded by
 * {@link SETTLE_TIMEOUT_MS} so a wedged background task can never hang the
 * suite. `env.configDir` is included because the same queue schedules the
 * version-check cache write under `XDG_CACHE_HOME`.
 */
async function waitForBackgroundWritesToSettle(
	projectDir: string,
	configDir: string,
): Promise<void> {
	const roots = [projectDir, configDir];
	// Positive completion signals for the two void'd tasks. Stability alone is
	// not enough: neither task has necessarily started writing when polling
	// begins, so an all-quiet tree would read as "already settled".
	const orphanAdvisory = path.join(
		projectDir,
		'.swarm',
		'advisories',
		'init-orphan-recovery.json',
	);
	const bundledSkills = path.join(projectDir, '.swarm', 'bundled-skills');
	const deadline = Date.now() + SETTLE_TIMEOUT_MS;
	let previous = treeSignature(roots);
	let stable = 0;
	while (Date.now() < deadline) {
		await sleep(SETTLE_POLL_MS);
		const current = treeSignature(roots);
		stable = current === previous ? stable + 1 : 0;
		previous = current;
		if (
			stable >= SETTLE_STABLE_POLLS &&
			fs.existsSync(orphanAdvisory) &&
			fs.existsSync(bundledSkills)
		) {
			return;
		}
	}
	// Timed out: fall through rather than throw. The post-cleanup orphan
	// assertion is the authority on whether anything actually leaked.
}

/**
 * `automation.mode` is non-manual and both config-doctor capabilities are on —
 * this is what makes `shouldRunOnStartup()` true and `enableAutofix` true.
 * `guardrails.profiles.definitely_not_an_agent` is the planted defect: the
 * doctor emits an `unknown-agent-profile` finding with a low-risk, non-lossy
 * `remove` fix, which the passive startup autofix path applies.
 */
const ARMING_USER_CONFIG = {
	automation: {
		mode: 'hybrid',
		capabilities: {
			config_doctor_on_startup: true,
			config_doctor_autofix: true,
		},
	},
	guardrails: {
		profiles: {
			definitely_not_an_agent: { max_tool_calls: 3 },
		},
	},
};

describe('startup config-doctor autofix isolation (issue #2010)', () => {
	test('armed autofix rewrites only the isolated project dir, never the repo', async () => {
		const trackedConfigBefore = captureFileBytes(TRACKED_PROJECT_CONFIG);
		const repoSwarmBefore = listDir(REPO_SWARM_DIR);
		// Snapshot-and-diff, not an absolute count: only entries created inside
		// this test's own window may be attributed to it.
		const armDirsBefore = armDirEntries();

		const safeDir = createSafeTestDir(ARM_DIR_PREFIX);
		// Points XDG_CONFIG_HOME at its own temp dir — that is where the arming
		// user config is written below, and it is what keeps the boot away from
		// the developer's real ~/.config.
		const env = createIsolatedTestEnv();
		let restoreIndexInternals: () => void = () => {};

		await runWithCleanup(
			async () => {
				// ── Arm via the isolated USER config ───────────────────────────
				const userConfigDir = path.join(env.configDir, 'opencode');
				fs.mkdirSync(userConfigDir, { recursive: true });
				fs.writeFileSync(
					path.join(userConfigDir, 'opencode-swarm.json'),
					`${JSON.stringify(ARMING_USER_CONFIG, null, 2)}\n`,
				);

				// A project config must exist for the autofix path to have a
				// backup source and an apply target.
				const isolatedProjectConfig = path.join(
					safeDir.dir,
					'.opencode',
					'opencode-swarm.json',
				);
				fs.mkdirSync(path.dirname(isolatedProjectConfig), {
					recursive: true,
				});
				fs.writeFileSync(isolatedProjectConfig, STARTER_PROJECT_CONFIG);

				// ── Boot, capturing the deferred post-resolution queue ─────────
				// The config-doctor task is ONLY reachable through this queue
				// (src/index.ts). Capturing rather than no-op'ing keeps the task
				// runnable; the real scheduler (setTimeout) would make the test
				// racy, so it is replaced entirely.
				let scheduled: ReadonlyArray<() => void | Promise<void>> = [];
				restoreIndexInternals = overrideIndexInternalsForTest({
					schedulePostResolutionTasks: (tasks) => {
						scheduled = [...tasks];
					},
				});

				await OpenCodeSwarm.server({
					client: {} as never,
					project: {} as never,
					directory: safeDir.dir,
					worktree: safeDir.dir,
					serverUrl: new URL('http://localhost:3000'),
					$: {} as never,
				});

				expect(scheduled.length).toBeGreaterThan(0);
				// The config-doctor task returns its full promise chain, so
				// awaiting here is deterministic for THAT task — no polling needed.
				await Promise.all(scheduled.map((task) => Promise.resolve(task())));
				// Two sibling tasks `void` their promise and return `undefined`, so
				// the await above is a no-op for them. Draining their writes HERE,
				// before the cleanup below, is what stops the temp dir from being
				// re-created after removal. See waitForBackgroundWritesToSettle.
				await waitForBackgroundWritesToSettle(safeDir.dir, env.configDir);

				// ── POSITIVE PROOF the autofix path actually ran ───────────────
				// Without these the test would pass vacuously even if the doctor
				// never executed.
				const isolatedSwarmEntries = listDir(path.join(safeDir.dir, '.swarm'));
				expect(isolatedSwarmEntries).toContain('config-doctor.json');
				expect(
					isolatedSwarmEntries.filter((entry) =>
						/^config-backup-\d+\.json$/.test(entry),
					).length,
				).toBeGreaterThan(0);
				expect(fs.readFileSync(isolatedProjectConfig, 'utf8')).not.toBe(
					STARTER_PROJECT_CONFIG,
				);

				// ── The actual #2010 assertions ────────────────────────────────
				// AC2: the repo's .swarm/ gained no config-doctor artifacts.
				const newRepoSwarmEntries = listDir(REPO_SWARM_DIR).filter(
					(entry) => !repoSwarmBefore.includes(entry),
				);
				expect(newRepoSwarmEntries.filter(isConfigDoctorArtifact)).toEqual([]);
				// The tracked project config is byte-identical.
				expectFileBytesUnchanged(TRACKED_PROJECT_CONFIG, trackedConfigBefore);
			},
			() => restoreIndexInternals(),
			env.cleanup,
			safeDir.cleanup,
		);

		// ── This test's OWN hygiene, asserted after its cleanup has run ────────
		// The leak this guards against was invisible from inside the body: the
		// re-create happened after `safeDir.cleanup()`. Asserting it here — past
		// the cleanup, past a grace period — is what keeps it from returning
		// silently.
		await sleep(POST_CLEANUP_GRACE_MS);
		const leakedArmDirs = [...armDirEntries()].filter(
			(entry) => !armDirsBefore.has(entry),
		);
		expect(leakedArmDirs).toEqual([]);
	}, 30_000);
});
