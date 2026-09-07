/**
 * Issue #2527 (final-critic F2): the `.swarm-worktrees/` lane base must be
 * git-excluded independently of `.swarm/`. Every existing installation already
 * ignores `.swarm/`, so gating the exclude-append on a single `.swarm/`
 * probe silently skipped the new pattern for the entire upgrading installed
 * base. These tests pin the upgrade path: `.swarm/` already excluded (via
 * .gitignore OR via .git/info/exclude) → `.swarm-worktrees/` is appended and
 * `.swarm/` is not duplicated.
 *
 * Lives in its own file because gitignore-warning.test.ts is over the FR-006
 * 500-line cap and must not grow.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { clearDeferredWarnings } from '../src/services/warning-buffer';
import {
	ensureSwarmGitExcluded,
	resetSwarmGitExcludedState,
} from '../src/utils/gitignore-warning';
import { canonicalMkdtemp } from './helpers/tmpdir.js';

function makeRealGitRepo(dir: string): void {
	execSync('git init', { cwd: dir, stdio: 'pipe' });
	execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });
}

function readExclude(dir: string): string {
	try {
		return fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
	} catch {
		return '';
	}
}

describe('ensureSwarmGitExcluded — .swarm-worktrees/ upgrade path (#2527 F2)', () => {
	let tmpDir: string;
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		tmpDir = canonicalMkdtemp('swarm-worktrees-upgrade-2527-');
		resetSwarmGitExcludedState();
		clearDeferredWarnings();
		warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		clearDeferredWarnings();
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Best-effort teardown.
		}
		resetSwarmGitExcludedState();
	});

	it('appends .swarm-worktrees/ when .swarm/ is already in .gitignore', async () => {
		makeRealGitRepo(tmpDir);
		fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.swarm/\n', 'utf8');

		await ensureSwarmGitExcluded(tmpDir);

		const exclude = readExclude(tmpDir);
		expect(exclude).toContain('.swarm-worktrees/');
		// No duplicate `.swarm/` line in the exclude — it stays covered by
		// .gitignore.
		const swarmMatches = exclude.match(/^\.swarm\/$/gm);
		expect(swarmMatches?.length ?? 0).toBe(0);
	});

	it('adds .swarm-worktrees/ without duplicating .swarm/ already in .git/info/exclude', async () => {
		makeRealGitRepo(tmpDir);
		fs.mkdirSync(path.join(tmpDir, '.git', 'info'), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, '.git', 'info', 'exclude'),
			'# existing\n.swarm/\n',
			'utf8',
		);

		await ensureSwarmGitExcluded(tmpDir);

		const exclude = readExclude(tmpDir);
		// Exactly one bare `.swarm/` line — the pre-existing one.
		const matches = exclude.match(/^\.swarm\/$/gm);
		expect(matches?.length ?? 0).toBe(1);
		// The lane base is newly excluded.
		expect(exclude).toContain('.swarm-worktrees/');
	});
});
