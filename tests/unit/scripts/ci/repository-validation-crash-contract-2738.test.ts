import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Durable contract guard for the issue #2738 crash-fixture retirement
 * (trace 3250-2738-merge-queue-ci-reliability).
 *
 * The macOS quarantine for
 * tests/unit/scripts/ci/repository-validation-real-process-2675.test.ts was
 * retired by making the crash fixture's termination TOPOLOGY-INDEPENDENT:
 * the fixture now signals its own PROCESS GROUP (`kill -KILL 0`) instead of
 * `kill -KILL <process.ppid>`, which assumed Bun's worker topology and broke
 * on macos-latest / Bun 1.3.13 (the spawned `bun test` observed a worker
 * failure, exited 0, and the harness recorded a pass — 9/9 CI failures).
 *
 * These source pins keep the retirement honest on every platform (no process
 * spawning, so they run on Windows too, where the crash arm itself is
 * skipped): if any of the four contract legs regresses — the group-kill
 * target, the survival diagnostic, the ledger retirement, or the detached
 * spawn that makes the group kill SAFE — this suite goes red before macOS CI
 * can mis-record another surviving child.
 */

const REPO_ROOT = join(import.meta.dir, '../../../..');

const CRASH_FIXTURE_PATH = join(
	REPO_ROOT,
	'tests/unit/scripts/ci/fixtures/repository-validation-crash-fixture.ts',
);
const AUTHORITY_TEST_PATH = join(
	REPO_ROOT,
	'tests/unit/scripts/ci/repository-validation-real-process-2675.test.ts',
);
const HARNESS_PATH = join(REPO_ROOT, 'scripts/ci/repository-validation.ts');
const LEDGER_PATHS = [
	'scripts/ci/quarantined-tests.txt',
	'scripts/ci/quarantined-tests-windows.txt',
	'scripts/ci/quarantined-tests-macos.txt',
	'scripts/ci/quarantined-integration-tests.txt',
].map((relative) => join(REPO_ROOT, relative));

const RETIRED_TEST_FILE =
	'tests/unit/scripts/ci/repository-validation-real-process-2675.test.ts';

// CRLF-normalize: Windows checkouts can hold CRLF working copies while the
// committed file is LF; assertions must hold on both (ci-coverage-sharding
// precedent).
function readText(path: string): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

describe('repository-validation crash contract — issue #2738 retirement', () => {
	const fixture = readText(CRASH_FIXTURE_PATH);
	const authorityTest = readText(AUTHORITY_TEST_PATH);
	const harness = readText(HARNESS_PATH);

	test('crash fixture signals its own process group, not a topology-dependent pid', () => {
		// `kill -KILL 0` targets the caller's whole process group: the
		// harness spawns `bun test` detached (own group/session), so every
		// worker/supervisor/fixture under it shares the group and the
		// authority's child dies regardless of Bun's internal topology.
		expect(fixture).toContain("'-KILL', '0'");
		// The old design keyed on the fixture's parent pid; any re-introduction
		// of `process.ppid` in this fixture re-opens the #2738 class (the
		// signal misses the authority's child on a topology change).
		expect(fixture).not.toContain('process.ppid');
	});

	test('the crash arm fails with an explicit child-survival diagnostic', () => {
		// The ledger's retirement criterion named survival detection: if the
		// child survives and the harness records `passed`, the assertion
		// message must name the mechanism, not a bare status mismatch.
		expect(authorityTest).toContain('child survived the delivered signal');
	});

	test('the retired file stays out of every quarantine ledger', () => {
		// Re-adding the entry would silently skip the crash-classification
		// arm on macOS CI — the exact coverage the retirement restored.
		// PRR-010: parse ACTIVE entries per the ledgers' documented format
		// (blank lines and lines starting with # are ignored) instead of a
		// raw whole-file includes — a prose mention of the retired path
		// (line-wrapped or not) must not fail this guard, and an ACTIVE
		// entry line must. Mirrors the activeEntries() sibling readers.
		for (const ledgerPath of LEDGER_PATHS) {
			const activeEntries = readText(ledgerPath)
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith('#'));
			expect(
				activeEntries.includes(RETIRED_TEST_FILE),
				`${ledgerPath} must not list the retired #2738 entry as an active path`,
			).toBe(false);
		}
	});

	test('the harness still spawns validation children detached (group-kill safety precondition)', () => {
		// `kill -KILL 0` from the fixture is SAFE only because the harness
		// spawns the child `detached: true`, making it a process-group and
		// session leader (Bun maps detached to POSIX_SPAWN_SETSID, including
		// the macOS non-PTY posix_spawn path). If this flag is ever dropped,
		// the child shares the OUTER test runner's process group and the
		// fixture's group kill would take the runner down with it. The
		// harness's own killProcessTree already relies on the same property
		// via `process.kill(-child.pid, 'SIGKILL')`.
		// Scoped to the VALIDATION-CHILD spawn block: a file-wide contains
		// check stays green if the flag migrates to another Bun.spawn in the
		// same file, which would re-arm the exact hazard this guard pins.
		const spawnStart = harness.indexOf('child = Bun.spawn(item.argv');
		expect(spawnStart).toBeGreaterThanOrEqual(0);
		const spawnBlock = harness.slice(spawnStart, spawnStart + 500);
		// Active-option match (not a commented-out `// detached: true`):
		// line-anchored, so only a live option line satisfies it.
		expect(spawnBlock).toMatch(/^[^\S\n]*detached: true,$/m);
		expect(harness).toContain("process.kill(-child.pid, 'SIGKILL')");
	});
});
