/**
 * Checkpoint-manifest integrity coverage for repro-check.sh (issue-tracer v3).
 *
 * Three holes were reproduced against the pre-fix script and are pinned here:
 *
 *   ATTACK A - deleting a middle manifest line silently dropped a frozen check,
 *              because `do_verify` iterated only the surviving rows: no error,
 *              no count mismatch, no gap signal.
 *   ATTACK B - no editing needed at all. Re-running the script's own sanctioned
 *              `checkpoint` command on an already-frozen path appended a fresh
 *              `CHECKPOINT` row, and `do_verify` is last-writer-wins per path,
 *              so a WEAKENED check silently re-baselined to green.
 *   ATTACK C - seq contiguity is only a PREFIX invariant, so the first fix for
 *              ATTACK A did not cover tail truncation: `head -3` leaves seq
 *              running 1..N over the survivors. That both dropped the truncated
 *              checks from the replay set AND un-froze their paths, re-opening
 *              ATTACK B through the very guard added to close it. The header now
 *              records the expected row count, which makes the check total.
 *
 * The manifest is tamper-EVIDENT, not tamper-proof: the whole trace directory is
 * the agent's own write surface. What these tests pin is that the SILENT routes
 * are closed - a weakening now has to be a visible, deliberate rewrite.
 *
 * The final test covers the primary GNU-`timeout` watchdog branch in `run_one`,
 * which the sibling watchdog test in repro-check.test.ts cannot reach because it
 * sets REPRO_CHECK_FORCE_FALLBACK=1 and takes the POSIX fallback instead.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SCRIPT = path.resolve(
	process.cwd(),
	'.opencode/skills/issue-tracer/scripts/repro-check.sh',
);
const MANIFEST_REL = '.agents/issue-traces/issue-1/repro/checkpoint.manifest';
const CHECK_FILES = ['check-a.sh', 'check-b.sh', 'check-c.sh'];

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
	return proc.stdout.toString().trim();
}

/**
 * REPRO_CHECK_FORCE_FALLBACK is pinned to '0' so every run here takes the
 * primary `command -v timeout` branch of run_one rather than inheriting an
 * ambient override - it is what makes the watchdog test branch-specific.
 */
function run(cwd: string, args: string[], timeoutMs = 30_000) {
	const proc = Bun.spawnSync({
		cmd: bashCommand(SCRIPT, ...args),
		cwd,
		env: { ...process.env, REPRO_CHECK_FORCE_FALLBACK: '0' },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: timeoutMs,
	});
	return {
		code: proc.exitCode,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
	};
}

function repo(): string {
	const value = canonicalMkdtemp('repro-manifest-');
	roots.push(value);
	git(value, 'init', '-q', '-b', 'main');
	git(value, 'config', 'user.email', 'trace@example.invalid');
	git(value, 'config', 'user.name', 'Trace');
	for (const name of CHECK_FILES) {
		fs.writeFileSync(
			path.join(value, name),
			`#!/usr/bin/env bash\ngrep -q fixed subject.txt || exit 1\necho ${name} passed\n`,
		);
	}
	fs.writeFileSync(path.join(value, 'subject.txt'), 'buggy\n');
	git(value, 'add', '-A');
	git(value, 'commit', '-q', '-m', 'base');
	return value;
}

function manifestFile(repoDir: string): string {
	return path.join(repoDir, MANIFEST_REL);
}

/** Header line plus every data row, empty trailing line dropped. */
function manifestLines(repoDir: string): string[] {
	return fs
		.readFileSync(manifestFile(repoDir), 'utf8')
		.split('\n')
		.filter((line) => line.length > 0);
}

/** Data rows only, split into their tab-separated fields. */
function manifestRows(repoDir: string): string[][] {
	return manifestLines(repoDir)
		.slice(1)
		.map((line) => line.split('\t'));
}

function checkpoint(
	repoDir: string,
	base: string,
	paths: string[],
	reason?: string,
) {
	return run(repoDir, [
		'checkpoint',
		'--slug',
		'issue-1',
		...(reason ? ['--reason', reason] : []),
		'--id',
		'C1',
		'--argv',
		'bash check-a.sh',
		'--expect',
		'-',
		'--base',
		base,
		...paths,
	]);
}

/** Replace a frozen check with one that can no longer fail - the weakening. */
function weaken(repoDir: string, name: string) {
	fs.writeFileSync(path.join(repoDir, name), '#!/usr/bin/env bash\nexit 0\n');
}

/**
 * True only when a usable GNU `timeout` is on the PATH the script actually
 * sees. Presence is not enough: on Windows a bare `timeout` can resolve to
 * System32's unrelated timeout.exe, so the probe demands the GNU exit code 124.
 */
function detectGnuTimeout(): boolean {
	const probeRoot = canonicalMkdtemp('repro-timeout-probe-');
	try {
		const probe = path.join(probeRoot, 'probe.sh');
		fs.writeFileSync(
			probe,
			'#!/usr/bin/env bash\ncommand -v timeout >/dev/null 2>&1 || exit 3\ntimeout --foreground -k 1 1s sleep 5\n',
		);
		const proc = Bun.spawnSync({
			cmd: bashCommand(probe),
			cwd: probeRoot,
			env: process.env,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 20_000,
		});
		return proc.exitCode === 124;
	} catch {
		return false;
	} finally {
		fs.rmSync(probeRoot, { recursive: true, force: true });
	}
}

const HAS_GNU_TIMEOUT = detectGnuTimeout();

describe('repro-check.sh checkpoint manifest integrity', () => {
	test('ATTACK B: a frozen path cannot be silently re-baselined by a second plain checkpoint', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, ['check-a.sh']).code).toBe(0);
		const frozen = manifestLines(worktree);
		expect(frozen).toHaveLength(2);

		weaken(worktree, 'check-a.sh');
		let verify = run(worktree, ['verify-checkpoint', '--slug', 'issue-1']);
		expect(verify.code).toBe(1);
		expect(verify.out).toContain('CHANGED check-a.sh');

		const rebaseline = checkpoint(worktree, base, ['check-a.sh']);
		expect(rebaseline.code).toBe(2);
		expect(rebaseline.err).toContain('already frozen');
		// Nothing was appended: the manifest is byte-for-byte what it was.
		expect(manifestLines(worktree)).toEqual(frozen);

		// And the weakening is still visible, instead of having gone green.
		verify = run(worktree, ['verify-checkpoint', '--slug', 'issue-1']);
		expect(verify.code).toBe(1);
		expect(verify.out).toContain('CHANGED check-a.sh');
	}, 30_000);

	test('a recorded AMEND still supersedes a frozen path and turns verify green', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, ['check-a.sh']).code).toBe(0);

		weaken(worktree, 'check-a.sh');
		expect(run(worktree, ['verify-checkpoint', '--slug', 'issue-1']).code).toBe(
			1,
		);

		const amend = checkpoint(worktree, base, ['check-a.sh'], 'CHECK_WRONG');
		expect(amend.code).toBe(0);
		expect(amend.out).toContain('checkpoint: AMEND check-a.sh');

		const rows = manifestRows(worktree);
		expect(rows).toHaveLength(2);
		expect(rows[1][0]).toBe('2');
		expect(rows[1][1]).toBe('AMEND');
		expect(rows[1][2]).toBe('check-a.sh');
		expect(rows[1]).toHaveLength(10);
		expect(rows[1][9]).toBe('CHECK_WRONG');

		const verify = run(worktree, ['verify-checkpoint', '--slug', 'issue-1']);
		expect(verify.code).toBe(0);
		expect(verify.out).toContain('OK check-a.sh');
	}, 30_000);

	test('refuses a path repeated inside a single checkpoint invocation', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		const result = checkpoint(worktree, base, ['check-a.sh', 'check-a.sh']);
		expect(result.code).toBe(2);
		expect(result.err).toContain('already frozen');
		// The first append stands and nothing was added for the repeat, so the
		// seq column is still contiguous.
		expect(manifestRows(worktree)).toHaveLength(1);
	}, 30_000);

	test('ATTACK A: a deleted middle row fails the seq check instead of dropping that check', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, CHECK_FILES).code).toBe(0);
		expect(manifestRows(worktree)).toHaveLength(3);
		// Every frozen blob still matches the tree, so verify is unambiguously
		// green here; any later non-zero exit can only come from the seq check.
		expect(run(worktree, ['verify-checkpoint', '--slug', 'issue-1']).code).toBe(
			0,
		);

		const lines = manifestLines(worktree);
		expect(lines[2].startsWith('2\t')).toBe(true);
		fs.writeFileSync(
			manifestFile(worktree),
			`${[lines[0], lines[1], lines[3]].join('\n')}\n`,
		);

		const verify = run(worktree, ['verify-checkpoint', '--slug', 'issue-1']);
		expect(verify.code).toBe(2);
		expect(verify.err).toContain('seq is not contiguous');
		// It refused outright rather than replaying the surviving subset.
		expect(verify.out).not.toContain('OK check-a.sh');

		// `checkpoint` shares the validator, so it refuses the same file.
		const amend = checkpoint(worktree, base, ['check-a.sh'], 'FORMAT_ONLY');
		expect(amend.code).toBe(2);
		expect(amend.err).toContain('seq is not contiguous');
	}, 30_000);

	test('ATTACK C: truncating the TAIL fails the recorded row count, not just the middle', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, CHECK_FILES).code).toBe(0);
		const lines = manifestLines(worktree);
		expect(lines[0]).toBe('# issue-tracer checkpoint manifest v1 rows=3');
		expect(run(worktree, ['verify-checkpoint', '--slug', 'issue-1']).code).toBe(
			0,
		);

		// Drop the LAST row only. seq still runs 1..2 over the survivors and every
		// surviving row still has 10 fields, so seq contiguity alone - a PREFIX
		// invariant - accepts this file. Only the recorded count catches it.
		fs.writeFileSync(
			manifestFile(worktree),
			`${lines.slice(0, 3).join('\n')}\n`,
		);

		const verify = run(worktree, ['verify-checkpoint', '--slug', 'issue-1']);
		expect(verify.code).toBe(2);
		expect(verify.err).toContain('header records 3 rows, found 2');
		// It refused outright rather than replaying the surviving subset.
		expect(verify.out).not.toContain('OK check-a.sh');
	}, 30_000);

	test('ATTACK C: a tail truncation cannot un-freeze the truncated-away path', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, CHECK_FILES).code).toBe(0);
		const lines = manifestLines(worktree);

		// check-c.sh was row 3. Truncate it away, then weaken it: without the
		// recorded count, `manifest_has_path` would no longer see check-c.sh, the
		// plain `checkpoint` below would succeed, and verify would go green on the
		// weakened file - ATTACK B re-opened through the anti-re-freeze guard.
		fs.writeFileSync(
			manifestFile(worktree),
			`${lines.slice(0, 3).join('\n')}\n`,
		);
		weaken(worktree, 'check-c.sh');

		const refreeze = checkpoint(worktree, base, ['check-c.sh']);
		expect(refreeze.code).toBe(2);
		expect(refreeze.err).toContain('header records 3 rows, found 2');
		// Nothing was appended, so the re-baseline never happened.
		expect(manifestRows(worktree)).toHaveLength(2);
		expect(run(worktree, ['verify-checkpoint', '--slug', 'issue-1']).code).toBe(
			2,
		);
	}, 30_000);

	test('refuses a header whose recorded count disagrees with the rows present', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, ['check-a.sh']).code).toBe(0);
		const lines = manifestLines(worktree);
		expect(lines[0]).toBe('# issue-tracer checkpoint manifest v1 rows=1');

		// Only the header changes; the single data row is untouched and valid.
		fs.writeFileSync(
			manifestFile(worktree),
			`# issue-tracer checkpoint manifest v1 rows=4\n${lines[1]}\n`,
		);

		const verify = run(worktree, ['verify-checkpoint', '--slug', 'issue-1']);
		expect(verify.code).toBe(2);
		expect(verify.err).toContain('header records 4 rows, found 1');

		const frozen = checkpoint(worktree, base, ['check-b.sh']);
		expect(frozen.code).toBe(2);
		expect(frozen.err).toContain('header records 4 rows, found 1');
	}, 30_000);

	test('refuses a legacy header with no count instead of letting it disable the check', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, CHECK_FILES).code).toBe(0);
		const lines = manifestLines(worktree);

		// The bypass that accepting a legacy header would hand an attacker: write
		// a header with no count, then truncate freely.
		fs.writeFileSync(
			manifestFile(worktree),
			`# issue-tracer checkpoint manifest v1\n${lines[1]}\n`,
		);

		const verify = run(worktree, ['verify-checkpoint', '--slug', 'issue-1']);
		expect(verify.code).toBe(2);
		expect(verify.err).toContain('invalid manifest header');
		expect(verify.out).not.toContain('OK check-a.sh');
	}, 30_000);

	test('refuses a forged CHECKPOINT row that re-freezes an already-recorded path', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, ['check-a.sh']).code).toBe(0);

		// do_checkpoint refuses a duplicate CHECKPOINT at write time, but a row
		// appended by hand bypasses that. Without the supersede rule do_verify is
		// last-writer-wins per path, so this forged row would re-baseline the
		// frozen blob to a weakened file and verify would go green.
		const weakened = path.join(worktree, 'check-a.sh');
		fs.writeFileSync(weakened, '#!/bin/sh\nexit 0\n');
		const blob = git(worktree, 'hash-object', weakened);
		const file = manifestFile(worktree);
		fs.appendFileSync(
			file,
			`2\tCHECKPOINT\tcheck-a.sh\t${blob}\t100644\tC1\tq\tx\t${base}\t-\n`,
		);
		fs.writeFileSync(
			file,
			fs.readFileSync(file, 'utf8').replace('rows=1', 'rows=2'),
		);

		const verify = run(worktree, ['verify-checkpoint', '--slug', 'issue-1']);
		expect(verify.code).toBe(2);
		expect(verify.err).toContain('without an AMEND reason');
		expect(verify.out).not.toContain('OK check-a.sh');
	}, 30_000);

	test('refuses a zero-byte manifest instead of treating it as empty-but-valid', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, ['check-a.sh']).code).toBe(0);

		// A zero-byte file still satisfies `[ -f ]`, so both commands must reject
		// it on the missing header rather than reading it as a manifest with no
		// rows (which would silently drop every frozen check from the replay).
		fs.writeFileSync(manifestFile(worktree), '');

		const verify = run(worktree, ['verify-checkpoint', '--slug', 'issue-1']);
		expect(verify.code).toBe(2);
		expect(verify.out).not.toContain('OK check-a.sh');

		const frozen = checkpoint(worktree, base, ['check-b.sh']);
		expect(frozen.code).toBe(2);
	}, 30_000);

	test('refuses a data row that does not carry exactly ten fields', () => {
		const worktree = repo();
		const base = git(worktree, 'rev-parse', 'HEAD');
		expect(checkpoint(worktree, base, ['check-a.sh']).code).toBe(0);
		fs.appendFileSync(
			manifestFile(worktree),
			'2\tCHECKPOINT\tcheck-b.sh\tdeadbeef\n',
		);

		const verify = run(worktree, ['verify-checkpoint', '--slug', 'issue-1']);
		expect(verify.code).toBe(2);
		expect(verify.err).toContain('10 tab-separated fields');

		const frozen = checkpoint(worktree, base, ['check-c.sh']);
		expect(frozen.code).toBe(2);
		expect(frozen.err).toContain('10 tab-separated fields');
	}, 30_000);
});

describe('repro-check.sh GNU timeout watchdog', () => {
	// Skipped rather than silently degraded on hosts with no GNU timeout (stock
	// macOS ships gtimeout, not timeout): there the script takes the POSIX
	// fallback, which the sibling watchdog test already covers.
	test.skipIf(!HAS_GNU_TIMEOUT)(
		'primary timeout branch kills a hung check well inside the harness deadline',
		() => {
			const worktree = repo();
			const base = git(worktree, 'rev-parse', 'HEAD');
			// The child would run for 600s. The spawn deadline below is the
			// wall-clock bound: if the kill path did not fire, spawnSync would
			// terminate the script and `code` would be null, not 6.
			const result = run(
				worktree,
				[
					'run',
					'--base',
					base,
					'--class',
					'PRESERVING',
					'--id',
					'C1',
					'--slug',
					'issue-1',
					'--deps',
					'none',
					'--timeout',
					'3',
					'--',
					'bash',
					'-c',
					'sleep 600',
				],
				45_000,
			);
			expect(result.code).toBe(6);
			expect(result.out).toContain('result=TIMEOUT');
			expect(result.out).toContain('verdict: FAIL');
		},
		60_000,
	);
});
