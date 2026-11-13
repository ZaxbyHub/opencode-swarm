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
 *   file, either repo-relative or absolute. Nonexistent paths, directories,
 *   and literal glob strings that match nothing are refused before any
 *   execution with `BATTERY-REFUSED: no test file matched requested path:
 *   <arg>` (all offending args listed; exit 1).
 * - Empty discovery (zero positional args) is a usage error: exit 1 with
 *   `BATTERY-REFUSED: no test files discovered`.
 * - Execution: each file runs individually through `validateRepository` (the
 *   same authority the CI unit job uses — timeouts, bounded output, terminal
 *   statuses). The CALLER bounds the file count; each file gets the shared
 *   per-file suite budget.
 * - Accounting: executed count must equal discovered count (asserted; a
 *   disagreement throws and fails the battery nonzero).
 * - Terminal status: nonzero when ANY file failed, printing
 *   `BATTERY pass=N fail=M` and the FAILED file list; zero (with the summary)
 *   when all pass.
 * - Tree receipt (#3605 AC7): writes a battery tree receipt (HEAD + dirty
 *   digest + named files) next to the run summary so a merge-queue-readiness
 *   check can refuse a battery whose recorded tree is not the tree it must
 *   validate. Default: .swarm/evidence/battery/battery-tree-receipt.json
 *   (override: --receipt-out <path>).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
function computeDirtyDigest(root: string): string {
	try {
		const diff = execFileSync('git', ['-C', root, 'diff', 'HEAD', '--binary'], {
			timeout: 30_000,
			stdio: ['ignore', 'pipe', 'ignore'],
			maxBuffer: 64 * 1024 * 1024,
		});
		const untracked = execFileSync(
			'git',
			['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'],
			{ timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] },
		);
		const paths = untracked.length === 0 ? [] : untracked.toString('utf8').split('\0').filter(Boolean).sort();
		if (diff.length === 0 && paths.length === 0) return '';
		const hash = createHash('sha1');
		hash.update(diff);
		hash.update('\0');
		for (const rel of paths) {
			const blob = execFileSync('git', ['-C', root, 'hash-object', '--', rel], {
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

function currentHead(root: string): string {
	try {
		return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
			encoding: 'utf8',
			timeout: 15_000,
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch {
		return 'unknown'; // the tree-receipt checker refuses this as a mismatch
	}
}

interface BatteryReceipt {
	head: string;
	dirty: string;
	files: string[];
}

function writeReceipt(root: string, files: readonly string[], receiptOut: string | null): string {
	const receipt: BatteryReceipt = {
		head: currentHead(root),
		dirty: computeDirtyDigest(root),
		files: files.map((abs) => path.relative(root, abs).split(path.sep).join('/')).sort(),
	};
	const target = receiptOut ?? path.join(root, '.swarm', 'evidence', 'battery', 'battery-tree-receipt.json');
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
	return target;
}

function reportFailureDetail(report: ValidationReport): string {
	return report.results
		.flatMap((result) => [result.stdout ?? '', result.stderr ?? '', result.reason ?? ''])
		.filter(Boolean)
		.join('\n');
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

	if (positional.length === 0) {
		console.error('BATTERY-REFUSED: no test files discovered (pass test file paths as arguments)');
		process.exit(1);
	}

	// A stale receipt from an earlier passing run must not survive a later
	// failed/refused run on the same tree: remove the default receipt up front
	// (success-only writes re-create it).
	const defaultReceipt = path.join(process.cwd(), '.swarm', 'evidence', 'battery', 'battery-tree-receipt.json');
	try {
		fs.rmSync(defaultReceipt, { force: true });
	} catch {
		/* best effort — a failure here surfaces as the checker's own mismatch */
	}

	const root = process.cwd();
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
		executed.push(abs);
		if (exitCodeForValidationStatus(report.status) !== 0) {
			failed++;
			failedFiles.push(rel);
			console.error(`FAILED: ${rel}`);
			const detail = reportFailureDetail(report);
			if (detail) console.error(detail);
		}
	}

	assertBatteryAccounting(discovered, executed);

	console.log(`BATTERY pass=${discovered.length - failed} fail=${failed}`);
	if (failed > 0) {
		console.error(`FAILED files: ${failedFiles.join(', ')}`);
		process.exit(1);
	}
	// The tree receipt binds a PASSING battery to the tree it ran on; a failed
	// run must not leave a receipt a readiness check could mistake for one.
	const receiptPath = writeReceipt(root, discovered, receiptOut);
	console.log(`battery-tree-receipt: ${receiptPath}`);
}

if (import.meta.main) {
	await main();
}
