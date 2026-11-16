/**
 * Issue #3486 regression suite: the commit-message temp directory is a FIXED
 * predictable name under the OS temp root, so a planted symlink/junction at
 * that name could redirect both the TTL prune (deleting stale *.txt files in
 * the link target) and the authored message write into an attacker-chosen
 * directory. The acquisition guard added in this change refuses a planted
 * link before anything touches the directory.
 *
 * Pins:
 *   1. planted-link refusal at the production entry point, victim untouched;
 *   2. real-directory authoring still works (file present, mode 0600 POSIX);
 *   3. fresh directories are created at mode 0700 (asserted BEFORE any heal
 *      can mask it — both the captured mkdir options and on-disk mode);
 *   4. ancestor-symlink containment: a temp root whose realpath is inside the
 *      repository is still refused (the realpath ancestor check is
 *      load-bearing, not vestigial);
 *   5. POSIX ownership refusal and the legacy-mode heal (0755 -> 0700) plus
 *      the heal-failure refusal — injected through the _internals seam;
 *   6. the same-tick validateTarget re-proof catches a directory swapped for
 *      a link AFTER acquisition (swap simulated inside the seam window
 *      between acquisition and the write).
 *
 * The temp root is redirected via TMPDIR+TMP+TEMP (bun on win32 honors TEMP
 * only; POSIX honors TMPDIR — CI's three platforms are covered) and every
 * redirect asserts it actually took effect (fail-loud, never vacuous).
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { activatePrWorkflow } from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executePreparePrFeedbackCommitMessage,
} from '../../../src/tools/prepare-pr-feedback-commit-message.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

const SESSION_ID = 'commit-msg-symlink-3486';
const FIXED_DIR_NAME = 'swarm-pr-feedback-commit-msg';
/** 2020-09-13T12:26:40Z as epoch seconds — a literal, far past the 24h TTL (no raw clock reads). */
const OLD_MTIME_SECONDS = 1_600_000_000;

const createdRoots: string[] = [];
const createdRepos: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const savedInternals = { ..._internals };

function gitRun(dir: string, args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], {
		stdio: 'ignore',
		timeout: 15_000,
	});
}

function gitHead(dir: string): string {
	return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
		encoding: 'utf8',
		timeout: 15_000,
	}).trim();
}

/** Real repo satisfying the first-bind tracking discipline (l2 fixture mechanics). */
async function createBoundFeedbackRepo(): Promise<string> {
	const dir = canonicalMkdtemp('symlink-3486-repo-');
	createdRepos.push(dir);
	mkdirSync(join(dir, 'src'), { recursive: true });
	writeFileSync(join(dir, 'src', 'foo.ts'), 'export const a = 1;\n');
	gitRun(dir, ['init', '-q', '-b', 'main']);
	gitRun(dir, ['config', 'user.email', 'symlink-3486@example.com']);
	gitRun(dir, ['config', 'user.name', 'Symlink 3486']);
	gitRun(dir, ['add', '.']);
	gitRun(dir, ['commit', '-q', '-m', 'init']);
	const head = gitHead(dir);
	gitRun(dir, ['update-ref', 'refs/remotes/origin/pr-head', head]);
	gitRun(dir, [
		'config',
		'remote.origin.url',
		'https://github.com/example/repo.git',
	]);
	gitRun(dir, [
		'config',
		'remote.origin.fetch',
		'+refs/heads/*:refs/remotes/origin/*',
	]);
	gitRun(dir, ['config', 'branch.main.remote', 'origin']);
	gitRun(dir, ['config', 'branch.main.merge', 'refs/heads/pr-head']);
	await activatePrWorkflow(dir, SESSION_ID, 'PR_FEEDBACK', { prHeadSha: head });
	return dir;
}

/**
 * Redirect the OS temp root to a fresh fixture root and prove the redirect
 * took effect (bun/win32 honors TEMP; POSIX honors TMPDIR). Returns the fixed
 * commit-message directory name under the redirected root.
 */
function redirectTempRoot(): string {
	const root = canonicalMkdtemp('symlink-3486-root-');
	createdRoots.push(root);
	savedEnv.TMPDIR = process.env.TMPDIR;
	savedEnv.TMP = process.env.TMP;
	savedEnv.TEMP = process.env.TEMP;
	process.env.TMPDIR = root;
	process.env.TMP = root;
	process.env.TEMP = root;
	expect(realpathSync(tmpdir()).startsWith(root)).toBe(true);
	return join(root, FIXED_DIR_NAME);
}

function makeDirLink(target: string, linkPath: string): void {
	rmSync(linkPath, { force: true, recursive: true });
	symlinkSync(
		target,
		linkPath,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
}

afterEach(() => {
	Object.assign(_internals, savedInternals);
	if (savedEnv.TMPDIR === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = savedEnv.TMPDIR;
	if (savedEnv.TMP === undefined) delete process.env.TMP;
	else process.env.TMP = savedEnv.TMP;
	if (savedEnv.TEMP === undefined) delete process.env.TEMP;
	else process.env.TEMP = savedEnv.TEMP;
	savedEnv.TMPDIR = undefined;
	savedEnv.TMP = undefined;
	savedEnv.TEMP = undefined;
});

afterAll(() => {
	closeAllProjectDbs();
	for (const repo of createdRepos) removeTreeWithRetry(repo);
	for (const root of createdRoots) removeTreeWithRetry(root);
});

describe('prepare_pr_feedback_commit_message symlink/junction guard (#3486)', () => {
	test('refuses a planted link at the fixed name and leaves the victim untouched', async () => {
		const fixedDir = redirectTempRoot();
		const victim = canonicalMkdtemp('symlink-3486-victim-');
		createdRoots.push(victim);
		writeFileSync(join(victim, 'stale.txt'), 'old\n');
		writeFileSync(join(victim, 'fresh.txt'), 'new\n');
		writeFileSync(join(victim, 'keep.log'), 'keep\n');
		utimesSync(join(victim, 'stale.txt'), OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);
		utimesSync(join(victim, 'keep.log'), OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);
		makeDirLink(victim, fixedDir);

		const repo = await createBoundFeedbackRepo();
		const result = JSON.parse(
			await executePreparePrFeedbackCommitMessage(
				{ message: 'planted <co-authored-by>' },
				repo,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };

		expect(result.success).toBe(false);
		expect(result.message).toContain('exists as a symlink');
		expect(readdirSync(victim).sort()).toEqual([
			'fresh.txt',
			'keep.log',
			'stale.txt',
		]);
	}, 60_000);

	test('authors into a real directory and creates it at mode 0700 (POSIX mode assertions)', async () => {
		const fixedDir = redirectTempRoot();
		// Capture the mkdir options the module passes, BEFORE any heal could
		// mask a dropped creation mode (fresh-mode is asserted from the seam).
		const mkdirCalls: Array<{ path: string; mode?: number }> = [];
		const realMkdir = savedInternals.mkdirSync;
		_internals.mkdirSync = ((
			p: string,
			options?: { mode?: number; recursive?: boolean },
		) => {
			mkdirCalls.push({ path: String(p), mode: options?.mode });
			return realMkdir(p as never, options as never);
		}) as typeof mkdirSync;

		const repo = await createBoundFeedbackRepo();
		const result = JSON.parse(
			await executePreparePrFeedbackCommitMessage(
				{ message: 'fresh dir <co-authored-by>' },
				repo,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; path?: string; message: string };

		expect(result.success).toBe(true);
		expect(result.path).toBeDefined();
		expect(existsSync(result.path as string)).toBe(true);
		const creation = mkdirCalls.find((c) => c.path === fixedDir);
		expect(creation).toBeDefined();
		expect((creation?.mode ?? 0) & 0o777).toBe(0o700);
		if (process.platform !== 'win32') {
			const dirStats = savedInternals.lstatSync(fixedDir);
			expect(dirStats.mode & 0o777).toBe(0o700);
			const fileStats = savedInternals.lstatSync(result.path as string);
			expect(fileStats.mode & 0o777).toBe(0o600);
		}
	}, 60_000);

	test('still refuses a temp root whose realpath is inside the repository (ancestor link)', async () => {
		const repo = await createBoundFeedbackRepo();
		const rootHolder = canonicalMkdtemp('symlink-3486-ancestor-');
		createdRoots.push(rootHolder);
		const linkRoot = join(rootHolder, 'linked-temp');
		makeDirLink(repo, linkRoot);

		savedEnv.TMPDIR = process.env.TMPDIR;
		savedEnv.TMP = process.env.TMP;
		savedEnv.TEMP = process.env.TEMP;
		process.env.TMPDIR = linkRoot;
		process.env.TMP = linkRoot;
		process.env.TEMP = linkRoot;
		// The redirect points THROUGH the link, so realpath collapses it to the
		// repo — proving the redirect took effect by resolving to the repo itself
		// (the default temp root would never resolve there).
		expect(realpathSync(tmpdir())).toBe(realpathSync(repo));
		// Pre-create the fixed name as a REAL directory under the linked root
		// (real through the link, so the acquisition itself passes).
		mkdirSync(join(linkRoot, FIXED_DIR_NAME), { recursive: true });

		const result = JSON.parse(
			await executePreparePrFeedbackCommitMessage(
				{ message: 'ancestor <co-authored-by>' },
				repo,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };

		expect(result.success).toBe(false);
		expect(result.message).toContain('inside the repository');
	}, 60_000);

	// POSIX-executing legs: ownership and mode semantics are Windows-absent by
	// design (documented in the guard); these run on the Linux/macOS shards.
	// POSIX-executing legs: ownership and mode semantics are Windows-absent by
	// design (documented in the guard) — these run on the Linux/macOS shards.
	describe.skipIf(process.platform === 'win32')(
		'POSIX ownership and mode',
		() => {
			test('refuses a directory not owned by the current user', async () => {
				const fixedDir = redirectTempRoot();
				mkdirSync(fixedDir, { recursive: true, mode: 0o700 });
				const realLstat = savedInternals.lstatSync;
				const realUid = process.getuid?.() ?? 0;
				_internals.lstatSync = ((p: string) => {
					const stats = realLstat(p);
					if (path.resolve(String(p)) === path.resolve(fixedDir)) {
						return Object.assign(
							Object.create(Object.getPrototypeOf(stats)),
							stats,
							{
								uid: realUid + 1,
							},
						);
					}
					return stats;
				}) as typeof realLstat;

				const repo = await createBoundFeedbackRepo();
				const result = JSON.parse(
					await executePreparePrFeedbackCommitMessage(
						{ message: 'foreign owner <co-authored-by>' },
						repo,
						{ sessionID: SESSION_ID },
					),
				) as { success: boolean; message: string };

				expect(result.success).toBe(false);
				expect(result.message).toContain('not owned by the current user');
			}, 60_000);

			test('heals a legacy 0755 directory we own to 0700 and proceeds', async () => {
				const fixedDir = redirectTempRoot();
				mkdirSync(fixedDir, { recursive: true, mode: 0o755 });

				const repo = await createBoundFeedbackRepo();
				const result = JSON.parse(
					await executePreparePrFeedbackCommitMessage(
						{ message: 'legacy heal <co-authored-by>' },
						repo,
						{ sessionID: SESSION_ID },
					),
				) as { success: boolean; message: string };

				expect(result.success).toBe(true);
				expect(savedInternals.lstatSync(fixedDir).mode & 0o777).toBe(0o700);
			}, 60_000);

			test('refuses when the mode heal fails', async () => {
				const fixedDir = redirectTempRoot();
				mkdirSync(fixedDir, { recursive: true, mode: 0o755 });
				const realChmod = savedInternals.chmodSync;
				_internals.chmodSync = (() => {
					throw new Error('chmod unavailable in this leg');
				}) as typeof realChmod;

				const repo = await createBoundFeedbackRepo();
				const result = JSON.parse(
					await executePreparePrFeedbackCommitMessage(
						{ message: 'heal failure <co-authored-by>' },
						repo,
						{ sessionID: SESSION_ID },
					),
				) as { success: boolean; message: string };

				expect(result.success).toBe(false);
				expect(result.message).toContain(
					'could not be restricted to mode 0700',
				);
			}, 60_000);
		},
	);

	test('write-time re-proof refuses a directory swapped for a link after acquisition', async () => {
		const fixedDir = redirectTempRoot();
		const victim = canonicalMkdtemp('symlink-3486-swap-');
		createdRoots.push(victim);
		writeFileSync(join(victim, 'sentinel.txt'), 'sentinel\n');
		// A STALE .txt in the victim (4.5 review round): the TTL prune runs
		// before the write's validateTarget, so without the prune's own
		// entry re-proof this swap window would DELETE this file through the
		// link — the exact destructive side effect AC1 forbids.
		const victimStale = join(victim, 'stale.txt');
		writeFileSync(victimStale, 'stale-survivor\n');
		utimesSync(victimStale, OLD_MTIME_SECONDS, OLD_MTIME_SECONDS);

		// Swap fires inside the seam window AFTER acquisition and BEFORE the
		// prune/write: the module's post-acquisition realpathSync call is the
		// hook.
		const realRealpath = savedInternals.realpathSync;
		let swapped = false;
		_internals.realpathSync = ((p: string) => {
			const resolved = path.resolve(String(p));
			if (!swapped && resolved === path.resolve(fixedDir)) {
				swapped = true;
				rmSync(fixedDir, { recursive: true, force: true });
				makeDirLink(victim, fixedDir);
			}
			return realRealpath(p);
		}) as typeof realRealpath;

		const repo = await createBoundFeedbackRepo();
		const result = JSON.parse(
			await executePreparePrFeedbackCommitMessage(
				{ message: 'late swap <co-authored-by>' },
				repo,
				{ sessionID: SESSION_ID },
			),
		) as { success: boolean; message: string };

		expect(result.success).toBe(false);
		expect(result.message).toContain('replaced with a link');
		// The victim is untouched: the authored file never landed, AND the
		// stale .txt survived the prune (the prune's entry re-proof skipped
		// the swapped link instead of walking it).
		expect(readdirSync(victim).sort()).toEqual(['sentinel.txt', 'stale.txt']);
	}, 60_000);
});
