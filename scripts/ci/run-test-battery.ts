#!/usr/bin/env bun
/**
 * run-test-battery.ts — fail-closed multi-file test battery runner (#3605 AC1/AC6).
 *
 * The masking vector this closes: a hand-authored `bun test <wrong-path>
 * <real-path>` batch exits 0 and silently omits the unmatched path (bun drops
 * non-matching positional paths in batch mode with no diagnostic), so a pin
 * battery can record a vacuous pass. The repo runner
 * (scripts/ci/run-unit-tests-local.ts) already fails closed on nonexistent
 * named paths, but nothing covered the batch form; this wrapper is that
 * admission + accounting layer.
 *
 * Contract (frozen by the 3605-3601-battery-proof-gates acceptance checks):
 * - Admission: every positional argument must resolve to an EXISTING regular
 *   TEST file (.test./.spec. suffix) inside the repository root, either
 *   repo-relative or absolute. Nonexistent paths, directories, non-test
 *   files, out-of-root paths, and git-ignored files (their content would not
 *   be tree-bound) are refused before any execution with a `BATTERY-REFUSED:`
 *   diagnostic naming the arg (all offending args listed; exit 1).
 * - Empty discovery (zero positional args) is a usage error: exit 1 with
 *   `BATTERY-REFUSED: no test files discovered`.
 * - Execution: each file runs individually through `validateRepository` (the
 *   same authority the CI unit job uses — timeouts, bounded output, terminal
 *   statuses). The CALLER bounds the file count; each file gets the shared
 *   per-file suite budget. A file whose run reports ZERO executed tests
 *   counts as FAILED (a vacuous pass is the masking class this wrapper
 *   exists to close).
 * - Accounting: `executed` is derived from the per-file validation results
 *   (a file that produced no result entry was not executed), so the
 *   discovered == executed assertion is load-bearing, not tautological.
 * - Terminal status: nonzero when ANY file failed, printing
 *   `BATTERY pass=N fail=M` and the FAILED file list; zero (with the summary)
 *   when all pass.
 * - Tree receipt (#3605 AC7): HEAD and the dirty digest are snapshotted
 *   BEFORE the run and re-verified AFTER it; a tree that changed mid-run
 *   refuses the receipt (the recorded binding would not describe the tree
 *   the tests actually ran on). The receipt is a tree-binding freshness
 *   token — it is NOT proof the tests passed; read the battery's own
 *   pass/fail summary. Default: .swarm/evidence/battery/battery-tree-receipt.json
 *   (override: --receipt-out <path>; an explicit target inside the repo must
 *   be git-ignored or it self-poisons the digest).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveGitExecutable } from '../../src/utils/git-executable.js';
import {
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_PER_ITEM_TIMEOUT_MS,
	DEFAULT_SUITE_TIMEOUT_MS,
	DEFAULT_TEST_TIMEOUT_MS,
	exitCodeForValidationStatus,
	validateRepository,
	type ValidationReport,
} from './repository-validation';

/** Pure seam (unit-tested directly): discovered must equal executed. */
export function assertBatteryAccounting(discovered: readonly string[], executed: readonly string[]): void {
	if (discovered.length !== executed.length) {
		throw new Error(
			`BATTERY-REFUSED: executed count disagrees with discovered count (discovered=${discovered.length} executed=${executed.length})`,
		);
	}
	for (const file of discovered) {
		if (!executed.includes(file)) {
			throw new Error(`BATTERY-REFUSED: executed set is missing discovered file: ${file}`);
		}
	}
}

const TEST_FILE_SUFFIX = /\.(test|spec)\.[cm]?[jt]sx?$/;

function resolveCandidate(root: string, arg: string): string {
	const abs = path.isAbsolute(arg) ? path.normalize(arg) : path.resolve(root, arg);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(abs);
	} catch {
		throw new Error(`BATTERY-REFUSED: no test file matched requested path: ${arg}`);
	}
	if (!stat.isFile()) {
		throw new Error(`BATTERY-REFUSED: no test file matched requested path: ${arg} (not a regular file)`);
	}
	const rel = path.relative(root, abs).split(path.sep).join('/');
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		throw new Error(
			`BATTERY-REFUSED: requested test file is outside the repository root, so its content cannot be tree-bound: ${arg}`,
		);
	}
	if (!TEST_FILE_SUFFIX.test(rel)) {
		throw new Error(
			`BATTERY-REFUSED: requested path is not a test file (.test./.spec. suffix required): ${arg}`,
		);
	}
	// A git-ignored test file's content never enters the dirty digest (tracked
	// diffs exclude it; untracked listing excludes it), so the receipt would
	// not bind its bytes. check-ignore exits 1 for a non-ignored path, and
	// execFileSync throws on that exit — treat a throw as "not ignored".
	let ignored = false;
	try {
		execFileSync(resolveGitExecutable(), ['-C', root, 'check-ignore', '-q', rel], {
			timeout: 15_000,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		ignored = true;
	} catch {
		ignored = false;
	}
	if (ignored) {
		throw new Error(
			`BATTERY-REFUSED: requested test file is git-ignored, so its content is not bound by the tree digest: ${arg}`,
		);
	}
	return abs;
}

/**
 * Canonical dirty-state binding (#3605 AC7), CONTENT-COVERING: porcelain
 * status lists paths and status codes only, so an edit to an already-modified
 * file would not move the digest — the exact vacuous-proof class this PR
 * closes. The digest instead covers bytes: `git diff HEAD --binary` (tracked
 * content changes) plus, for each untracked non-ignored file (sorted, C
 * locale), the path and its `git hash-object` blob id. A clean tree (no diff,
 * no untracked files) records "" (the producer form); the checker recomputes
 * identically and compares. The byte layout is mirrored exactly in
 * scripts/ci/check-battery-tree-receipt.sh — change both together.
 */
function computeDirtyDigest(root: string, git: string): string {
	try {
		const diff = execFileSync(git, ['-C', root, 'diff', 'HEAD', '--binary'], {
			timeout: 30_000,
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 64 * 1024 * 1024,
		});
		const untracked = execFileSync(git, ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], {
			timeout: 15_000,
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 64 * 1024 * 1024,
		});
		const paths = untracked.length === 0 ? [] : untracked.toString('utf8').split('\0').filter(Boolean).sort();
		if (diff.length === 0 && paths.length === 0) return '';
		const hash = createHash('sha1');
		hash.update(diff);
		hash.update('\0');
		for (const rel of paths) {
			const blob = execFileSync(git, ['-C', root, 'hash-object', '--', rel], {
				timeout: 15_000,
				stdio: ['ignore', 'pipe', 'ignore'],
			})
				.toString('utf8')
				.trim();
			hash.update(`${rel}\n${blob}\n`);
		}
		return hash.digest('hex');
	} catch {
		// Git unavailable or failing: bind to a marker rather than guessing.
		return 'git-unavailable';
	}
}

function currentHead(root: string, git: string): string {
	try {
		return execFileSync(git, ['-C', root, 'rev-parse', 'HEAD'], {
			encoding: 'utf8',
			timeout: 15_000,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return 'unknown'; // the tree-receipt checker refuses this as a mismatch
	}
}

interface TreeBinding {
	head: string;
	dirty: string;
}

function snapshotTreeBinding(root: string, git: string): TreeBinding {
	return { head: currentHead(root, git), dirty: computeDirtyDigest(root, git) };
}

function assertUnchangedBinding(root: string, git: string, before: TreeBinding): void {
	const after = snapshotTreeBinding(root, git);
	if (after.head !== before.head || after.dirty !== before.dirty) {
		console.error(
			`BATTERY-REFUSED: the repository tree changed during the battery run (head ${before.head} -> ${after.head}, dirty ${before.dirty || '""'} -> ${after.dirty || '""'}); refusing to write a receipt that would not describe the tree the tests ran on`,
		);
		process.exit(1);
	}
}

interface BatteryReceipt {
	head: string;
	dirty: string;
	files: string[];
}

function writeReceipt(root: string, files: readonly string[], receiptOut: string | null, git: string): string {
	const receipt: BatteryReceipt = {
		head: currentHead(root, git),
		dirty: computeDirtyDigest(root, git),
		files: files.map((abs) => path.relative(root, abs).split(path.sep).join('/')).sort(),
	};
	const target = receiptOut ?? path.join(root, '.swarm', 'evidence', 'battery', 'battery-tree-receipt.json');
	fs.mkdirSync(path.dirname(target), { recursive: true });
	// Atomic write (tmp + rename): a concurrent or interrupted run never
	// exposes a partial receipt to the checker.
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
	fs.renameSync(tmp, target);
	return target;
}

function reportFailureDetail(report: ValidationReport): string {
	return report.results
		.flatMap((result) => [result.stdout ?? '', result.stderr ?? '', result.reason ?? ''])
		.filter(Boolean)
		.join('\n');
}

function resultReportedZeroTests(report: ValidationReport): boolean {
	// bun test writes its pass/fail summary (including "Ran 0 tests") to
	// STDERR, not stdout — scan both streams (probed on bun 1.3.14). A
	// skip-only file reports "Ran 1 test" with "0 pass" — a skipped test did
	// not EXECUTE, so the vacuous-pass detector also requires a nonzero pass
	// count (probed: skip-only prints " 0 pass" on the summary).
	const output = report.results
		.map((result) => `${result.stdout ?? ''}\n${result.stderr ?? ''}`)
		.join('\n');
	if (/Ran 0 tests/.test(output)) return true;
	return /(?:^|\n)\s*0 pass\b/.test(output);
}

/**
 * A stale receipt from an earlier passing run must not survive a later
 * failed/refused run on the same tree: remove a target that parses as a
 * receipt (any file carrying a "head" binding) up front. A target that exists
 * but is NOT receipt-shaped is refused instead of deleted — deleting it would
 * destroy unrelated user data (--receipt-out mywork.test.ts).
 */
function cleanStaleReceipt(target: string): void {
	if (!fs.existsSync(target)) return;
	const head = fs.readFileSync(target, 'utf8').slice(0, 4096);
	if (!head.includes('"head"')) {
		console.error(
			`BATTERY-REFUSED: receipt target exists and is not a battery receipt (refusing to overwrite unrelated data): ${target}`,
		);
		process.exit(1);
	}
	fs.rmSync(target, { force: true });
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	let receiptOut: string | null = null;
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--receipt-out') {
			receiptOut = argv[i + 1];
			if (!receiptOut) {
				console.error('usage: run-test-battery.ts [--receipt-out <path>] <test-file>...');
				process.exit(1);
			}
			i++;
			continue;
		}
		positional.push(argv[i]);
	}

	const root = process.cwd();
	const git = resolveGitExecutable();
	const defaultReceipt = path.join(root, '.swarm', 'evidence', 'battery', 'battery-tree-receipt.json');

	// Stale-receipt cleanup runs AFTER all read-only admission validation
	// (empty discovery, path admission, receipt-target ignore status): a
	// REFUSED run must never delete the default receipt (or any target) — a
	// refused invocation changes nothing on disk. The non-receipt guard still
	// refuses instead of deleting a target that is not a battery receipt.
	// The cleanStaleReceipt call site is at the end of main(), immediately
	// before the run starts mutating state; an explicit-target run leaves the
	// default alone — the checker re-validates any receipt it is handed, so a
	// stale default never certifies a later tree.

	// An explicit --receipt-out INSIDE the repository must be git-ignored, or
	// the receipt file itself becomes untracked content and self-poisons the
	// dirty digest the checker recomputes.
	if (receiptOut) {
		const absOut = path.isAbsolute(receiptOut) ? path.normalize(receiptOut) : path.resolve(root, receiptOut);
		const relOut = path.relative(root, absOut).split(path.sep).join('/');
		if (!relOut.startsWith('..') && !path.isAbsolute(relOut)) {
			let ignoredOut = false;
			try {
				execFileSync(git, ['-C', root, 'check-ignore', '-q', relOut], {
					timeout: 15_000,
					stdio: ['ignore', 'pipe', 'ignore'],
				});
				ignoredOut = true;
			} catch {
				ignoredOut = false;
			}
			if (!ignoredOut) {
				console.error(
					`BATTERY-REFUSED: --receipt-out target is inside the repository but not git-ignored, so the receipt file would self-poison the tree digest: ${receiptOut}`,
				);
				process.exit(1);
			}
		}
	}

	if (positional.length === 0) {
		console.error('BATTERY-REFUSED: no test files discovered (pass test file paths as arguments)');
		process.exit(1);
	}

	const discovered: string[] = [];
	const refusals: string[] = [];
	for (const arg of positional) {
		try {
			discovered.push(resolveCandidate(root, arg));
		} catch (err) {
			refusals.push(err instanceof Error ? err.message : String(err));
		}
	}
	if (refusals.length > 0) {
		for (const line of refusals) console.error(line);
		console.error(
			`BATTERY-REFUSED: refusing to run: ${refusals.length} of ${positional.length} requested path(s) matched no test file`,
		);
		process.exit(1);
	}

	// Stale-receipt cleanup happens HERE — after every REFUSAL arm has passed
	// (admission, receipt-target ignore status, and the unreadable-git check
	// below), immediately before the run starts mutating state: a refused run
	// must never delete a receipt the invocation would have kept honest anyway
	// (the checker re-validates whatever it is handed). The target is always
	// git-ignored or outside the repo by the admission rules, so deleting a
	// stale receipt cannot move the dirty digest the binding snapshot records.

	// F-01: bind the receipt to the tree the tests RAN on — snapshot before,
	// re-verify after, refuse a mid-run tree change.
	const before = snapshotTreeBinding(root, git);
	// Fail closed on an unreadable git state BEFORE running anything: a
	// 'git-unavailable' binding could never be re-verified by the checker, so
	// the battery must not spend a full run producing an unverifiable receipt.
	if (before.dirty === 'git-unavailable' || before.head === 'unknown') {
		console.error(
			'BATTERY-REFUSED: the git state is unreadable (head/dirty binding unavailable), so the tree receipt could never be re-verified; refusing to run',
		);
		process.exit(1);
	}

	cleanStaleReceipt(receiptOut ?? defaultReceipt);

	const executed: string[] = [];
	let failed = 0;
	const failedFiles: string[] = [];
	for (const abs of discovered) {
		const rel = path.relative(root, abs).split(path.sep).join('/');
		const report = await validateRepository({
			root,
			mode: 'full',
			surfaces: ['unit'],
			testFiles: [abs],
			testTimeoutMs: DEFAULT_TEST_TIMEOUT_MS,
			perItemTimeoutMs: DEFAULT_PER_ITEM_TIMEOUT_MS,
			suiteTimeoutMs: DEFAULT_SUITE_TIMEOUT_MS,
			maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
		});
		if (report.results.length > 0) executed.push(abs);
		if (exitCodeForValidationStatus(report.status) !== 0) {
			failed++;
			failedFiles.push(rel);
			console.error(`FAILED: ${rel}`);
			const detail = reportFailureDetail(report);
			if (detail) console.error(detail);
		} else if (resultReportedZeroTests(report)) {
			// A vacuous pass is the masking class this wrapper exists to close.
			failed++;
			failedFiles.push(rel);
			console.error(`FAILED: ${rel} (reported zero executed tests)`);
		}
	}

	assertBatteryAccounting(discovered, executed);

	console.log(`BATTERY pass=${discovered.length - failed} fail=${failed}`);
	if (failed > 0) {
		console.error(`FAILED files: ${failedFiles.join(', ')}`);
		process.exit(1);
	}
	assertUnchangedBinding(root, git, before);
	// The tree receipt binds a PASSING battery to the tree it ran on; a failed
	// run must not leave a receipt a readiness check could mistake for one.
	const receiptPath = writeReceipt(root, discovered, receiptOut, git);
	console.log(`battery-tree-receipt: ${receiptPath}`);
}

if (import.meta.main) {
	await main();
}
