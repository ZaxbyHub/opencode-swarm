/**
 * Acceptance check C1 for issue #3317 (class: NEW-SURFACE).
 *
 * The /swarm close fail-closed gate must report WHY a git-status read failed
 * instead of collapsing every failure into the generic "Ensure git is
 * available and the repository is readable" hint. A timed-out read (spawn
 * ETIMEDOUT) must surface the ETIMEDOUT code in the abort text, and the abort
 * must still be fully non-destructive: dirty tracked bytes survive, .swarm/
 * survives.
 *
 * Stubbing surface: `gitStatusReadInternals` from the new
 * src/commands/git-status-read module (readOnce + resolveExecutable seams).
 * The executable seam is pinned to a plausible string so the gate never probes
 * the real host.
 *
 * RED at base (module src/commands/git-status-read does not exist), GREEN
 * after the fix.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleCloseCommand } from '../../../src/commands/close/orchestrator';
import { gitStatusReadInternals } from '../../../src/commands/git-status-read';
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

/**
 * Canonical gate fixture: a real git repository holding one committed file
 * that is then dirtied, plus a `.swarm/` directory — the exact state whose
 * uncommitted tracked work the gate exists to protect.
 */
function createDirtyGitRepo(name: string): {
	root: string;
	tracked: string;
	dirtyContent: string;
} {
	const root = canonicalMkdtemp(`3317-timeout-${name}-`);
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
	return { root, tracked, dirtyContent };
}

const originalReadOnce = gitStatusReadInternals.readOnce;
const originalResolveExecutable = gitStatusReadInternals.resolveExecutable;

afterEach(() => {
	gitStatusReadInternals.readOnce = originalReadOnce;
	gitStatusReadInternals.resolveExecutable = originalResolveExecutable;
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('close gate timeout diagnosability (#3317 C1)', () => {
	test('an ETIMEDOUT status read aborts close naming the timeout code, not the generic hint', async () => {
		const { root, tracked, dirtyContent } = createDirtyGitRepo('gate');
		gitStatusReadInternals.readOnce = async () => ({
			ok: false,
			code: 'ETIMEDOUT',
			status: null,
			stderrTail: '',
		});
		gitStatusReadInternals.resolveExecutable = async () => 'git';

		const out = await handleCloseCommand(root, []);

		expect(out).toContain('ETIMEDOUT');
		expect(out).not.toContain('Ensure git is available');
		expect(out).toContain('Nothing was closed, archived, or destroyed');
		// Non-destructive abort: the dirty tracked bytes and .swarm/ survive.
		expect(fs.readFileSync(tracked, 'utf8')).toBe(dirtyContent);
		expect(fs.existsSync(path.join(root, '.swarm'))).toBe(true);
	}, 60_000);
});
