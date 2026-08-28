import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Test suite for scripts/check-invariants.sh
 *
 * Tests both real-repo behavior and controlled fixture scenarios for:
 * 1. Subprocess timeout required (advisory)
 * 2. process.cwd() ban in tools/hooks
 * 3. mock.module allowlist
 */

const isWindows = process.platform === 'win32';
const REPO_ROOT = path.resolve(__dirname, '../../../');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'check-invariants.sh');
const SCRIPT_TS_PATH = path.join(REPO_ROOT, 'scripts', 'check-invariants.ts');
const GATE_UTILS_PATH = path.join(REPO_ROOT, 'scripts', 'gate-utils.ts');
const LIB_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'lib',
	'normalize-mock-target.sh',
);
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'scripts', 'mock-allowlist.txt');
const ADVISORY_PUSH_SCRIPT_PATH = path.join(
	REPO_ROOT,
	'scripts',
	'check-no-raw-advisory-push.sh',
);

/**
 * TIMING CONTRACT FOR THIS FILE — the two numbers below are NOT interchangeable
 * and must NOT be set equal.
 *
 * `runCheckInvariants` spawns the real script. Against REPO_ROOT the script
 * walks the whole tree and takes ~37-39s measured on this machine (it grew past
 * 30s when issue #1821 added Check 5), so:
 *
 *   SPAWN_TIMEOUT_MS  — how long spawnSync lets the script run before it KILLS
 *                       it. Too low and the test sees truncated stdout from a
 *                       half-finished script, which is how the Check 4 / Check 5
 *                       assertions started failing with
 *                       'Received: "…Check 3: mock.module allowlist ===\n"'.
 *   TEST_TIMEOUT_MS   — bun:test's per-test budget. It must STRICTLY EXCEED
 *                       SPAWN_TIMEOUT_MS. Setting them equal (the previous bug)
 *                       means the test's own budget expires at the same instant
 *                       the spawn is killed, so the test fails on timeout before
 *                       it can ever assert on the result — the spawn timeout
 *                       becomes unobservable and the file cannot pass. The
 *                       budget has to cover the full spawn allowance PLUS
 *                       fixture setup and assertion overhead.
 *
 */
const SPAWN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 180_000;

/**
 * Helper to run the repository's check-invariants owner from a given directory.
 * Windows executes the native TypeScript owner because bash.exe is the WSL stub.
 */
function runCheckInvariants(
	cwd: string,
	useTsOwner = false,
): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	const effectiveTsOwner = useTsOwner || isWindows;
	const localScript = path.join(
		cwd,
		'scripts',
		effectiveTsOwner ? 'check-invariants.ts' : 'check-invariants.sh',
	);
	const fallback = effectiveTsOwner ? SCRIPT_TS_PATH : SCRIPT_PATH;
	const scriptPath = fs.existsSync(localScript) ? localScript : fallback;
	const command = effectiveTsOwner ? process.execPath : 'bash';
	const result = spawnSync(
		command,
		effectiveTsOwner ? ['run', scriptPath] : [scriptPath],
		{
			cwd,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: SPAWN_TIMEOUT_MS,
		},
	);

	return {
		stdout: result.stdout || '',
		stderr: result.stderr || '',
		exitCode: result.status ?? 1,
	};
}

function runCheckInvariantsFrom(scriptCwd: string, execCwd: string) {
	const effectiveTsOwner = isWindows;
	const localScript = path.join(
		scriptCwd,
		'scripts',
		effectiveTsOwner ? 'check-invariants.ts' : 'check-invariants.sh',
	);
	const fallback = effectiveTsOwner ? SCRIPT_TS_PATH : SCRIPT_PATH;
	const scriptPath = fs.existsSync(localScript) ? localScript : fallback;
	const result = spawnSync(
		effectiveTsOwner ? process.execPath : 'bash',
		effectiveTsOwner ? ['run', scriptPath] : [scriptPath],
		{
			cwd: execCwd,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: SPAWN_TIMEOUT_MS,
		},
	);

	return {
		stdout: result.stdout || '',
		stderr: result.stderr || '',
		exitCode: result.status ?? 1,
	};
}

/**
 * Memoized REPO_ROOT run.
 *
 * Seven tests below assert on the script's output for the real repository. The
 * script is read-only over the tree and fully deterministic for a given commit,
 * so re-spawning it seven times bought nothing and cost ~7 × 38s — which is
 * both slow and seven independent chances to trip a timeout on a cold CI
 * filesystem. Fixture runs are NOT memoized: each seeds different files and
 * must observe its own tree.
 */
let repoRootResult: ReturnType<typeof runCheckInvariants> | undefined;
function runCheckInvariantsOnRepo(): ReturnType<typeof runCheckInvariants> {
	if (!repoRootResult) repoRootResult = runCheckInvariants(REPO_ROOT);
	return repoRootResult;
}

/**
 * Set up a temp fixture dir with a copy of the scripts and controlled src/tests
 */
function setupFixtureDir(fixtureName: string): string {
	// `canonicalMkdtemp` realpath-resolves the system temp root so the fixture
	// cwd matches what production code compares against — on macOS that root is
	// /var/folders/... (symlinked to /private/var/folders/...) and a raw path
	// would mismatch containment guards (issue #1729). It also supplies the
	// uniqueness suffix that a wall-clock millisecond stamp used to provide —
	// collision-free even within one millisecond, and with no clock read at all
	// (docs/testing/test-stability.md).
	const fixtureDir = canonicalMkdtemp(`check-invariants-${fixtureName}-`);
	fs.mkdirSync(path.join(fixtureDir, 'scripts', 'lib'), { recursive: true });
	fs.mkdirSync(path.join(fixtureDir, 'src', 'tools'), { recursive: true });
	fs.mkdirSync(path.join(fixtureDir, 'src', 'hooks'), { recursive: true });
	fs.mkdirSync(path.join(fixtureDir, 'tests'), { recursive: true });

	fs.copyFileSync(
		SCRIPT_PATH,
		path.join(fixtureDir, 'scripts', 'check-invariants.sh'),
	);
	fs.copyFileSync(
		SCRIPT_TS_PATH,
		path.join(fixtureDir, 'scripts', 'check-invariants.ts'),
	);
	fs.copyFileSync(
		GATE_UTILS_PATH,
		path.join(fixtureDir, 'scripts', 'gate-utils.ts'),
	);
	fs.copyFileSync(
		LIB_PATH,
		path.join(fixtureDir, 'scripts', 'lib', 'normalize-mock-target.sh'),
	);
	fs.copyFileSync(
		ALLOWLIST_PATH,
		path.join(fixtureDir, 'scripts', 'mock-allowlist.txt'),
	);
	fs.copyFileSync(
		ADVISORY_PUSH_SCRIPT_PATH,
		path.join(fixtureDir, 'scripts', 'check-no-raw-advisory-push.sh'),
	);

	return fixtureDir;
}

/**
 * Every path Check 5's `KNOWLEDGE_DEDUP_SCOPE` resolves, one representative file
 * per glob. The scope is ASSERTED by the script — a glob that resolves to
 * nothing is itself a hard error — so a fixture that seeds none of them would
 * fail for that reason and prove nothing about detection.
 */
const CHECK5_SCOPE_FILES = [
	'src/tools/knowledge-add.ts',
	'src/hooks/knowledge-store.ts',
	'src/hooks/curator.ts',
	'src/hooks/micro-reflector.ts',
	'src/knowledge/entry-merge.ts',
	'src/learning/provenance.ts',
	'src/services/recommendation-ledger.ts',
	'src/consensus/miner.ts',
];

/**
 * A fixture whose Check 5 scope is fully populated with clean files, so the
 * baseline exit code is 0 and any failure a test observes is the injected one.
 */
function setupCheck5FixtureDir(fixtureName: string): string {
	const fixtureDir = setupFixtureDir(fixtureName);
	for (const relative of CHECK5_SCOPE_FILES) {
		const target = path.join(fixtureDir, ...relative.split('/'));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, 'export const ok = 1;\n');
	}
	return fixtureDir;
}

describe('check-invariants.sh', () => {
	test(
		'should pass when run on the repo',
		() => {
			const result = runCheckInvariantsOnRepo();
			expect(result.stdout).toContain(
				'All engineering invariant checks passed',
			);
			expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'should detect missing mock allowlist file',
		() => {
			const fixtureDir = canonicalMkdtemp(
				'check-invariants-missing-allowlist-',
			);
			fs.mkdirSync(path.join(fixtureDir, 'scripts'), {
				recursive: true,
			});
			fs.mkdirSync(path.join(fixtureDir, 'src', 'tools'), { recursive: true });
			fs.mkdirSync(path.join(fixtureDir, 'src', 'hooks'), { recursive: true });
			fs.mkdirSync(path.join(fixtureDir, 'tests'), { recursive: true });

			fs.copyFileSync(
				SCRIPT_TS_PATH,
				path.join(fixtureDir, 'scripts', 'check-invariants.ts'),
			);
			fs.copyFileSync(
				GATE_UTILS_PATH,
				path.join(fixtureDir, 'scripts', 'gate-utils.ts'),
			);
			// Deliberately do NOT copy the allowlist

			const result = runCheckInvariants(fixtureDir, true);
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr + result.stdout).toContain(
				'mock-allowlist.txt not found',
			);

			fs.rmSync(fixtureDir, { recursive: true, force: true });
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'resolves the repo root from the script location when invoked from a nested cwd',
		() => {
			const fixtureDir = setupFixtureDir('nested-cwd');
			const nested = path.join(fixtureDir, 'nested', 'deep');
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(
				path.join(fixtureDir, 'src', 'tools', 'cwd-violation.ts'),
				'process.cwd();\n',
			);

			const result = runCheckInvariantsFrom(fixtureDir, nested);
			expect(result.stdout).toContain('src/tools/cwd-violation.ts');
			expect(result.exitCode).toBe(1);

			fs.rmSync(fixtureDir, { recursive: true, force: true });
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'should find process.cwd() violations if they exist',
		() => {
			const result = runCheckInvariantsOnRepo();
			expect(result.stdout).toContain(
				'Check 2: process.cwd() ban in tools/hooks',
			);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'should validate mock.module targets against allowlist',
		() => {
			const result = runCheckInvariantsOnRepo();
			expect(result.stdout).toContain('Check 3: mock.module allowlist');
			if (result.exitCode === 0) {
				expect(result.stdout).toContain(
					'All engineering invariant checks passed',
				);
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'should handle file-level timeout check correctly',
		() => {
			const result = runCheckInvariantsOnRepo();
			expect(result.stdout).toContain('Check 1: Subprocess timeout required');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'should run all five checks',
		() => {
			const result = runCheckInvariantsOnRepo();
			expect(result.stdout).toContain('Check 1:');
			expect(result.stdout).toContain('Check 2:');
			expect(result.stdout).toContain('Check 3:');
			expect(result.stdout).toContain('Check 4:');
			expect(result.stdout).toContain('Check 5:');
			expect(result.stdout).toContain('Summary');
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'issue #1821: Check 5 knowledge array dedup guardrail reports a clean repo',
		() => {
			const result = runCheckInvariantsOnRepo();
			expect(result.stdout).toContain(
				'Check 5: knowledge array dedup guardrail',
			);
			// The guardrail ships with an EMPTY exempt list by design, so the only
			// honest steady state is zero unguarded positional caps. If this ever
			// reports a non-zero count, a call site regressed to a bare
			// `.slice(0, 20)` instead of `dedupeCapped`.
			expect(result.stdout).toContain('Unguarded positional caps: 0');
		},
		TEST_TIMEOUT_MS,
	);

	// #1821 F6 — the clean-repo assertion above proves only that Check 5 reports
	// zero, which a check that stopped matching entirely would also do. `08a §6`
	// sets the bar: "verified in both directions — a guardrail fix that stops
	// detecting is worse than the false positive it removes." These inject the
	// banned shapes into a fixture copy (the real repo is never mutated) and
	// require a hard failure, plus negative controls for the correct spellings so
	// the detector cannot be satisfied by matching everything.
	test(
		'issue #1821 F6: Check 5 DETECTS a bare positional cap in the widened scope',
		() => {
			const fixtureDir = setupCheck5FixtureDir('detect-slice');
			// src/knowledge/ is exactly where this diff moved the tag/actionability
			// merge logic, and exactly what the pre-F4 scope was blind to.
			fs.writeFileSync(
				path.join(fixtureDir, 'src', 'knowledge', 'entry-merge.ts'),
				'export function mergeTags(a: string[], b: string[]): string[] {\n' +
					'\treturn [...a, ...b].slice(0, 20);\n}\n',
			);

			const result = runCheckInvariants(fixtureDir);
			expect(result.stdout).toContain('src/knowledge/entry-merge.ts');
			expect(result.stdout).toContain(
				'Positional .slice(0, 20) with no dedup on a knowledge array field',
			);
			expect(result.stdout).toContain('Unguarded positional caps: 1');
			expect(result.exitCode).not.toBe(0);

			fs.rmSync(fixtureDir, { recursive: true, force: true });
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'issue #1821 F6: Check 5 DETECTS a capped string[] accumulator with no dedup',
		() => {
			const fixtureDir = setupCheck5FixtureDir('detect-accumulator');
			// The `>= N … break` spelling both #1821 F2 defects were written in, which
			// the literal `.slice(0, 20)` pattern is blind to.
			fs.writeFileSync(
				path.join(fixtureDir, 'src', 'services', 'recommendation-ledger.ts'),
				'export function sanitizeRefs(refs: string[]): string[] {\n' +
					'\tconst cleaned: string[] = [];\n' +
					'\tfor (const ref of refs) {\n' +
					'\t\tconst trimmed = ref.trim();\n' +
					'\t\tif (trimmed.length === 0) continue;\n' +
					'\t\tcleaned.push(trimmed);\n' +
					'\t\tif (cleaned.length >= MAX_REFS) break;\n' +
					'\t}\n\treturn cleaned;\n}\n',
			);

			const result = runCheckInvariants(fixtureDir);
			expect(result.stdout).toContain('src/services/recommendation-ledger.ts');
			expect(result.stdout).toContain(
				'Capped string[] accumulator with no dedup',
			);
			expect(result.stdout).toContain('Unguarded positional caps: 1');
			expect(result.exitCode).not.toBe(0);

			fs.rmSync(fixtureDir, { recursive: true, force: true });
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'issue #1821 F6: Check 5 passes the CORRECT spellings of both patterns',
		() => {
			// Negative controls in the same harness: dedupe-then-truncate and a
			// seen-Set-guarded accumulator are correct code, and a detector that
			// flagged them would be traded for a false-positive treadmill.
			const fixtureDir = setupCheck5FixtureDir('detect-negative-control');
			fs.writeFileSync(
				path.join(fixtureDir, 'src', 'knowledge', 'entry-merge.ts'),
				'export function mergeTags(a: string[], b: string[]): string[] {\n' +
					'\treturn [\n\t\t...new Set(\n\t\t\t[...a, ...b].map((t) => t.trim()),\n' +
					'\t\t),\n\t].slice(0, 20);\n}\n',
			);
			fs.writeFileSync(
				path.join(fixtureDir, 'src', 'services', 'recommendation-ledger.ts'),
				'export function sanitizeRefs(refs: string[]): string[] {\n' +
					'\tconst seen = new Set<string>();\n' +
					'\tconst cleaned: string[] = [];\n' +
					'\tfor (const ref of refs) {\n' +
					'\t\tif (cleaned.length >= MAX_REFS) break;\n' +
					'\t\tconst trimmed = ref.trim();\n' +
					'\t\tif (seen.has(trimmed)) continue;\n' +
					'\t\tseen.add(trimmed);\n' +
					'\t\tcleaned.push(trimmed);\n' +
					'\t}\n\treturn cleaned;\n}\n',
			);

			const result = runCheckInvariants(fixtureDir);
			expect(result.stdout).toContain('Unguarded positional caps: 0');
			expect(result.stdout, result.stdout).toContain(
				'All engineering invariant checks passed',
			);
			expect(result.exitCode).toBe(0);

			fs.rmSync(fixtureDir, { recursive: true, force: true });
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'issue #1821 F4: Check 5 skips a tree where NO scope entry resolves',
		() => {
			// The Check 4 ratchet fixtures build a temp git repo with only `scripts/`
			// and an empty `src/`. Reporting eight "scope entry resolved to no file"
			// errors there failed every one of those tests for a repository that has
			// no knowledge surface at all. A tree where NOTHING resolves is skipped
			// non-blockingly; a PARTIAL resolution is still a hard error (covered by
			// the detection tests above, whose fixtures resolve the full scope).
			const fixtureDir = setupFixtureDir('check5-no-scope');

			const result = runCheckInvariants(fixtureDir);
			expect(result.stdout).toContain('no Check 5 scope entry resolved');
			expect(result.stdout).toContain('Files scanned: 0');
			expect(result.stdout).not.toContain('resolved to no file');
			expect(result.stdout, result.stdout).toContain(
				'All engineering invariant checks passed',
			);
			expect(result.exitCode).toBe(0);

			fs.rmSync(fixtureDir, { recursive: true, force: true });
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'issue #1666: Check 4 growth ratchet header is present',
		() => {
			const result = runCheckInvariantsOnRepo();
			// The full Check 4 header is emitted whenever the allowlist file
			// exists and a base branch resolves (REPO_ROOT always has origin/main).
			// Deep behavioral coverage of the ratchet lives in the sibling file
			// check-mock-allowlist-ratchet.test.ts (real temp git repo).
			expect(result.stdout).toContain(
				'Check 4: mock.module allowlist growth ratchet',
			);
			expect(result.stdout).toContain('issue #1666');
		},
		TEST_TIMEOUT_MS,
	);
});
