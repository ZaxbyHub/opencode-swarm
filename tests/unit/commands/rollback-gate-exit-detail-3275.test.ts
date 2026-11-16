/**
 * Acceptance check C5 for issue #3317 (class: DISCRIMINATING).
 *
 * The /swarm rollback gate's `measureGitDestruction` must carry the real git
 * failure evidence on its `unreadable` verdict: exit `status` and a
 * `stderrTail`. Fixture: a repository whose .git/index is overwritten with
 * garbage bytes, so `git status --porcelain -z` exits 128 printing
 * `fatal: .git/index: index file smaller than expected` (verified at base,
 * with and without --no-optional-locks). No seams are stubbed — the real git
 * executable must run. The call is awaited (awaiting the sync base value is a
 * no-op; the fixed value is a Promise).
 *
 * RED at base (kind is 'unreadable' but carries no status/stderrTail fields),
 * GREEN after the fix.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { measureGitDestruction } from '../../../src/commands/rollback-gate';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const GIT_TIMEOUT_MS = 10_000;
const tempRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

/** Real repo with a committed-then-dirtied file and a corrupted .git/index. */
function createCorruptIndexRepo(name: string): string {
	const root = canonicalMkdtemp(`3317-rbgate-${name}-`);
	tempRoots.push(root);
	git(root, 'init', '-q');
	git(root, 'config', 'user.email', 'swarm-test@example.invalid');
	git(root, 'config', 'user.name', 'Swarm Test');
	git(root, 'config', 'commit.gpgsign', 'false');
	const tracked = path.join(root, 'tracked.txt');
	fs.writeFileSync(tracked, 'base\n');
	git(root, 'add', 'tracked.txt');
	git(root, 'commit', '-q', '-m', 'base');
	fs.writeFileSync(tracked, 'uncommitted-must-survive\n');
	// Corrupt the index so the gate's status read exits 128 with a real
	// stderr tail the measurement must surface.
	fs.writeFileSync(path.join(root, '.git', 'index'), 'garbage-not-an-index');
	return root;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('rollback gate exit-status detail (#3317 C5)', () => {
	test('unreadable measurement carries status 128 and the git stderr tail', async () => {
		const root = createCorruptIndexRepo('detail');

		const m = await measureGitDestruction(root);

		expect(m.kind).toBe('unreadable');
		expect('status' in m).toBe(true);
		expect((m as { status?: unknown }).status).toBe(128);
		expect('stderrTail' in m).toBe(true);
		expect((m as { stderrTail?: string }).stderrTail ?? '').toContain(
			'index file smaller than expected',
		);
	}, 60_000);
});
