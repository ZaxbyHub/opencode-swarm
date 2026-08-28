/**
 * Issue #1666 — diff-scoped growth ratchet for scripts/mock-allowlist.txt.
 *
 * Each test spawns the real `scripts/check-invariants.sh` in a temp git
 * repository so the diff-scoped set-difference logic (head allowlist vs base
 * via `git show <ref>:scripts/mock-allowlist.txt`) is exercised against real
 * `git diff` output. Pattern mirrors tests/unit/scripts/check-test-file-cap.test.ts
 * but with explicit `timeout: 30000` on every spawn (AGENTS.md invariant 6 /
 * subprocess-safety skill).
 *
 * The ratchet under test is Check 4 in scripts/check-invariants.sh. The other
 * three checks also run when the script is invoked; we focus assertions on
 * Check 4 output and the overall exit code.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const isWindows = process.platform === 'win32';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-invariants.sh');
const SCRIPT_TS = path.join(REPO_ROOT, 'scripts', 'check-invariants.ts');
const GATE_UTILS = path.join(REPO_ROOT, 'scripts', 'gate-utils.ts');
const LIB = path.join(REPO_ROOT, 'scripts', 'lib', 'normalize-mock-target.sh');
// Check 6 (issue #1976) delegates to this sibling script. Every fixture copies
// check-invariants.sh; without this file Check 6's `bash <missing>` fails and
// increments `violations`, so every exit-0 assertion would flip to exit 1.
const ADVISORY_PUSH_SCRIPT = path.join(
	REPO_ROOT,
	'scripts',
	'check-no-raw-advisory-push.sh',
);

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Spawn check-invariants.sh in `repoDir`. The fixture's `scripts/` subtree is
 * populated by `makeRepo()` so the script resolves its own directory relative
 * to the fixture, not the live repo.
 *
 * `timeout: 30000` is mandatory (AGENTS.md invariant 6 + subprocess-safety
 * skill). The sibling check-test-file-cap.test.ts omits it; we do not
 * propagate that gap.
 */
function runScript(repoDir: string, env?: Record<string, string>): SpawnResult {
	if (isWindows) {
		// bash on Windows is the WSL stub; skip the same way the existing
		// check-invariants.test.ts does (the CI runners that matter are
		// ubuntu/macos). Bash is required because the script uses bash-only
		// constructs (arrays, process substitution).
		throw new Error('bash not available on Windows');
	}
	// CRITICAL: invoke the fixture's local script copy, not the repo's.
	// scripts/check-invariants.sh resolves its allowlist via
	// `ALLOWLIST_FILE="$(dirname "$0")/mock-allowlist.txt"` — $0-relative, NOT
	// cwd-relative. If we invoked the repo's absolute SCRIPT path, dirname
	// would resolve to <REPO>/scripts/, and the script would read the repo's
	// ~110-entry allowlist instead of the fixture's 1-2-entry one — every
	// assertion would be wrong. The sibling check-invariants.test.ts:39-40
	// uses the same local-vs-absolute pattern. `copyScripts()` (called by
	// makeRepo) already wrote the script into the fixture.
	const localScript = path.join(repoDir, 'scripts', 'check-invariants.sh');
	const result = spawnSync('bash', [localScript], {
		cwd: repoDir,
		env: { ...process.env, ...env },
		encoding: 'utf-8',
		stdio: ['pipe', 'pipe', 'pipe'],
		timeout: 30000,
	});
	return {
		exitCode: result.status ?? 1,
		stdout: result.stdout || '',
		stderr: result.stderr || '',
	};
}

function git(repoDir: string, ...args: string[]): void {
	const proc = spawnSync('git', args, {
		cwd: repoDir,
		env: process.env,
		encoding: 'utf-8',
		stdio: ['pipe', 'pipe', 'pipe'],
		timeout: 30000,
	});
	if (proc.status !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed in ${repoDir}: ${proc.stderr || proc.stdout}`,
		);
	}
}

/** Write `lineCount` filler lines so the fixture looks like a real test file. */
function writeAllowlist(repoDir: string, entries: string[]): void {
	const dir = path.join(repoDir, 'scripts', 'lib');
	fs.mkdirSync(dir, { recursive: true });
	// Minimal header — Check 4 only cares about non-comment, non-blank lines.
	const lines = ['# mock.module Allowlist — test fixture', '#', ...entries, ''];
	fs.writeFileSync(
		path.join(repoDir, 'scripts', 'mock-allowlist.txt'),
		lines.join('\n'),
		'utf-8',
	);
}

/** Seed the fixture with the live scripts so check-invariants.sh runs there. */
function copyScripts(repoDir: string): void {
	const scriptsDir = path.join(repoDir, 'scripts');
	fs.mkdirSync(scriptsDir, { recursive: true });
	fs.mkdirSync(path.join(scriptsDir, 'lib'), { recursive: true });
	fs.copyFileSync(SCRIPT, path.join(scriptsDir, 'check-invariants.sh'));
	fs.copyFileSync(SCRIPT_TS, path.join(scriptsDir, 'check-invariants.ts'));
	fs.copyFileSync(GATE_UTILS, path.join(scriptsDir, 'gate-utils.ts'));
	fs.copyFileSync(
		LIB,
		path.join(scriptsDir, 'lib', 'normalize-mock-target.sh'),
	);
	fs.copyFileSync(
		ADVISORY_PUSH_SCRIPT,
		path.join(scriptsDir, 'check-no-raw-advisory-push.sh'),
	);
}

/**
 * Build a temp git repo whose initial commit on `main` is a baseline
 * allowlist. Tests then modify HEAD's allowlist, commit, and run the script.
 *
 * `origin/main` is created as a branch ref so the script's
 * `origin/main origin/master main master` lookup resolves it (mirrors the
 * pattern in check-test-file-cap.test.ts:106-120).
 */
function makeRepo(baseEntries: string[]): string {
	const repoDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'mock-ratchet-1666-')),
	);
	git(repoDir, 'init', '-q', '-b', 'main');
	git(repoDir, 'config', 'user.email', 'test@example.com');
	git(repoDir, 'config', 'user.name', 'Test');
	copyScripts(repoDir);
	writeAllowlist(repoDir, baseEntries);
	// scripts/check-invariants.sh Check 1 also greps src/ for spawn — give it
	// an empty src/ so the scan has no hits (avoids noise in output).
	fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
	git(repoDir, 'add', '-A');
	git(repoDir, 'commit', '-q', '-m', 'init');
	git(repoDir, 'branch', 'origin/main');
	return repoDir;
}

const tempRoots: string[] = [];

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			try {
				fs.rmSync(root, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	}
});

describe('check-invariants.sh Check 4 — mock.module allowlist growth ratchet', () => {
	test('no-growth pass: base and HEAD allowlists identical → exit 0', () => {
		if (isWindows) return;
		const base = ['node:fs', 'src/foo/bar'];
		const repoDir = makeRepo(base);
		tempRoots.push(repoDir);
		// HEAD allowlist unchanged from base.
		const result = runScript(repoDir);
		expect(result.stdout).toContain('Added in this PR: 0');
		expect(result.stdout).toContain('Unapproved: 0');
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	});

	test('growth with marker pass: HEAD adds an entry AND the matching APPROVED-NEW marker → exit 0', () => {
		if (isWindows) return;
		const repoDir = makeRepo(['node:fs']);
		tempRoots.push(repoDir);
		// Add a new entry and a matching standalone marker.
		writeAllowlist(repoDir, [
			'# APPROVED-NEW: src/new/target',
			'node:fs',
			'src/new/target',
		]);
		git(repoDir, 'add', '-A');
		git(repoDir, 'commit', '-q', '-m', 'add approved target');
		const result = runScript(repoDir);
		expect(result.stdout).toContain('Added in this PR: 1');
		expect(result.stdout).toContain('Approved-new markers found: 1');
		expect(result.stdout).toContain('Unapproved: 0');
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	});

	test('growth without marker fail: HEAD adds an entry without a marker → exit 1', () => {
		if (isWindows) return;
		const repoDir = makeRepo(['node:fs']);
		tempRoots.push(repoDir);
		writeAllowlist(repoDir, ['node:fs', 'src/new/target']);
		git(repoDir, 'add', '-A');
		git(repoDir, 'commit', '-q', '-m', 'add unapproved target');
		const result = runScript(repoDir);
		expect(result.stdout).toContain('Added in this PR: 1');
		expect(result.stdout).toContain('Unapproved: 1');
		expect(result.stdout).toContain(
			"ERROR (ratchet): new mock target 'src/new/target'",
		);
		expect(result.exitCode, result.stdout + result.stderr).toBe(1);
	});

	test('growth with mismatched marker fail: marker names a different target → exit 1', () => {
		if (isWindows) return;
		const repoDir = makeRepo(['node:fs']);
		tempRoots.push(repoDir);
		// Marker names src/wrong — added entry is src/new. Ratchet must fail.
		writeAllowlist(repoDir, [
			'# APPROVED-NEW: src/wrong/target',
			'node:fs',
			'src/new/target',
		]);
		git(repoDir, 'add', '-A');
		git(repoDir, 'commit', '-q', '-m', 'add target with wrong marker');
		const result = runScript(repoDir);
		expect(result.stdout).toContain(
			"ERROR (ratchet): new mock target 'src/new/target'",
		);
		expect(result.stdout).toContain('Unapproved: 1');
		expect(result.exitCode, result.stdout + result.stderr).toBe(1);
	});

	test('PRR-005 marker normalization: `# APPROVED-NEW: ../../../src/foo/bar.js` approves entry `src/foo/bar`', () => {
		if (isWindows) return;
		// normalize_mock_target strips leading ../ and ./, then leading src/,
		// then trailing .js, then re-prefixes src/. The marker target is
		// normalized through the same routine at check-invariants.sh:281, so
		// a path-traversal form marker must match the canonical entry form.
		// This is documented in docs/releases/pending/1666-mock-allowlist-growth-ratchet.md
		// and was previously untested (PRR-005).
		const repoDir = makeRepo(['node:fs']);
		tempRoots.push(repoDir);
		writeAllowlist(repoDir, [
			'# APPROVED-NEW: ../../../src/foo/bar.js',
			'node:fs',
			'src/foo/bar',
		]);
		git(repoDir, 'add', '-A');
		git(repoDir, 'commit', '-q', '-m', 'add target with path-traversal marker');
		const result = runScript(repoDir);
		expect(result.stdout).toContain('Added in this PR: 1');
		expect(result.stdout).toContain('Approved-new markers found: 1');
		expect(result.stdout).toContain('Unapproved: 0');
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	});

	test('PRR-006 multi-target partial approval: 2 added, only 1 has marker → exit 1 with one violation', () => {
		if (isWindows) return;
		// The per-entry loop at check-invariants.sh:288-299 must independently
		// evaluate each added entry. With 2 added entries and only 1 approved,
		// the unapproved one must still produce a violation. Previously
		// untested (PRR-006).
		const repoDir = makeRepo(['node:fs']);
		tempRoots.push(repoDir);
		writeAllowlist(repoDir, [
			'# APPROVED-NEW: src/approved/target',
			'node:fs',
			'src/approved/target',
			'src/unapproved/target',
		]);
		git(repoDir, 'add', '-A');
		git(repoDir, 'commit', '-q', '-m', 'add two targets, one approved');
		const result = runScript(repoDir);
		expect(result.stdout).toContain('Added in this PR: 2');
		expect(result.stdout).toContain('Approved-new markers found: 1');
		expect(result.stdout).toContain('Unapproved: 1');
		expect(result.stdout).toContain(
			"ERROR (ratchet): new mock target 'src/unapproved/target'",
		);
		expect(result.stdout).not.toContain(
			"ERROR (ratchet): new mock target 'src/approved/target'",
		);
		expect(result.exitCode, result.stdout + result.stderr).toBe(1);
	});

	test('shrink pass: HEAD removes an entry → exit 0 (ratchet only fires on growth)', () => {
		if (isWindows) return;
		const repoDir = makeRepo(['node:fs', 'src/foo/old']);
		tempRoots.push(repoDir);
		writeAllowlist(repoDir, ['node:fs']);
		git(repoDir, 'add', '-A');
		git(repoDir, 'commit', '-q', '-m', 'remove entry');
		const result = runScript(repoDir);
		expect(result.stdout).toContain('Added in this PR: 0');
		expect(result.stdout).toContain('Unapproved: 0');
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	});

	test('simultaneous grow+shrink pass: HEAD adds (with marker) and removes → exit 0', () => {
		if (isWindows) return;
		const repoDir = makeRepo(['node:fs', 'src/foo/old']);
		tempRoots.push(repoDir);
		writeAllowlist(repoDir, [
			'# APPROVED-NEW: src/new/target',
			'node:fs',
			'src/new/target',
		]);
		git(repoDir, 'add', '-A');
		git(repoDir, 'commit', '-q', '-m', 'swap');
		const result = runScript(repoDir);
		expect(result.stdout).toContain('Added in this PR: 1');
		expect(result.stdout).toContain('Unapproved: 0');
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	});

	test('soft-warn escape hatch: MOCK_ALLOWLIST_ENFORCE=0 → exit 0 with violation still printed', () => {
		if (isWindows) return;
		const repoDir = makeRepo(['node:fs']);
		tempRoots.push(repoDir);
		writeAllowlist(repoDir, ['node:fs', 'src/new/target']);
		git(repoDir, 'add', '-A');
		git(repoDir, 'commit', '-q', '-m', 'add unapproved target');
		const result = runScript(repoDir, { MOCK_ALLOWLIST_ENFORCE: '0' });
		expect(result.stdout).toContain(
			"ERROR (ratchet): new mock target 'src/new/target'",
		);
		expect(result.stdout).toContain(
			'MOCK_ALLOWLIST_ENFORCE is off — soft-warn (non-blocking).',
		);
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	});

	test('no base branch skip: deleting origin/main and main → exit 0 with NOTE printed', () => {
		if (isWindows) return;
		const repoDir = makeRepo(['node:fs']);
		tempRoots.push(repoDir);
		writeAllowlist(repoDir, ['node:fs', 'src/new/target']);
		git(repoDir, 'add', '-A');
		git(repoDir, 'commit', '-q', '-m', 'add unapproved target');
		// Remove the base-branch refs the script's lookup resolves.
		git(repoDir, 'branch', '-D', 'origin/main');
		// `main` is the current branch — rename it out of the way so the
		// script's `main` lookup also fails. (git branch -m keeps the working
		// tree on the renamed branch; the script will fail every branch name
		// in its priority loop and hit the skip path.)
		git(repoDir, 'branch', '-m', 'feature');
		const result = runScript(repoDir);
		expect(result.stdout).toContain(
			'no base branch found (no PR context) — skipping Check 4',
		);
		// Exit 0 overall: the no-base-branch path is non-blocking.
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	});

	test('CRLF head, LF base pass: Check 3 matching and Check 4 growth do not false-fire', () => {
		if (isWindows) return;
		const repoDir = makeRepo(['node:fs', 'src/foo/bar']);
		tempRoots.push(repoDir);
		fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
		fs.writeFileSync(
			path.join(repoDir, 'tests', 'fixture.test.ts'),
			'mock' + ".module('node:fs', () => ({}));\n",
			'utf-8',
		);
		// Rewrite HEAD allowlist with CRLF line endings. The base (committed
		// with LF) is unchanged; without `tr -d '\r'`, every head entry carries
		// a trailing '\r'. Check 3 then rejects the valid node:fs mock, while
		// Check 4 incorrectly reports every entry as added.
		const crlfContent =
			[
				'# mock.module Allowlist — test fixture',
				'#',
				'node:fs',
				'src/foo/bar',
				'',
			].join('\r\n') + '\r\n';
		fs.writeFileSync(
			path.join(repoDir, 'scripts', 'mock-allowlist.txt'),
			crlfContent,
			'utf-8',
		);
		fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
		fs.writeFileSync(
			path.join(repoDir, 'tests', 'allowed.test.ts'),
			"import { afterEach, mock } from 'bun:test';\nimport * as realFs from 'node:fs';\nafterEach(() => mock.restore());\nmock.module('node:fs', () => ({ ...realFs }));\n",
		);
		git(repoDir, 'add', '-A');
		// Suppress CRLF→LF normalization on commit so the blob actually
		// differs (otherwise git would normalize and mask the bug).
		git(repoDir, 'commit', '-q', '-m', 'rewrite allowlist with CRLF');
		const result = runScript(repoDir);
		expect(result.stdout).not.toContain(
			"mock.module target 'node:fs' not in allowlist",
		);
		expect(result.stdout).toContain('Added in this PR: 0');
		expect(result.stdout).toContain('Unapproved: 0');
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
	});
});
