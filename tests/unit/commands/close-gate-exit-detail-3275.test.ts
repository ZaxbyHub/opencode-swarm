/**
 * Acceptance check C2 for issue #3317 (class: DISCRIMINATING).
 *
 * When git itself answers with a nonzero exit, the /swarm close fail-closed
 * abort must carry the REAL evidence — exit status and stderr tail — instead
 * of the generic "Ensure git is available" hint. Fixture: a repository whose
 * .git/index is overwritten with garbage bytes, so `git status` exits 128
 * printing `fatal: .git/index: index file smaller than expected` (verified at
 * base: same exit 128 and same stderr with and without --no-optional-locks,
 * porcelain and porcelain -z alike). No seams are stubbed — the real git
 * executable must run.
 *
 * RED at base (the abort is generic: no '128', no stderr tail), GREEN after
 * the fix.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleCloseCommand } from '../../../src/commands/close/orchestrator';
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
function createCorruptIndexRepo(name: string): {
	root: string;
	tracked: string;
	dirtyContent: string;
} {
	const root = canonicalMkdtemp(`3317-exit-${name}-`);
	tempRoots.push(root);
	git(root, 'init', '-q');
	git(root, 'config', 'user.email', 'swarm-test@example.invalid');
	git(root, 'config', 'user.name', 'Swarm Test');
	git(root, 'config', 'commit.gpgsign', 'false');
	const tracked = path.join(root, 'tracked.txt');
	fs.writeFileSync(tracked, 'base\n');
	git(root, 'add', 'tracked.txt');
	git(root, 'commit', '-q', '-m', 'base');
	const dirtyContent = 'uncommitted-must-survive\n';
	fs.writeFileSync(tracked, dirtyContent);
	fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
	// Corrupt the index: every git status read now exits 128 with the
	// "index file smaller than expected" stderr — a REAL nonzero-exit failure
	// the gate must surface, not collapse.
	fs.writeFileSync(path.join(root, '.git', 'index'), 'garbage-not-an-index');
	return { root, tracked, dirtyContent };
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('close gate exit-status detail (#3317 C2)', () => {
	test('abort names exit 128 and the real git stderr tail', async () => {
		const { root, tracked, dirtyContent } = createCorruptIndexRepo('gate');

		const out = await handleCloseCommand(root, []);

		expect(out).toContain('128');
		expect(out).toContain('index file smaller than expected');
		expect(out).toContain('Nothing was closed, archived, or destroyed');
		// Nothing was destroyed by the aborted close.
		expect(fs.readFileSync(tracked, 'utf8')).toBe(dirtyContent);
	}, 60_000);
});
