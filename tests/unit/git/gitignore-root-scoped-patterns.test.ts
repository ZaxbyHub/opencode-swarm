/**
 * F-003 (PR 3922 review) regression: the root `.gitignore` entries added by
 * this PR for OpenCode session transcripts and local release tarballs must
 * be ROOT-ANCHORED.
 *
 * Prior buggy behavior: the patterns `session-*.json` and `*.tgz` were
 * unscoped, so git's recursive matching silently ignored ANY file with a
 * matching basename at ANY depth — a future legitimate nested fixture such
 * as `tests/fixtures/session-replay.json` (or a nested tarball artifact)
 * would be skipped by default `git add` with no error.
 *
 * The probe is `git check-ignore` in a throwaway repo whose `.gitignore` is
 * the REAL repo root `.gitignore` (byte-identical copy), with user/global
 * exclude sources neutralized (empty `core.excludesFile`,
 * `GIT_CONFIG_NOSYSTEM=1`) so only the repo patterns decide. The `-v`
 * pattern field is asserted exactly: the root-anchored forms `/session-*.json`
 * and `/*.tgz` prove the anchoring itself, not merely that some rule fired.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const REPO_GITIGNORE = join(REPO_ROOT, '.gitignore');

let dir: string | undefined;

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function git(args: string[]): string {
	if (!dir) throw new Error('Missing scratch repo');
	return execFileSync('git', args, {
		cwd: dir,
		encoding: 'utf8',
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 15000,
		maxBuffer: 32768,
	}).trim();
}

/** check-ignore exits 0 (+ -v line) when the path is ignored, 1 when not. */
function checkIgnore(relPath: string): { ignored: boolean; pattern?: string } {
	try {
		const verbose = git(['check-ignore', '-v', '--', relPath]);
		// -v output: "<source>:<linenum>:<pattern>\t<path>". Isolate the
		// pattern after the LAST ":<digits>:" prefix (Windows drive colons in
		// the absolute source path must not confuse the split).
		const firstField = verbose.split('\t')[0] ?? '';
		const pattern = firstField.match(/:\d+:(.+)$/)?.[1];
		return { ignored: true, pattern };
	} catch (error) {
		const status = (error as { status?: number }).status;
		if (status === 1) return { ignored: false };
		throw error;
	}
}

function fixture(): void {
	if (!existsSync(REPO_GITIGNORE)) {
		throw new Error(`repo root .gitignore not found at ${REPO_GITIGNORE}`);
	}
	dir = canonicalMkdtemp('gitignore-root-scoped-');
	git(['init', '-q']);
	git(['config', 'user.email', 'test@example.invalid']);
	git(['config', 'user.name', 'Fixture']);
	// Neutralize every exclude source except the copied root .gitignore.
	const emptyExcludes = join(dir, 'empty-user-excludes');
	writeFileSync(emptyExcludes, '');
	git(['config', 'core.excludesFile', emptyExcludes]);
	writeFileSync(join(dir, '.gitignore'), readFileSync(REPO_GITIGNORE, 'utf8'));
}

test('root session transcripts stay ignored by the root-anchored /session-*.json pattern (F-003)', () => {
	fixture();
	const probe = checkIgnore('session-opencode-transcript.json');
	expect(probe.ignored).toBe(true);
	expect(probe.pattern).toBe('/session-*.json');
});

test('a legitimate nested session fixture is NOT ignored (F-003 regression)', () => {
	fixture();
	// Pre-fix this path matched the unscoped `session-*.json` pattern and was
	// silently skipped by default git add.
	const probe = checkIgnore('tests/fixtures/session-replay.json');
	expect(probe.ignored).toBe(false);
});

test('root release tarballs stay ignored by the root-anchored /*.tgz pattern (F-003)', () => {
	fixture();
	const probe = checkIgnore('opencode-swarm-6.0.0.tgz');
	expect(probe.ignored).toBe(true);
	expect(probe.pattern).toBe('/*.tgz');
});

test('a nested tarball artifact is NOT ignored (F-003 regression)', () => {
	fixture();
	const probe = checkIgnore('tests/fixtures/artifact.tgz');
	expect(probe.ignored).toBe(false);
});
