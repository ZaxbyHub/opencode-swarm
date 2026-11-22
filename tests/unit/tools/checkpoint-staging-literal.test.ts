/**
 * Checkpoint staging hardening (#3763 AC1/AC2, plan v3 D1).
 *
 * RED at base, GREEN after the fix (#3763) for the staging-exclusion legs;
 * the refusal legs pin the new typed refusals (unmerged, cross-boundary).
 * Coverage demanded by plan-critic rounds 2-3: literal pathspecs, porcelain
 * record shapes, scoped commit arms.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { checkpoint } from '../../../src/tools/checkpoint';
import {
	ensureSwarmGitExcluded,
	resetSwarmGitExcludedState,
} from '../../../src/utils/gitignore-warning';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string | undefined;

afterEach(() => {
	// FB-016 (#3763 feedback round): the module-global reset must run even if
	// scratch cleanup throws (Windows EBUSY) — otherwise the flag leaks into
	// sibling suites sharing this Bun process.
	try {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	} finally {
		dir = undefined;
		resetSwarmGitExcludedState();
	}
});

function git(args: string[]): string {
	if (!dir) throw new Error('missing scratch project');
	return execFileSync('git', args, {
		cwd: dir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 15000,
		maxBuffer: 32768,
	}).trim();
}

function loc(rel: string): string {
	return path.join(dir as string, rel);
}

function fixture(): void {
	dir = canonicalMkdtemp('ckpt-literal-');
	// FB-007 (#3763 feedback round): pin the initial branch explicitly —
	// `git init` alone follows the host's init.defaultBranch, and the
	// unmerged-refusal fixture below checks `master` out by name.
	git(['init', '-q', '-b', 'master']);
	git(['config', 'user.email', 'test@example.invalid']);
	git(['config', 'user.name', 'Fixture']);
	git(['config', 'commit.gpgsign', 'false']);
	git(['config', 'core.autocrlf', 'false']);
	fs.writeFileSync(loc('sample.txt'), 'original');
	git(['add', 'sample.txt']);
	git(['commit', '-qm', 'fixture']);
}

async function save(label: string): Promise<Record<string, unknown>> {
	const r = await checkpoint.execute({ action: 'save', label }, {
		directory: dir,
		worktree: dir,
		sessionID: 'literal-fixture',
	} as ToolContext);
	return JSON.parse(typeof r === 'string' ? r : r.output);
}

function committedFiles(rev: string): string[] {
	return git(['show', '--name-only', '--format=', rev])
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
}

describe('checkpoint staging literal + scoped (#3763)', () => {
	test('literal pathspecs: a file named [.]swarm/marker.txt stages only itself (raw world)', async () => {
		fixture();
		fs.mkdirSync(loc('[.]swarm'), { recursive: true });
		fs.writeFileSync(loc('[.]swarm/marker.txt'), 'bracket literal');
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('.swarm/runtime.json'), 'runtime');
		fs.writeFileSync(loc('sample.txt'), 'edited');
		const result = await save('literal-bracket');
		expect(result.success).toBe(true);
		const files = committedFiles(String(result.sha));
		expect(files).toContain('[.]swarm/marker.txt');
		expect(files).toContain('sample.txt');
		// The REAL .swarm tree must never enter the checkpoint (AC2) — a glob
		// pathspec would have staged it alongside the bracket-named file.
		expect(
			files.some((f) => f === '.swarm/runtime.json' || f.startsWith('.swarm/')),
		).toBe(false);
	}, 30000);

	test('the startup exclusion world no longer refuses save and keeps .swarm out', async () => {
		fixture();
		await ensureSwarmGitExcluded(dir);
		expect(git(['check-ignore', '.swarm/marker.txt'])).toBe(
			'.swarm/marker.txt',
		);
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('.swarm/marker.txt'), 'runtime');
		fs.writeFileSync(loc('sample.txt'), 'edited');
		fs.writeFileSync(loc('new.txt'), 'new');
		const result = await save('startup-excluded');
		expect(result.success).toBe(true);
		const files = committedFiles(String(result.sha));
		expect(files).toContain('sample.txt');
		expect(files).toContain('new.txt');
		expect(files.some((f) => f.startsWith('.swarm/'))).toBe(false);
	}, 30000);

	test('whitespace and metacharacter filenames stage verbatim', async () => {
		fixture();
		fs.writeFileSync(loc('weird name (v2).txt'), 'a');
		fs.writeFileSync(loc('dash-file#1.txt'), 'b');
		fs.writeFileSync(loc('sample.txt'), 'edited');
		const result = await save('weird-names');
		expect(result.success).toBe(true);
		const files = committedFiles(String(result.sha));
		expect(files).toContain('weird name (v2).txt');
		expect(files).toContain('dash-file#1.txt');
	}, 30000);

	test('tracked deletions stage through the enumerated add', async () => {
		fixture();
		fs.writeFileSync(loc('gone.txt'), 'bye');
		git(['add', 'gone.txt']);
		git(['commit', '-qm', 'add gone']);
		fs.unlinkSync(loc('gone.txt'));
		fs.writeFileSync(loc('sample.txt'), 'edited');
		const result = await save('deletion');
		expect(result.success).toBe(true);
		const files = committedFiles(String(result.sha));
		expect(files).toContain('gone.txt');
		// The deletion is IN the commit: gone.txt is absent from its tree.
		let present = true;
		try {
			git(['cat-file', '-e', `${result.sha}:gone.txt`]);
		} catch {
			present = false;
		}
		expect(present).toBe(false);
	}, 30000);

	test('more than 50 paths cross the chunk boundary and all land in the commit', async () => {
		fixture();
		fs.mkdirSync(loc('bulk'), { recursive: true });
		for (let i = 0; i < 55; i++) {
			fs.writeFileSync(
				loc(`bulk/file-${String(i).padStart(3, '0')}.txt`),
				`b${i}`,
			);
		}
		const result = await save('bulk-55');
		expect(result.success).toBe(true);
		const files = committedFiles(String(result.sha));
		expect(files.filter((f) => f.startsWith('bulk/')).length).toBe(55);
	}, 60000);

	test('pre-staged .swarm only: no commit is created and the staged entry survives byte-exactly', async () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('.swarm/runtime.json'), 'staged bytes');
		git(['add', '-f', '.swarm/runtime.json']);
		const headBefore = git(['rev-parse', 'HEAD']);
		const stagedBlob = git(['rev-parse', ':.swarm/runtime.json']);
		const result = await save('prestaged-only');
		expect(result.success).toBe(true);
		// Default config has allow_empty_commits=false and the scoped diff
		// ignores the .swarm-only staged change: no commit is created…
		expect(git(['rev-parse', 'HEAD'])).toBe(headBefore);
		// …and the staged entry is untouched.
		expect(git(['rev-parse', ':.swarm/runtime.json'])).toBe(stagedBlob);
		expect(committedFiles('HEAD')).not.toContain('.swarm/runtime.json');
	}, 30000);

	test('pre-staged .swarm plus real work: only the real work is committed, the staged entry survives', async () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('.swarm/runtime.json'), 'staged bytes');
		git(['add', '-f', '.swarm/runtime.json']);
		fs.writeFileSync(loc('sample.txt'), 'edited');
		const headBefore = git(['rev-parse', 'HEAD']);
		const stagedBlob = git(['rev-parse', ':.swarm/runtime.json']);
		const result = await save('mixed');
		expect(result.success).toBe(true);
		const headAfter = git(['rev-parse', 'HEAD']);
		expect(headAfter).not.toBe(headBefore);
		const files = committedFiles(headAfter);
		expect(files).toContain('sample.txt');
		expect(files).not.toContain('.swarm/runtime.json');
		expect(git(['rev-parse', ':.swarm/runtime.json'])).toBe(stagedBlob);
	}, 30000);

	test('allow_empty_commits=true with only pre-staged .swarm: an empty commit is created and its tree excludes .swarm', async () => {
		fixture();
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ checkpoint: { allow_empty_commits: true } }),
		);
		// FB-008 round 2: the config MUST be committed into the baseline. Left
		// untracked it is a non-swarm dirty path, so the HEAD-moved assertion
		// would pass through the ORDINARY commit arm and leave the allow-empty
		// arm unpinned (the round-1 reviewer's finding).
		git(['add', '.opencode/opencode-swarm.json']);
		git(['commit', '-qm', 'allow-empty config baseline']);
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('.swarm/runtime.json'), 'staged bytes');
		git(['add', '-f', '.swarm/runtime.json']);
		const headBefore = git(['rev-parse', 'HEAD']);
		const treeBefore = git(['rev-parse', 'HEAD^{tree}']);
		const stagedBlob = git(['rev-parse', ':.swarm/runtime.json']);
		const result = await save('allow-empty-prestaged');
		expect(result.success).toBe(true);
		const headAfter = git(['rev-parse', 'HEAD']);
		// Deterministic — the scoped probe sees no non-swarm staged work and
		// the allow-empty arm ALWAYS commits (the pre-fix ternary could never
		// fail).
		expect(headAfter).not.toBe(headBefore);
		// The commit is EMPTY: its tree equals the pre-save tree, so .swarm is
		// excluded entirely (any committed .swarm entry would change the tree)…
		expect(git(['rev-parse', `${headAfter}^{tree}`])).toBe(treeBefore);
		expect(git(['ls-tree', '-r', '--name-only', headAfter])).not.toContain(
			'.swarm/runtime.json',
		);
		// …and the staged entry survives byte-exactly.
		expect(git(['rev-parse', ':.swarm/runtime.json'])).toBe(stagedBlob);
	}, 30000);

	test('a staged deletion (git rm) saves cleanly (4.5 review round 2 regression)', async () => {
		fixture();
		fs.writeFileSync(loc('sample.txt'), 'edited');
		git(['add', 'sample.txt']);
		git(['rm', '-q', '--cached', '--', 'sample.txt']);
		fs.unlinkSync(loc('sample.txt'));
		// Status shows 'D ' — path absent from BOTH disk and index.
		expect(git(['status', '--porcelain'])).toContain('D ');
		const result = await save('staged-deletion');
		expect(result.success).toBe(true);
		const files = committedFiles(String(result.sha));
		expect(files).toContain('sample.txt'); // the staged removal commits
	}, 30000);

	test('a git-rm staged deletion (both flavors) saves cleanly', async () => {
		fixture();
		fs.writeFileSync(loc('victim.txt'), 'bye');
		git(['add', 'victim.txt']);
		git(['commit', '-qm', 'add victim']);
		git(['rm', '-q', 'victim.txt']);
		fs.writeFileSync(loc('sample.txt'), 'edited');
		const result = await save('git-rm');
		expect(result.success).toBe(true);
		const files = committedFiles(String(result.sha));
		expect(files).toContain('victim.txt');
		expect(files).toContain('sample.txt');
	}, 30000);

	test('an ordinary staged rename saves cleanly (4.5 review round 1 regression)', async () => {
		fixture();
		fs.writeFileSync(loc('sample.txt'), 'edited');
		git(['mv', 'sample.txt', 'renamed.txt']);
		const result = await save('staged-rename');
		expect(result.success).toBe(true);
		const files = committedFiles(String(result.sha));
		expect(files).toContain('renamed.txt');
		expect(files).toContain('sample.txt'); // the deletion side of the rename
		expect(git(['show', `${result.sha}:renamed.txt`])).toBe('edited');
	}, 30000);

	test('a REAL staged C record (one deletion, two identical adds) parses and saves cleanly (FB-012)', async () => {
		fixture();
		// Ground truth (git 2.54 probe): porcelain emits C records only when
		// ONE deleted source pairs with TWO identical additions and
		// `status.renames=copies` is set — two fresh identical adds stay 'A'.
		// The previous fixture (`status.renames=true`, M+A) never produced a
		// C record, so the copy branch and its two-token consumption were
		// unexercised (#3763 feedback round X-F08c).
		fs.writeFileSync(loc('orig.txt'), 'identical-bytes');
		git(['add', 'orig.txt']);
		git(['commit', '-qm', 'add orig']);
		fs.copyFileSync(loc('orig.txt'), loc('keep1.txt'));
		fs.copyFileSync(loc('orig.txt'), loc('keep2.txt'));
		fs.unlinkSync(loc('orig.txt'));
		git(['config', 'status.renames', 'copies']);
		git(['add', '-A']);
		// The index really carries a copy + a rename pair over orig.txt:
		expect(git(['status', '--porcelain', '-z'])).toContain('C  keep1.txt');
		const result = await save('staged-copy-c');
		expect(result.success).toBe(true);
		const files = committedFiles(String(result.sha));
		expect(files).toContain('keep1.txt');
		expect(files).toContain('keep2.txt');
		// Second tokens (sources) were consumed, not parsed as records.
		expect(files).not.toContain('orig.txt');
	}, 30000);

	test('a copy crossing the .swarm boundary refuses the save (FB-012 inbound direction)', async () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('.swarm/secret.txt'), 'identical-bytes');
		git(['add', '-f', '.swarm/secret.txt']);
		git(['commit', '-qm', 'track swarm secret']);
		fs.copyFileSync(loc('.swarm/secret.txt'), loc('out1.txt'));
		fs.copyFileSync(loc('.swarm/secret.txt'), loc('out2.txt'));
		fs.unlinkSync(loc('.swarm/secret.txt'));
		git(['config', 'status.renames', 'copies']);
		git(['add', '-f', '-A']);
		// FB-012 round 2: pin that the refusal fires on a REAL C record whose
		// SOURCE is inside .swarm — not on a rename-shaped record that would
		// exercise only the R branch. (Non-z porcelain renders copies as
		// `C  <src> -> <dst>`.)
		const porcelain = git(['status', '--porcelain']);
		expect(porcelain).toMatch(/^C {2}\.swarm\/secret\.txt -> out[12]\.txt$/m);
		const headBefore = git(['rev-parse', 'HEAD']);
		const result = await save('cross-copy');
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain('.swarm boundary');
		expect(git(['rev-parse', 'HEAD'])).toBe(headBefore);
	}, 30000);

	test('subdirectory project root: save stages the subtree and excludes its .swarm (FB-002)', async () => {
		fixture();
		fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
		fs.writeFileSync(loc('pkg/a.txt'), 'package work');
		git(['add', 'pkg/a.txt']);
		git(['commit', '-qm', 'pkg base']);
		fs.mkdirSync(path.join(dir, 'pkg', '.opencode'), { recursive: true });
		fs.mkdirSync(loc('pkg/.swarm'), { recursive: true });
		fs.writeFileSync(loc('pkg/.swarm/runtime.json'), 'runtime state');
		fs.writeFileSync(loc('pkg/a.txt'), 'edited in place');
		const result = await checkpoint.execute(
			{ action: 'save', label: 'subdir-root' },
			{
				directory: path.join(dir, 'pkg'),
				worktree: path.join(dir, 'pkg'),
				sessionID: 'subdir-fixture',
			} as ToolContext,
		);
		const parsed = JSON.parse(
			typeof result === 'string' ? result : result.output,
		);
		expect(parsed.success).toBe(true);
		// Before the fix this died on `fatal: pathspec 'pkg/a.txt' did not
		// match any files` (porcelain root-relative vs cwd=directory add).
		const files = git(['show', '--name-only', '--format=', String(parsed.sha)])
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		expect(files).toContain('pkg/a.txt');
		expect(files.some((f) => f.startsWith('pkg/.swarm/'))).toBe(false);
	}, 30000);

	test('subdirectory project root: restore refuses (parent-repo reset hazard, FB-004)', async () => {
		fixture();
		fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
		fs.writeFileSync(loc('pkg/a.txt'), 'v1');
		git(['add', 'pkg/a.txt']);
		git(['commit', '-qm', 'pkg base']);
		fs.mkdirSync(path.join(dir, 'pkg', '.opencode'), { recursive: true });
		const sub = path.join(dir, 'pkg');
		const saved = await checkpoint.execute(
			{ action: 'save', label: 'sub-ckpt' },
			{
				directory: sub,
				worktree: sub,
				sessionID: 'subdir-fixture',
			} as ToolContext,
		);
		const savedParsed = JSON.parse(
			typeof saved === 'string' ? saved : saved.output,
		);
		expect(savedParsed.success).toBe(true);
		// Uncommitted work in the PARENT repo must not be destroyed by a
		// subdirectory restore: the guard refuses before any reset. The
		// parent file is TRACKED (a reset --hard would revert it) so the
		// content assertion discriminates the guard, unlike an untracked
		// file which no reset deletes (critic r1 fix).
		fs.writeFileSync(loc('parent-tracked.txt'), 'committed parent base');
		git(['add', 'parent-tracked.txt']);
		git(['commit', '-qm', 'parent tracked base']);
		fs.writeFileSync(loc('parent-tracked.txt'), 'DIRTY-PARENT-UNCOMMITTED');
		const result = await checkpoint.execute(
			{ action: 'restore', label: 'sub-ckpt' },
			{
				directory: sub,
				worktree: sub,
				sessionID: 'subdir-fixture',
			} as ToolContext,
		);
		const parsed = JSON.parse(
			typeof result === 'string' ? result : result.output,
		);
		expect(parsed.success).toBe(false);
		expect(String(parsed.error)).toContain(
			'not supported from a subdirectory project root yet',
		);
		expect(fs.readFileSync(loc('parent-tracked.txt'), 'utf8')).toBe(
			'DIRTY-PARENT-UNCOMMITTED',
		);
	}, 30000);

	test('a project directory whose name contains pathspec metacharacters refuses the save (FB-002 guard)', async () => {
		fixture();
		fs.mkdirSync(path.join(dir, 'pk[g]'), { recursive: true });
		fs.writeFileSync(loc('pk[g]/a.txt'), 'work');
		git(['add', 'pk[g]/a.txt']);
		git(['commit', '-qm', 'meta base']);
		fs.mkdirSync(path.join(dir, 'pk[g]', '.opencode'), { recursive: true });
		fs.writeFileSync(loc('pk[g]/a.txt'), 'edited');
		const sub = path.join(dir, 'pk[g]');
		const result = await checkpoint.execute({ action: 'save', label: 'meta' }, {
			directory: sub,
			worktree: sub,
			sessionID: 'meta-fixture',
		} as ToolContext);
		const parsed = JSON.parse(
			typeof result === 'string' ? result : result.output,
		);
		expect(parsed.success).toBe(false);
		expect(String(parsed.error)).toContain('metacharacters');
	}, 30000);

	test('a staged rename crossing the .swarm boundary refuses the save before any mutation', async () => {
		fixture();
		fs.writeFileSync(loc('sample.txt'), 'edited');
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('.swarm/old.txt'), 'runtime');
		git(['add', '-f', '.swarm/old.txt']);
		git(['commit', '-qm', 'track swarm old']);
		// A STAGED rename (git mv) surfaces as an R record in porcelain:
		// destination new-out.txt, source .swarm/old.txt — one side inside
		// .swarm, one outside.
		git(['mv', '-f', '.swarm/old.txt', 'new-out.txt']);
		const headBefore = git(['rev-parse', 'HEAD']);
		const result = await save('cross-boundary');
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain('.swarm boundary');
		// Refused BEFORE mutation: the staged rename is intact, HEAD unchanged.
		expect(git(['rev-parse', 'HEAD'])).toBe(headBefore);
		expect(git(['status', '--porcelain'])).toContain('R');
	}, 30000);

	test('an unmerged (conflicted) path refuses the save instead of silently resolving it', async () => {
		fixture();
		fs.writeFileSync(loc('conflict.txt'), 'base');
		git(['add', 'conflict.txt']);
		git(['commit', '-qm', 'base']);
		// Force stage-1/2/3 unmerged entries via a real merge conflict.
		git(['checkout', '-q', '-b', 'side']);
		fs.writeFileSync(loc('conflict.txt'), 'side');
		git(['commit', '-qam', 'side']);
		git(['checkout', '-q', 'master']);
		fs.writeFileSync(loc('conflict.txt'), 'master');
		git(['commit', '-qam', 'master']);
		try {
			git(['merge', 'side']);
		} catch {
			// expected conflict
		}
		expect(git(['status', '--porcelain'])).toContain('UU');
		const result = await save('unmerged');
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain('unresolved conflicts');
	}, 30000);
});
