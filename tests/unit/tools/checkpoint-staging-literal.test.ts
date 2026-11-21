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
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
	dir = undefined;
	resetSwarmGitExcludedState();
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
	git(['init', '-q']);
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

	test('allow_empty_commits=true with only pre-staged .swarm: an empty commit may exist but its tree excludes .swarm and the entry survives', async () => {
		fixture();
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ checkpoint: { allow_empty_commits: true } }),
		);
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('.swarm/runtime.json'), 'staged bytes');
		git(['add', '-f', '.swarm/runtime.json']);
		const headBefore = git(['rev-parse', 'HEAD']);
		const stagedBlob = git(['rev-parse', ':.swarm/runtime.json']);
		const result = await save('allow-empty-prestaged');
		expect(result.success).toBe(true);
		const headAfter = git(['rev-parse', 'HEAD']);
		// An empty checkpoint commit MAY be created (allow-empty arm)…
		expect(['no-commit', 'empty-commit']).toContain(
			headAfter === headBefore ? 'no-commit' : 'empty-commit',
		);
		if (headAfter !== headBefore) {
			// …but its tree must exclude .swarm entirely.
			expect(committedFiles(headAfter)).not.toContain('.swarm/runtime.json');
			expect(git(['ls-tree', '-r', '--name-only', headAfter])).not.toContain(
				'.swarm/runtime.json',
			);
		}
		// The staged entry is preserved byte-exactly either way.
		expect(git(['rev-parse', ':.swarm/runtime.json'])).toBe(stagedBlob);
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
